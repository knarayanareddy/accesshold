import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfrontOrigins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3Notifications from "aws-cdk-lib/aws-s3-notifications";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as stepfunctions from "aws-cdk-lib/aws-stepfunctions";
import * as stepfunctionTasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as budgets from "aws-cdk-lib/aws-budgets";

export interface AccessHoldStackProps extends StackProps {
  readonly monthlyBudgetUsd?: number;
}

/**
 * Production-oriented AWS resource graph. It is intentionally not deployed by
 * this repository task; app images, verified identities, DNS, and Cognito token
 * validation still require an environment-specific release pipeline.
 */
export class AccessHoldStack extends Stack {
  constructor(scope: Construct, id: string, props: AccessHoldStackProps = {}) {
    super(scope, id, props);

    const certificateArn = new CfnParameter(this, "AlbCertificateArn", {
      type: "String",
      description:
        "ACM certificate ARN in this stack's region for the HTTPS API/MCP endpoint.",
      minLength: 20,
    });
    const apiDomainName = new CfnParameter(this, "ApiDomainName", {
      type: "String",
      description:
        "DNS name covered by the ALB certificate and directed to the API load balancer.",
      minLength: 3,
    });
    const webCertificateArn = new CfnParameter(
      this,
      "CloudFrontCertificateArn",
      {
        type: "String",
        description:
          "ACM certificate ARN in us-east-1 for the CloudFront web domain.",
        minLength: 20,
      },
    );
    const webDomainName = new CfnParameter(this, "WebDomainName", {
      type: "String",
      description:
        "DNS name covered by the CloudFront certificate and routed to this distribution.",
      minLength: 3,
    });
    const containerImageTag = new CfnParameter(this, "ContainerImageTag", {
      type: "String",
      description:
        "Immutable Git commit SHA tag already pushed to the application ECR repository.",
      allowedPattern: "^[0-9a-f]{7,40}$",
    });
    const sesIdentityName = new CfnParameter(this, "SesIdentityName", {
      type: "String",
      description:
        "Verified SES domain or email identity used for inbound and outbound mail.",
      minLength: 3,
    });
    const budgetAlertEmail = new CfnParameter(this, "BudgetAlertEmail", {
      type: "String",
      description: "Address for monthly AWS budget notifications.",
      allowedPattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
    });
    const monthlyBudget = new CfnParameter(this, "MonthlyBudgetUsd", {
      type: "Number",
      default: props.monthlyBudgetUsd ?? 500,
      minValue: 1,
      description:
        "Monthly cost alert threshold in USD; set deliberately before deployment.",
    });

    const appKey = new kms.Key(this, "ApplicationDataKey", {
      alias: "accesshold/application-data",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      description:
        "Customer-managed encryption key for AccessHold application data.",
    });

    const vpc = new ec2.Vpc(this, "ApplicationVpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "compute",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "data",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        DynamoDB: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
    });

