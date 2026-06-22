# CDK — Lambda + API Gateway デプロイ

`../lambda-express-api`（Express + serverless-http）を **Lambda + REST API Gateway** にデプロイする CDK(TypeScript) スタック。

## 構成

- **Lambda**: Node.js 22 / handler `dist/index.handler` / メモリ512MB / タイムアウト30秒
  - ビルド: `tsc` で `dist/` を生成し、本番 `node_modules` ごと zip して同梱（`swagger-ui-express` の静的アセットを壊さないため esbuild バンドルは使わない）
  - バンドルは**ローカルの tsc**で実行（Docker不要）。失敗時のみ Docker にフォールバック。
- **API Gateway**: REST API（`proxy: true`、ステージ `prod`）。全パス/全メソッドを Lambda に流し、ルーティングは Express が担当。
- **IAM**: Secrets Manager `handson/db` の `GetSecretValue` 権限を付与済み（DB 接続は将来用。現状 `/health` `/users` `/api-docs` のうち DB を使う `/users` 系は DB 未作成のため動かない）。

## 前提

- AWS 認証情報（`aws configure` 済みのプロファイル等）
- リージョンは `ap-northeast-1` 固定（`bin/app.ts`）

## デプロイ手順

```bash
cd cdk
npm install

# 初回のみ: このアカウント/リージョンを CDK 用に初期化
AWS_PROFILE=<your-profile> npx cdk bootstrap

# 差分確認 → デプロイ
AWS_PROFILE=<your-profile> npx cdk diff
AWS_PROFILE=<your-profile> npx cdk deploy
```

デプロイ完了後、出力 `ApiUrl`（例 `https://xxxx.execute-api.ap-northeast-1.amazonaws.com/prod/`）で疎通確認:

```bash
curl https://xxxx.execute-api.ap-northeast-1.amazonaws.com/prod/health
# => {"status":"ok"}
# Swagger UI: 同URL + api-docs をブラウザで開く
```

## 片付け

```bash
AWS_PROFILE=<your-profile> npx cdk destroy
```

## DB を繋ぐとき（将来）

1. RDS(MySQL) と Secrets Manager `handson/db`（host/user/password/database を含む JSON）を用意
2. RDS がプライベートサブnet なら、Lambda を同 VPC に配置（`vpc` / `securityGroups` 追加）する必要あり
3. `index.ts` は Lambda 上で実行ロール認証を使うよう、`fromIni` プロファイル指定を環境で分岐させる（ローカルのみプロファイル使用）と良い
