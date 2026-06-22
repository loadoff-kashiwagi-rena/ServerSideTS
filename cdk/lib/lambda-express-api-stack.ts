import * as path from 'path';
import { execSync } from 'child_process';
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';

// Express アプリ（serverless-http 済み）のディレクトリ。
// dist/index.handler が Lambda のエントリポイント。
const APP_DIR = path.join(__dirname, '..', '..', 'lambda-express-api');

export class LambdaExpressApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

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
                execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
                execSync(`cp -r dist node_modules package.json ${outputDir}/`, {
                  cwd: APP_DIR,
                  stdio: 'inherit',
                });
                // ソースには触れず、デプロイ用コピーから devDependencies を除外
                execSync('npm prune --omit=dev', { cwd: outputDir, stdio: 'inherit' });
                return true;
              } catch {
                // 失敗したら CDK が上の Docker バンドリングにフォールバックする
                return false;
              }
            },
          },
        },
      }),
    });

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
    );

    // --- REST API (API Gateway) ---------------------------------------------
    // proxy: true で全メソッド/全パスを Lambda に流し、ルーティングは Express に任せる。
    const api = new apigateway.LambdaRestApi(this, 'Api', {
      handler: fn,
      proxy: true,
      restApiName: 'lambda-express-api',
      deployOptions: { stageName: 'prod' },
    });

    new CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API のベース URL（例: {url}health, {url}users, {url}api-docs）',
    });
  }
}
