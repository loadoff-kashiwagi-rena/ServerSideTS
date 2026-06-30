#!/usr/bin/env node
import * as fs from 'fs'
import * as path from 'path'
import * as cdk from 'aws-cdk-lib'
import { LambdaExpressApiStack } from '../lib/lambda-express-api-stack'
import { CloudFrontOacStack } from '../lib/cloudfront-oac-stack'

function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env')
    if (!fs.existsSync(envPath)) return
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        const value = trimmed.slice(eq + 1).trim()
        if (!(key in process.env)) process.env[key] = value
    }
}
loadEnv()

const app = new cdk.App()

new LambdaExpressApiStack(app, 'LambdaExpressApiStack', {
    // Secrets Manager の handson/db は ap-northeast-1 想定。account は
    // デプロイ時の認証情報（CDK_DEFAULT_ACCOUNT）から自動解決される。
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: 'ap-northeast-1',
    },
})

const oacBucket = process.env.OAC_VERIFY_BUCKET
if (oacBucket && !oacBucket.includes('xxxxx')) {
    new CloudFrontOacStack(app, 'CloudFrontOacStack', {
        env: {
            account: process.env.CDK_DEFAULT_ACCOUNT,
            region: 'ap-northeast-1',
        },
        bucketName: oacBucket,
    })
}