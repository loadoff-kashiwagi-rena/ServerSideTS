import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as fs from 'fs'
import * as path from 'path'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'

export interface CloudFrontOacStackProps extends StackProps {
    bucketName: string
}

export class CloudFrontOacStack extends Stack {
    constructor(scope: Construct, id: string, props: CloudFrontOacStackProps) {
        super(scope, id, props)

        const bucket = new s3.Bucket(this, 'OacVerifyBucket', {
            bucketName: props.bucketName,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        })

        const origin = origins.S3BucketOrigin.withOriginAccessControl(bucket, {
            originAccessLevels: [
                cloudfront.AccessLevel.READ,
                cloudfront.AccessLevel.WRITE,
                cloudfront.AccessLevel.DELETE,
            ]
        })

        const publicKey = new cloudfront.PublicKey(this, 'OacVerifyKey', {
            encodedKey: fs.readFileSync(path.join(__dirname, '..', 'keys', 'cf_public_key.pem'), 'utf8'),
        })
        const keyGroup = new cloudfront.KeyGroup(this, 'OacVerifyKeyGroup', {
            items: [publicKey],
        })

        const dist = new cloudfront.Distribution(this, 'OacVerifyDistribution', {
            defaultBehavior: {
                origin,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                trustedKeyGroups: [keyGroup],
            },
        })

        new CfnOutput(this, 'DistributionDomainName', { value: dist.distributionDomainName })
        new CfnOutput(this, 'PublicKeyId', { value: publicKey.publicKeyId })
    }
}