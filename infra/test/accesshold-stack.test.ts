import { App, assertions } from "aws-cdk-lib";
const { Match } = assertions;
import { describe, expect, it } from "vitest";
import { AccessHoldStack } from "../lib/accesshold-stack.js";

const createTemplate = () => {
  const app = new App();
  const stack = new AccessHoldStack(app, "AccessHoldTestStack", {
    env: { account: "111111111111", region: "eu-west-1" },
  });
  return assertions.Template.fromStack(stack);
};

describe("AccessHold CDK stack", () => {
  it("requires environment-specific certificate, domain, mail, image, and budget inputs", () => {
    const template = createTemplate();

    for (const parameter of [
      "AlbCertificateArn",
      "ApiDomainName",
      "CloudFrontCertificateArn",
      "WebDomainName",
      "ContainerImageTag",
      "SesIdentityName",
      "BudgetAlertEmail",
      "MonthlyBudgetUsd",
    ]) {
      template.hasParameter(parameter, {});
    }
  });

  it("keeps application S3 buckets private, encrypted, and access-logged", () => {
    const template = createTemplate();
    const buckets = Object.values(
      template.findResources("AWS::S3::Bucket"),
    ) as Array<{ Properties?: Record<string, unknown> }>;
    const loggedBuckets = buckets.filter(
      (bucket) => bucket.Properties?.LoggingConfiguration,
    );

    expect(buckets).toHaveLength(5);
    expect(loggedBuckets).toHaveLength(4);
    for (const bucket of buckets) {
      expect(bucket.Properties?.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
    for (const bucket of loggedBuckets) {
      expect(bucket.Properties?.LoggingConfiguration).toEqual(
        expect.objectContaining({
          DestinationBucketName: {
            Ref: expect.stringMatching(/^S3AccessLogsBucket/),
          },
        }),
      );
    }

    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: "aws:kms",
            },
          },
        ],
      },
    });
  });

  it("serves the web bucket through CloudFront OAC with a custom TLS certificate", () => {
    const template = createTemplate();

    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Aliases: [{ Ref: "WebDomainName" }],
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginAccessControlId: Match.anyValue(),
            S3OriginConfig: { OriginAccessIdentity: "" },
          }),
        ]),
        ViewerCertificate: {
          AcmCertificateArn: { Ref: "CloudFrontCertificateArn" },
          MinimumProtocolVersion: "TLSv1.2_2021",
          SslSupportMethod: "sni-only",
        },
      },
    });
  });

  it("proxies uncached API and MCP requests to the HTTPS API origin", () => {
    const template = createTemplate();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Origins: Match.arrayWith([
          Match.objectLike({
            DomainName: { Ref: "ApiDomainName" },
            CustomOriginConfig: {
              OriginProtocolPolicy: "https-only",
            },
          }),
        ]),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/api/v1/*",
            AllowedMethods: Match.arrayWith(["PATCH", "POST", "DELETE"]),
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          }),
          Match.objectLike({
            PathPattern: "/mcp*",
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          }),
        ]),
      },
    });
  });

  it("sets up Cognito authorization-code sign-in without a client secret", () => {
    const template = createTemplate();

    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AutoVerifiedAttributes: ["email"],
      MfaConfiguration: "OPTIONAL",
      Policies: {
        PasswordPolicy: {
          MinimumLength: 14,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        },
      },
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ["openid", "email", "profile"],
      EnableTokenRevocation: true,
      PreventUserExistenceErrors: "ENABLED",
    });
  });

  it("enables encrypted, point-in-time recoverable state and protected Aurora storage", () => {
    const template = createTemplate();

    template.resourceCountIs("AWS::DynamoDB::Table", 2);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "TravelerContractsIndex",
          KeySchema: Match.arrayWith([
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ]),
          Projection: { ProjectionType: "ALL" },
        }),
      ]),
    });
    const tables = Object.values(
      template.findResources("AWS::DynamoDB::Table"),
    ) as Array<{ Properties?: Record<string, unknown> }>;
    for (const table of tables) {
      expect(table.Properties).toEqual(
        expect.objectContaining({
          BillingMode: "PAY_PER_REQUEST",
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true,
          },
          SSESpecification: expect.objectContaining({
            SSEEnabled: true,
            SSEType: "KMS",
          }),
        }),
      );
    }

    template.hasResourceProperties("AWS::RDS::DBCluster", {
      Engine: "aurora-postgresql",
      StorageEncrypted: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 14,
    });
  });

  it("stores SES inbound mail under an explicit encrypted receipt rule", () => {
    const template = createTemplate();

    template.resourceCountIs("AWS::SES::EmailIdentity", 1);
    template.hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: {
        Enabled: true,
        ScanEnabled: true,
        TlsPolicy: "Require",
        Actions: [
          {
            S3Action: {
              ObjectKeyPrefix: "inbound/",
            },
          },
        ],
      },
    });
    template.hasResourceProperties("Custom::S3BucketNotifications", {
      NotificationConfiguration: {
        QueueConfigurations: Match.arrayWith([
          Match.objectLike({
            Events: ["s3:ObjectCreated:*"],
            Filter: {
              Key: {
                FilterRules: [{ Name: "prefix", Value: "inbound/" }],
              },
            },
            QueueArn: Match.anyValue(),
          }),
        ]),
      },
    });
  });

  it("uses the recommended TLS policy on the API listener", () => {
    const template = createTemplate();

    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
      SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
    });
  });
});
