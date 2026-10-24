#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AccessHoldStack } from "../lib/accesshold-stack.js";

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const props = account && region ? { env: { account, region } } : {};
new AccessHoldStack(app, "AccessHoldStack", props);
