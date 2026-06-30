import * as path from 'path'
import { execSync } from 'child_process'
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ec2 from 'aws-cdk-lib/aws-ec2'

// Express アプリ（serverless-http 済み）のディレクトリ。
// dist/index.handler が Lambda のエントリポイント。
const APP_DIR = path.join(__dirname, '..', '..', 'lambda-express-api')

// --- 既存（手動作成済み）のネットワーク資源 -------------------------------------
// VPC / サブネット / セキュリティグループ / RDS Proxy / Secret はハンズオンで
// マネジメントコンソール側に作成済み。CDK では「作る」のではなく既存IDを
// インポートして Lambda に付け替えるだけにする（新規作成すると Proxy SG の
// インバウンド許可が Lambda SG を名指ししているため接続が壊れる）。
const VPC_ID = 'vpc-0a06e9131f00316ec'
// Lambda を置くサブネット（プライベート2つに統一）。
//   subnet-004a44a992a6b4754 = ap-northeast-1a（プライベート / 0.0.0.0/0 → NAT）
//   subnet-0c6a14ba71f893b3c = ap-northeast-1c（プライベート / 0.0.0.0/0 → NAT）
// 以前は 1a 側にパブリックサブネット(subnet-0de1fb012fd66ce60)を使っていたが、
// Lambda の ENI はパブリックIPを持たず IGW 経由で外（Secrets Manager）へ出られないため
// /users が断続的にタイムアウトしていた。両方プライベートにして NAT 経由で到達させる。
const LAMBDA_SUBNET_IDS = ['subnet-004a44a992a6b4754', 'subnet-0c6a14ba71f893b3c']
const LAMBDA_AZS = ['ap-northeast-1a', 'ap-northeast-1c']
// handson-lambda-sg。Proxy SG(handson-proxy-sg) が 3306 をこの SG から許可している。
const LAMBDA_SG_ID = 'sg-0def3f09d79677051'

export class LambdaExpressApiStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props)

        // --- 既存ネットワークのインポート（新規作成しない） ----------------------
        // fromVpcAttributes / fromSubnetId / fromSecurityGroupId はいずれも
        // 「既存IDを参照するだけ」で、CloudFormation 上にリソースを作らない。
        const vpc = ec2.Vpc.fromVpcAttributes(this, 'HandsonVpc', {
            vpcId: VPC_ID,
            availabilityZones: LAMBDA_AZS,
        })
        const lambdaSubnets = LAMBDA_SUBNET_IDS.map((subnetId, i) =>
            ec2.Subnet.fromSubnetId(this, `LambdaSubnet${i}`, subnetId),
        )
        // mutable: false で既存SGを書き換えない（egress は既に全許可済み）。
        const lambdaSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'LambdaSg', LAMBDA_SG_ID, {
            mutable: false,
        })

        // --- Lambda 本体 ---------------------------------------------------------
        // TypeScript を tsc でビルドした dist/ と、本番 node_modules を zip して載せる。
        // swagger-ui-express は swagger-ui-dist の静的ファイルを実行時に読むため、
        // esbuild バンドルではなく node_modules ごと同梱する方式にしている。
        const fn = new lambda.Function(this, 'ExpressFn', {
            functionName: 'lambda-express-api',
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'dist/index.handler',
            memorySize: 512,
            timeout: Duration.seconds(30),
            // RDS Proxy は VPC 内にしかいないため、Lambda も同じ VPC に入れる。
            // これにより Lambda → RDS Proxy(3306) → RDS の経路が通る。
            // VPC に入れると CDK が ENI 管理用の AWSLambdaVPCAccessExecutionRole を
            // 実行ロールへ自動付与する。
            vpc,
            vpcSubnets: { subnets: lambdaSubnets },
            securityGroups: [lambdaSg],
            code: lambda.Code.fromAsset(APP_DIR, {
                bundling: {
                    // フォールバック（ローカルが使えない時のみ Docker で実行）
                    image: lambda.Runtime.NODEJS_22_X.bundlingImage,
                    command: [
                        'bash',
                        '-c',
                        [
                            'mkdir -p /tmp/build',
                            'cp -r /asset-input/. /tmp/build',
                            'cd /tmp/build',
                            'npm ci',
                            'npm run build',
                            'npm prune --omit=dev',
                            'cp -r dist node_modules package.json /asset-output/',
                        ].join(' && '),
                    ],
                    // 通常はこちら（Docker 不要・ホストの tsc でビルドして同梱）
                    local: {
                        tryBundle(outputDir: string): boolean {
                            try {
                                execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' })
                                execSync(`cp -r dist node_modules package.json ${outputDir}/`, {
                                    cwd: APP_DIR,
                                    stdio: 'inherit',
                                })
                                // ソースには触れず、デプロイ用コピーから devDependencies を除外
                                execSync('npm prune --omit=dev', {
                                    cwd: outputDir,
                                    stdio: 'inherit',
                                })
                                return true
                            } catch {
                                // 失敗したら CDK が上の Docker バンドリングにフォールバックする
                                return false
                            }
                        },
                    },
                },
            }),
        })

        // --- 将来 DB をつなぐ時のための権限 -------------------------------------
        // index.ts は Secrets Manager の handson/db を読む。DB 作成後はこの権限で
        // /users 系がそのまま動く（今は呼ばなければ未使用のまま）。
        fn.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['secretsmanager:GetSecretValue'],
                resources: [
                    `arn:aws:secretsmanager:${this.region}:${this.account}:secret:handson/db-*`,
                ],
            }),
        )

        // --- S3 権限 -------------------------------------------------------------
        // /uploads/presign: PutObject の署名付き URL 発行（署名に実行ロールの権限が必要）
        // /uploads/complete: HeadObject（メタデータ確認）→ CopyObject（temp→uploads）
        //                    → DeleteObject（temp 削除）
        fn.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['s3:PutObject', 's3:GetObject', 's3:HeadObject', 's3:DeleteObject'],
                resources: [`arn:aws:s3:::handson-mp4-upload-${this.account}/*`],
            }),
        )

        // --- REST API (API Gateway) ---------------------------------------------
        // proxy: true で全メソッド/全パスを Lambda に流し、ルーティングは Express に任せる。
        const api = new apigateway.LambdaRestApi(this, 'Api', {
            handler: fn,
            proxy: true,
            restApiName: 'lambda-express-api',
            deployOptions: { stageName: 'prod' },
        })

        new CfnOutput(this, 'ApiUrl', {
            value: api.url,
            description: 'API のベース URL（例: {url}health, {url}users, {url}api-docs）',
        })
    }
}
