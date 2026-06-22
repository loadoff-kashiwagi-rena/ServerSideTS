#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaExpressApiStack } from '../lib/lambda-express-api-stack';

const app = new cdk.App();

new LambdaExpressApiStack(app, 'LambdaExpressApiStack', {
  // Secrets Manager の handson/db は ap-northeast-1 想定。account は
  // デプロイ時の認証情報（CDK_DEFAULT_ACCOUNT）から自動解決される。
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'ap-northeast-1',
  },
});