    const apiSecurityGroup = new ec2.SecurityGroup(this, "ApiSecurityGroup", {
      vpc,
      description:
        "Private ECS API/MCP service; traffic arrives only from the ALB.",
      allowAllOutbound: false,
    });
    const workerSecurityGroup = new ec2.SecurityGroup(
      this,
      "WorkerSecurityGroup",
      {
        vpc,
        description:
          "Private ECS worker service; outbound AWS/API traffic uses NAT and endpoints.",
        allowAllOutbound: false,
      },
    );
    const databaseSecurityGroup = new ec2.SecurityGroup(
      this,
      "DatabaseSecurityGroup",
      {
        vpc,
        description:
          "Aurora PostgreSQL accepts connections only from application task security groups.",
        allowAllOutbound: false,
      },
    );
    apiSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "TLS egress through the private-subnet NAT gateway; constrain destinations in the deployment network policy.",
    );
    workerSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "TLS egress through the private-subnet NAT gateway; constrain destinations in the deployment network policy.",
    );
    databaseSecurityGroup.addIngressRule(
      apiSecurityGroup,
      ec2.Port.tcp(5432),
      "API/MCP tasks to Aurora PostgreSQL.",
    );
    databaseSecurityGroup.addIngressRule(
      workerSecurityGroup,
      ec2.Port.tcp(5432),
      "Worker tasks to Aurora PostgreSQL.",
    );

    const inboundDeadLetterQueue = new sqs.Queue(
      this,
      "InboundMailDeadLetterQueue",
      {
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: appKey,
        retentionPeriod: Duration.days(14),
        enforceSSL: true,
      },
    );
    const inboundMailQueue = new sqs.Queue(this, "InboundMailQueue", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: appKey,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: { queue: inboundDeadLetterQueue, maxReceiveCount: 4 },
      enforceSSL: true,
    });
    const providerEventDeadLetterQueue = new sqs.Queue(
      this,
      "ProviderEventDeadLetterQueue",
      {
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: appKey,
        retentionPeriod: Duration.days(14),
        enforceSSL: true,
      },
    );
    const providerEventQueue = new sqs.Queue(this, "ProviderEventQueue", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: appKey,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: {
        queue: providerEventDeadLetterQueue,
        maxReceiveCount: 5,
      },
      enforceSSL: true,
    });
    const deletionDeadLetterQueue = new sqs.Queue(
      this,
      "DeletionDeadLetterQueue",
      {
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: appKey,
        retentionPeriod: Duration.days(14),
        enforceSSL: true,
      },
    );
    const deletionQueue = new sqs.Queue(this, "DeletionQueue", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: appKey,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(10),
      deadLetterQueue: { queue: deletionDeadLetterQueue, maxReceiveCount: 5 },
      enforceSSL: true,
    });
    const retentionQueue = new sqs.Queue(this, "RetentionSweepQueue", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: appKey,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(10),
      deadLetterQueue: { queue: deletionDeadLetterQueue, maxReceiveCount: 5 },
      enforceSSL: true,
    });

    const accessLogsBucket = new s3.Bucket(this, "S3AccessLogsBucket", {
      bucketName: `accesshold-s3-access-logs-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: Duration.days(365) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const importsBucket = new s3.Bucket(this, "ImportsBucket", {
      bucketName: `accesshold-imports-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      lifecycleRules: [
        {
          id: "raw-confirmation-default-retention",
          prefix: "inbound/",
          expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(7),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "imports/",
    });
    const evidenceBucket = new s3.Bucket(this, "EvidenceBucket", {
      bucketName: `accesshold-evidence-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "evidence/",
    });
    const exportsBucket = new s3.Bucket(this, "ExportsBucket", {
      bucketName: `accesshold-exports-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      versioned: true,
      lifecycleRules: [
        {
          id: "noncurrent-export-expiry",
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "exports/",
    });
    const webBucket = new s3.Bucket(this, "WebAssetsBucket", {
      bucketName: `accesshold-web-assets-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "web/",
    });
    importsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3Notifications.SqsDestination(inboundMailQueue),
      { prefix: "inbound/" },
    );

    const cluster = new rds.DatabaseCluster(this, "AccessHoldAurora", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      writer: rds.ClusterInstance.serverlessV2("writer"),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      defaultDatabaseName: "accesshold",
      credentials: rds.Credentials.fromGeneratedSecret("accesshold_admin", {
        secretName: "/accesshold/database/credentials",
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      storageEncrypted: true,
      storageEncryptionKey: appKey,
      backup: { retention: Duration.days(14) },
      deletionProtection: true,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    if (!cluster.secret) throw new Error("aurora_credentials_secret_missing");

    const workflowTable = new dynamodb.Table(this, "WorkflowStateTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: appKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    workflowTable.addGlobalSecondaryIndex({
      indexName: "TravelerContractsIndex",
      partitionKey: {
        name: "gsi1pk",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    const idempotencyTable = new dynamodb.Table(this, "IdempotencyTable", {
      partitionKey: {
        name: "idempotencyKey",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: appKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const providerSecret = new secretsmanager.Secret(
      this,
      "ProviderIntegrationSecret",
      {
        secretName: "/accesshold/provider-integrations",
        description:
          "Live provider credentials. Populate through the approved secret-management process; do not seed values here.",
        encryptionKey: appKey,
        removalPolicy: RemovalPolicy.RETAIN,
      },
    );

    const userPool = new cognito.UserPool(this, "TravelerUserPool", {
      userPoolName: "accesshold-travelers",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const userPoolDomain = new cognito.UserPoolDomain(
      this,
      "TravelerHostedUiDomain",
      {
        userPool,
        cognitoDomain: {
          domainPrefix: `accesshold-${this.account}`,
        },
      },
    );

    const webCertificate = acm.Certificate.fromCertificateArn(
      this,
      "WebTlsCertificate",
      webCertificateArn.valueAsString,
    );
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "WebSecurityHeaders",
      {
        responseHeadersPolicyName: "accesshold-security-headers",
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: Duration.seconds(31_536_000),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          xssProtection: { protection: true, modeBlock: true, override: true },
          contentSecurityPolicy: {
            contentSecurityPolicy:
              "default-src 'self'; connect-src 'self' https:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
            override: true,
          },
        },
      },
    );
    const spaRewrite = new cloudfront.Function(this, "WebSpaRewrite", {
      functionName: "accesshold-spa-route-rewrite",
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.uri === "/auth/callback" || !request.uri.includes(".")) {
    request.uri = "/index.html";
  }
  return request;
}
`),
    });

    const receiptIdentity = new ses.CfnEmailIdentity(this, "SesEmailIdentity", {
      emailIdentity: sesIdentityName.valueAsString,
    });
    const receiptRole = new iam.Role(this, "SesReceiptStorageRole", {
      assumedBy: new iam.ServicePrincipal("ses.amazonaws.com"),
      description:
        "Allows SES inbound receipt rules to write raw email to the encrypted imports bucket.",
    });
    receiptRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [importsBucket.arnForObjects("inbound/*")],
      }),
    );
    receiptRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetBucketLocation", "s3:ListBucket"],
        resources: [importsBucket.bucketArn],
      }),
    );
    const receiptRuleSet = new ses.CfnReceiptRuleSet(
      this,
      "InboundReceiptRuleSet",
      {
        ruleSetName: "accesshold-inbound",
      },
    );
    const receiptRule = new ses.CfnReceiptRule(
      this,
      "InboundConfirmationRule",
      {
        ruleSetName: receiptRuleSet.ref,
        rule: {
          name: "store-authorized-confirmations",
          enabled: true,
          scanEnabled: true,
          tlsPolicy: "Require",
          recipients: [sesIdentityName.valueAsString],
          actions: [
            {
              s3Action: {
                bucketName: importsBucket.bucketName,
                objectKeyPrefix: "inbound/",
                iamRoleArn: receiptRole.roleArn,
              },
            },
          ],
        },
      },
    );
    receiptRule.addResourceDependency(receiptRuleSet);
    importsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ArnPrincipal(receiptRole.roleArn)],
        actions: ["s3:PutObject"],
        resources: [importsBucket.arnForObjects("inbound/*")],
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    );

    const userPoolClient = new cognito.UserPoolClient(
      this,
      "TravelerWebClient",
      {
        userPool,
        userPoolClientName: "accesshold-web",
        generateSecret: false,
        authFlows: {
          userSrp: true,
          userPassword: false,
          custom: false,
          adminUserPassword: false,
        },
        preventUserExistenceErrors: true,
        accessTokenValidity: Duration.minutes(15),
        idTokenValidity: Duration.minutes(15),
        refreshTokenValidity: Duration.days(30),
        enableTokenRevocation: true,
        supportedIdentityProviders: [
          cognito.UserPoolClientIdentityProvider.COGNITO,
        ],
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [
            cognito.OAuthScope.OPENID,
            cognito.OAuthScope.EMAIL,
            cognito.OAuthScope.PROFILE,
          ],
          callbackUrls: [
            `https://${webDomainName.valueAsString}/auth/callback`,
          ],
          logoutUrls: [`https://${webDomainName.valueAsString}/`],
        },
      },
    );

    const repository = new ecr.Repository(this, "ApplicationImageRepository", {
      repositoryName: "accesshold/app",
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: appKey,
      lifecycleRules: [{ maxImageCount: 20 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const clusterEcs = new ecs.Cluster(this, "EcsCluster", {
      vpc,
      clusterName: "accesshold",
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const apiLogGroup = new logs.LogGroup(this, "ApiLogGroup", {
      logGroupName: "/accesshold/api",
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: appKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const workerLogGroup = new logs.LogGroup(this, "WorkerLogGroup", {
      logGroupName: "/accesshold/worker",
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: appKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const apiTask = new ecs.FargateTaskDefinition(this, "ApiTaskDefinition", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
    });
    const apiContainer = apiTask.addContainer("ApiAndMcp", {
      image: ecs.ContainerImage.fromEcrRepository(
        repository,
        containerImageTag.valueAsString,
      ),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: apiLogGroup,
        streamPrefix: "api",
      }),
      environment: {
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: "8080",
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_DOMAIN: userPoolDomain.domainName,
        DATABASE_HOST: cluster.clusterEndpoint.hostname,
        DATABASE_PORT: cluster.clusterEndpoint.port.toString(),
        DATABASE_NAME: "accesshold",
        CONTRACT_REPOSITORY_DRIVER: "postgres",
        IMPORTS_BUCKET: importsBucket.bucketName,
        EVIDENCE_BUCKET: evidenceBucket.bucketName,
        EXPORTS_BUCKET: exportsBucket.bucketName,
        INBOUND_MAIL_QUEUE_URL: inboundMailQueue.queueUrl,
        PROVIDER_EVENT_QUEUE_URL: providerEventQueue.queueUrl,
        DELETION_QUEUE_URL: deletionQueue.queueUrl,
        WORKFLOW_TABLE_NAME: workflowTable.tableName,
        IDEMPOTENCY_TABLE_NAME: idempotencyTable.tableName,
        AWS_REGION: this.region,
      },
      secrets: {
        DATABASE_CREDENTIALS: ecs.Secret.fromSecretsManager(cluster.secret),
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(45),
      },
    });
    apiContainer.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });
    const apiService = new ecs.FargateService(this, "ApiMcpService", {
      cluster: clusterEcs,
      taskDefinition: apiTask,
      serviceName: "accesshold-api-mcp",
      desiredCount: 2,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [apiSecurityGroup],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
    });
    apiService
      .autoScaleTaskCount({ minCapacity: 2, maxCapacity: 8 })
      .scaleOnCpuUtilization("ApiCpuScaling", {
        targetUtilizationPercent: 65,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(2),
      });

    const workerTask = new ecs.FargateTaskDefinition(
      this,
      "WorkerTaskDefinition",
      {
        cpu: 512,
        memoryLimitMiB: 1024,
        runtimePlatform: {
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
        },
      },
    );
    const workerContainer = workerTask.addContainer("WorkflowWorker", {
      image: ecs.ContainerImage.fromEcrRepository(
        repository,
        containerImageTag.valueAsString,
      ),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: workerLogGroup,
        streamPrefix: "worker",
      }),
      environment: {
        NODE_ENV: "production",
        WORKER_MODE: "queue-consumer",
        INBOUND_MAIL_QUEUE_URL: inboundMailQueue.queueUrl,
        PROVIDER_EVENT_QUEUE_URL: providerEventQueue.queueUrl,
        DELETION_QUEUE_URL: deletionQueue.queueUrl,
        RETENTION_QUEUE_URL: retentionQueue.queueUrl,
        IMPORTS_BUCKET: importsBucket.bucketName,
        EVIDENCE_BUCKET: evidenceBucket.bucketName,
        EXPORTS_BUCKET: exportsBucket.bucketName,
        WORKFLOW_TABLE_NAME: workflowTable.tableName,
        IDEMPOTENCY_TABLE_NAME: idempotencyTable.tableName,
        DATABASE_HOST: cluster.clusterEndpoint.hostname,
        DATABASE_PORT: cluster.clusterEndpoint.port.toString(),
        DATABASE_NAME: "accesshold",
        CONTRACT_REPOSITORY_DRIVER: "postgres",
        AWS_REGION: this.region,
      },
      secrets: {
        DATABASE_CREDENTIALS: ecs.Secret.fromSecretsManager(cluster.secret),
      },
    });
    workerContainer.addPortMappings({
      containerPort: 8081,
      protocol: ecs.Protocol.TCP,
    });
    const workerService = new ecs.FargateService(this, "WorkerService", {
      cluster: clusterEcs,
      taskDefinition: workerTask,
      serviceName: "accesshold-worker",
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [workerSecurityGroup],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
    });
    void workerService;

    importsBucket.grantReadWrite(apiTask.taskRole, "trips/*");
    importsBucket.grantReadWrite(workerTask.taskRole, "trips/*");
    importsBucket.grantRead(workerTask.taskRole, "inbound/*");
    evidenceBucket.grantReadWrite(apiTask.taskRole, "trips/*");
    evidenceBucket.grantReadWrite(workerTask.taskRole, "trips/*");
    exportsBucket.grantReadWrite(apiTask.taskRole, "trips/*");
    exportsBucket.grantReadWrite(workerTask.taskRole, "trips/*");
    inboundMailQueue.grantConsumeMessages(workerTask.taskRole);
    providerEventQueue.grantConsumeMessages(workerTask.taskRole);
    deletionQueue.grantConsumeMessages(workerTask.taskRole);
    retentionQueue.grantConsumeMessages(workerTask.taskRole);
    providerEventQueue.grantSendMessages(apiTask.taskRole);
    deletionQueue.grantSendMessages(apiTask.taskRole);
    workflowTable.grantReadWriteData(apiTask.taskRole);
    workflowTable.grantReadWriteData(workerTask.taskRole);
    idempotencyTable.grantReadWriteData(apiTask.taskRole);
    idempotencyTable.grantReadWriteData(workerTask.taskRole);
    cluster.secret.grantRead(apiTask.taskRole);
    cluster.secret.grantRead(workerTask.taskRole);
    providerSecret.grantRead(apiTask.taskRole);
    providerSecret.grantRead(workerTask.taskRole);
    appKey.grantEncryptDecrypt(apiTask.taskRole);
    appKey.grantEncryptDecrypt(workerTask.taskRole);
    apiTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [
          `arn:${this.partition}:ses:${this.region}:${this.account}:identity/${sesIdentityName.valueAsString}`,
        ],
      }),
    );
    apiTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminInitiateAuth",
          "cognito-idp:GlobalSignOut",
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    const loadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      "ApiLoadBalancer",
      {
        vpc,
        internetFacing: true,
        loadBalancerName: "accesshold-api",
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroup: new ec2.SecurityGroup(this, "AlbSecurityGroup", {
          vpc,
          description: "Public HTTPS entry to the private API/MCP service.",
          allowAllOutbound: false,
        }),
        dropInvalidHeaderFields: true,
        deletionProtection: true,
      },
    );
    const albSecurityGroup = loadBalancer.connections.securityGroups[0];
    if (!albSecurityGroup) throw new Error("alb_security_group_missing");
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "HTTPS API/MCP traffic.",
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "HTTP redirects to HTTPS.",
    );
    albSecurityGroup.addEgressRule(
      apiSecurityGroup,
      ec2.Port.tcp(8080),
      "Forward to private API service.",
    );
    apiSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(8080),
      "Only the ALB may reach API containers.",
    );
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "ApiTlsCertificate",
      certificateArn.valueAsString,
    );
    const httpsListener = loadBalancer.addListener("HttpsListener", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [
        elbv2.ListenerCertificate.fromCertificateManager(certificate),
      ],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      open: false,
    });
    loadBalancer.addListener("HttpRedirectListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });
    httpsListener.addTargets("ApiMcpTargets", {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: {
        path: "/health",
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
      },
      deregistrationDelay: Duration.seconds(30),
    });

    const apiOrigin = new cloudfrontOrigins.HttpOrigin(
      apiDomainName.valueAsString,
      { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY },
    );
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: securityHeaders,
      compress: true,
    };
    const distribution = new cloudfront.Distribution(this, "WebDistribution", {
      comment:
        "AccessHold SPA and private API/MCP origins with security headers.",
      certificate: webCertificate,
      domainNames: [webDomainName.valueAsString],
      defaultRootObject: "index.html",
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin:
          cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: spaRewrite,
          },
        ],
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      },
      additionalBehaviors: {
        "/api/v1/*": apiBehavior,
        "/mcp*": apiBehavior,
      },
    });

    const deletionWorkflowTask = new stepfunctionTasks.SqsSendMessage(
      this,
      "QueueDeletionTask",
      {
        queue: deletionQueue,
        messageBody: stepfunctions.TaskInput.fromObject({
          job: "erase_trip_artifacts",
          task_id: stepfunctions.JsonPath.stringAt("$.task_id"),
          trip_id: stepfunctions.JsonPath.stringAt("$.trip_id"),
          requested_by: stepfunctions.JsonPath.stringAt("$.requested_by"),
          expected_contract_version: stepfunctions.JsonPath.numberAt(
            "$.expected_contract_version",
          ),
        }),
        messageGroupId: "deletion-workflow",
      },
    );
    const deletionWorkflow = new stepfunctions.StateMachine(
      this,
      "DeletionStateMachine",
      {
        stateMachineName: "accesshold-trip-deletion",
        stateMachineType: stepfunctions.StateMachineType.STANDARD,
        definitionBody: stepfunctions.DefinitionBody.fromChainable(
          deletionWorkflowTask.next(
            new stepfunctions.Succeed(this, "DeletionTaskQueued"),
          ),
        ),
        timeout: Duration.hours(6),
        tracingEnabled: true,
      },
    );
    const retentionSweepTask = new stepfunctionTasks.SqsSendMessage(
      this,
      "QueueRetentionSweep",
      {
        queue: retentionQueue,
        messageBody: stepfunctions.TaskInput.fromObject({
          job: "schedule_expired_contracts",
          scheduled_at: stepfunctions.JsonPath.executionStartTime,
        }),
      },
    );
    const retentionWorkflow = new stepfunctions.StateMachine(
      this,
      "RetentionStateMachine",
      {
        stateMachineName: "accesshold-retention-sweep",
        stateMachineType: stepfunctions.StateMachineType.STANDARD,
        definitionBody: stepfunctions.DefinitionBody.fromChainable(
          retentionSweepTask.next(
            new stepfunctions.Succeed(this, "RetentionSweepQueued"),
          ),
        ),
        timeout: Duration.hours(2),
        tracingEnabled: true,
      },
    );
    new events.Rule(this, "DailyRetentionSchedule", {
      ruleName: "accesshold-daily-retention-sweep",
      schedule: events.Schedule.cron({ minute: "0", hour: "3" }),
      targets: [new eventTargets.SfnStateMachine(retentionWorkflow)],
      description:
        "Enqueue an owner-aware 30-day retention policy sweep; the worker performs scoped deletion.",
    });

    const apiTarget5xxAlarm = new cloudwatch.Alarm(this, "ApiTarget5xxAlarm", {
      alarmName: "accesshold-alb-target-5xx",
      metric: loadBalancer.metrics.httpCodeTarget(
        elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
        { period: Duration.minutes(5), statistic: "sum" },
      ),
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Target 5xx responses; inspect redacted service logs and deployment status.",
    });
    const deletionDlqAlarm = new cloudwatch.Alarm(this, "DeletionDlqAlarm", {
      alarmName: "accesshold-deletion-dlq-visible",
      metric: deletionDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: "sum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Deletion work entered the DLQ and requires operator reconciliation.",
    });
    const dashboard = new cloudwatch.Dashboard(this, "OperationsDashboard", {
      dashboardName: "accesshold-operations",
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "API/MCP target health",
        left: [
          loadBalancer.metrics.httpCodeTarget(
            elbv2.HttpCodeTarget.TARGET_2XX_COUNT,
          ),
          loadBalancer.metrics.httpCodeTarget(
            elbv2.HttpCodeTarget.TARGET_4XX_COUNT,
          ),
          loadBalancer.metrics.httpCodeTarget(
            elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
          ),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Workflow queue depth",
        left: [
          inboundMailQueue.metricApproximateNumberOfMessagesVisible(),
          providerEventQueue.metricApproximateNumberOfMessagesVisible(),
          deletionQueue.metricApproximateNumberOfMessagesVisible(),
          retentionQueue.metricApproximateNumberOfMessagesVisible(),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "API task CPU",
        left: [apiService.metricCpuUtilization()],
        right: [apiService.metricMemoryUtilization()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Aurora CPU",
        left: [cluster.metricCPUUtilization()],
        width: 12,
      }),
    );
    void apiTarget5xxAlarm;
    void deletionDlqAlarm;
    void dashboard;

    new budgets.CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetName: "accesshold-monthly-spend-limit",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: monthlyBudget.valueAsNumber, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [
            {
              subscriptionType: "EMAIL",
              address: budgetAlertEmail.valueAsString,
            },
          ],
        },
      ],
    });

    new CfnOutput(this, "ApiBaseUrl", {
      value: `https://${apiDomainName.valueAsString}`,
      description:
        "HTTPS API and MCP Streamable HTTP endpoint; point the configured DNS name at the load balancer.",
    });
    new CfnOutput(this, "WebBaseUrl", {
      value: `https://${webDomainName.valueAsString}`,
      description: "Custom CloudFront domain for the responsive web assets.",
    });
    new CfnOutput(this, "CloudFrontDistributionDomainName", {
      value: distribution.distributionDomainName,
      description:
        "DNS target for the web-domain CNAME or equivalent alias record.",
    });
    new CfnOutput(this, "SesIdentityNameValue", {
      value: receiptIdentity.emailIdentityRef.emailIdentity,
      description: "SES identity name supplied to this stack.",
    });
    new CfnOutput(this, "CognitoUserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "CognitoUserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new CfnOutput(this, "DatabaseSecretArn", {
      value: cluster.secret.secretArn,
    });
    new CfnOutput(this, "WorkflowTableName", {
      value: workflowTable.tableName,
    });
    new CfnOutput(this, "IdempotencyTableName", {
      value: idempotencyTable.tableName,
    });
    new CfnOutput(this, "ImportsBucketName", {
      value: importsBucket.bucketName,
    });
    new CfnOutput(this, "EvidenceBucketName", {
      value: evidenceBucket.bucketName,
    });
    new CfnOutput(this, "ExportsBucketName", {
      value: exportsBucket.bucketName,
    });
    new CfnOutput(this, "ApplicationImageRepositoryUri", {
      value: repository.repositoryUri,
    });
    new CfnOutput(this, "DeletionWorkflowArn", {
      value: deletionWorkflow.stateMachineArn,
    });
    new CfnOutput(this, "RetentionWorkflowArn", {
      value: retentionWorkflow.stateMachineArn,
    });
  }
}
