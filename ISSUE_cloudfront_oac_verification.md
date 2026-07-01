# CloudFront 署名付きURL + OAC 方式のアップロード/配信を技術検証する

## 概要

大容量ファイルの直アップロード/配信方式として「CloudFront 署名付きURL + OAC（Origin Access Control）」を
検証する。クライアントは S3 ではなく CloudFront ドメインへリクエストし、CloudFront が OAC(SigV4) で
署名して S3 へ転送する。PUT（アップロード）／GET（配信）の両方が、署名付きURL経由でのみ通ることを実機で確認する。

## 背景

現状は **S3 Presigned URL + バケットポリシー `aws:SourceIp`** を採用している。
ただし Presigned URL の直 PUT は **API Gateway / WAF を通らない**ため、IP制限を S3 側で別途担保している。

CloudFront + OAC 方式は「全リクエストが CloudFront を通る」ため、**WAF / IP制限 / DDoS対策を一元化**できる利点がある。
一方で全リクエストが CloudFront を経由する分、**データ転送料**が乗る。
そのため採否は、保存ファイルのデータ量確定後に **コスト試算 vs セキュリティ便益**で判断する。
本 issue はその判断材料として、方式が成立するか（動くか・OACが効くか）を先に技術検証することが目的。

- 比較表は `lambda-express-api/技術検証.md` の「アップロード方式の比較」節を参照。
- 制約: S3 Presigned URL と OAC は**同一リクエストで併用不可**（`Only one auth mechanism allowed`）。

## 構成

```
[クライアント] --署名付きURL(PUT/GET)--> [CloudFront] --OAC(SigV4)--> [S3(完全プライベート)]
                     ↑ trustedKeyGroups で署名必須                ↑ バケットポリシーで CloudFront 経由のみ許可
```

- S3: 完全プライベート（パブリックアクセス全ブロック）。バケット名は `.env` の `OAC_VERIFY_BUCKET`。
- OAC: `READ / WRITE / DELETE`（PUT/GET/DELETE を検証するため）。
- CloudFront: `ALLOW_ALL` メソッド ＋ `ALL_VIEWER_EXCEPT_HOST_HEADER`（SigV4 署名にクエリ/ヘッダを転送、マルチパート対応）
  ＋ `CACHING_DISABLED` ＋ `trustedKeyGroups`（署名付きURL必須）。
- 署名鍵: RSA 鍵ペア。公開鍵を CloudFront `PublicKey` + `KeyGroup` に登録、秘密鍵で署名URLを生成。

## やること

### CDK（実装済み・synth検証済み 2026-06-30）

- [x] 検証用スタック `cdk/lib/cloudfront-oac-stack.ts` を新規作成（既存 LambdaExpressApiStack に非干渉）
- [x] 完全プライベート S3 を新規作成（名前は `.env` から注入、`BLOCK_ALL`+`enforceSSL`+`DESTROY`+`autoDeleteObjects`）
- [x] OAC オリジン（READ/WRITE/DELETE）+ バケットポリシー自動生成（`S3BucketOrigin.withOriginAccessControl`）
- [x] CloudFront Distribution（ALLOW_ALL / ALL_VIEWER_EXCEPT_HOST_HEADER / CACHING_DISABLED / trustedKeyGroups）
- [x] 署名URL用 RSA 鍵ペア生成（`cdk/keys/cf_private_key.pem` / `cf_public_key.pem`・gitignore）＋ `PublicKey` / `KeyGroup`
- [x] `cdk/bin/app.ts` に `.env` ローダと OACスタック登録（`OAC_VERIFY_BUCKET` が未設定/`xxxxx` 含む時はスキップ）
- [x] `tsc --noEmit`（exit0）/ `cdk synth CloudFrontOacStack --exclusively`（exit0）で生成テンプレートを検証

### デプロイ・実機検証（未実施）

- [ ] `cdk/.env` の `OAC_VERIFY_BUCKET` を一意な名前に設定して `cdk deploy CloudFrontOacStack`
- [ ] 署名付きURL生成スクリプトを作成（秘密鍵で署名し PUT/GET URL を発行）
- [ ] CloudFront 経由の **PUT** が成功し、S3 にオブジェクトが保存されることを確認
- [ ] CloudFront 経由の **GET** で保存オブジェクトを取得できることを確認
- [ ] **無署名 / 署名切れ** のリクエストが 403 になることを確認
- [ ] **S3 への直アクセス**（CloudFront を介さない）が拒否されることを確認（OAC が効いている証明）
- [ ] （任意）マルチパートアップロード（`uploads` / `uploadId` / `partNumber`）が通ることを確認

### 判断・記録

- [ ] 検証結果を `lambda-express-api/技術検証.md` に追記
- [ ] データ量確定後、コスト試算 vs セキュリティ便益で採否を判断

#### メモ: 検証スクリプト構成と API化との違い（2026-07-01）

- 検証は使い捨て構成でOK: `cdk/scripts/sign-url.ts`（`@aws-sdk/cloudfront-signer`
  + `node:util parseArgs`, `ts-node`実行）＋ ローカル鍵 `keys/cf_private_key.pem` を `readFileSync`。
  引数で `domain`/`keyPairId`/`path` を渡す。検証後スクリプトは消す方針。
- **API化するなら設計が別物（スクリプトは流用不可）**:
  - 秘密鍵はリポジトリ/バンドルに入れない → Secrets Manager or SSM(SecureString)+KMS、Lambda ロールに読取IAM。
  - 署名は `lambda-express-api` 側でリクエスト毎に動的生成。発行APIに**認証・認可**必須。
  - オブジェクトキーはユーザー単位プレフィックス（任意キー署名を防ぐ）。
  - `KeyGroup` に複数鍵で無停止ローテーション。`PublicKeyId`/`domain` は env or SSM で連携。
  - 本番トラフィックが全て CloudFront 経由 → データ転送料が本番規模で発生（採否判断の対象）。

## 受け入れ条件

- 署名付きURL経由の PUT / GET が CloudFront を通って成功する
- 無署名・署名切れのリクエストは 403 で拒否される
- S3 への直アクセスは拒否され、CloudFront(OAC) 経由のみアクセスできる
- 既存の Presigned URL 構成（LambdaExpressApiStack）に影響を与えない

## 補足（検証環境の既知の注意点）

- ローカルは Docker 未起動 ＆ 既存 build スクリプトが `tsgo -p`（引数不足）でこけるため、
  `LambdaExpressApiStack` のアセットバンドルが synth 時に失敗する。OAC 検証には無関係で、
  `cdk synth CloudFrontOacStack --exclusively` で回避できる。

---

## 再開手順（2026-06-30 中断・別PCで再開する用）

ブランチ `feature/cloudfront-oac-investigation` で作業中。CDK は synth まで完了し、ここで中断。
**deploy 前の状態**なので、別PCでは鍵を作り直してOK（公開鍵はまだ AWS 未登録）。

### git で渡るもの（commit + push 済み前提）
- `cdk/lib/cloudfront-oac-stack.ts`、`cdk/bin/app.ts`、本ファイル

### git に乗らない＝別PCで再作成が必要（gitignore 済み）
| 物 | 別PCでの再作成 |
|---|---|
| `cdk/.env` | `cp cdk/.env.example cdk/.env` → `OAC_VERIFY_BUCKET=handson-cloudfront-oac-verify-20260630` |
| `cdk/keys/cf_*.pem` | 下記 openssl で新規生成（秘密鍵はコピーしない方が安全） |
| `cdk/node_modules` | `cd cdk && npm ci` |
| AWS 認証情報 | `aws configure`（リージョンは **ap-northeast-1** 固定。bootstrap 要確認） |

### 別PCでの再開コマンド
```bash
git pull            # feature/cloudfront-oac-investigation を checkout
cd cdk && npm ci

cp .env.example .env   # OAC_VERIFY_BUCKET=handson-cloudfront-oac-verify-20260630 に編集
mkdir -p keys
openssl genrsa -out keys/cf_private_key.pem 2048
openssl rsa -pubout -in keys/cf_private_key.pem -out keys/cf_public_key.pem

aws configure          # region=ap-northeast-1
npx tsc --noEmit
npx cdk synth CloudFrontOacStack --exclusively   # ここまで通れば中断前と同じ状態
```

### 中断時点の残タスク（順番）
1. **STEP6 署名URL生成スクリプト**（AWS不要・先に書ける）: `@aws-sdk/cloudfront-signer` の `getSignedUrl` を使い、
   `cdk/keys/cf_private_key.pem` + deploy 出力の `PublicKeyId` で PUT/GET 用署名URLを発行。
2. **deploy**: `npx cdk deploy CloudFrontOacStack --exclusively`（出力の `DistributionDomainName` / `PublicKeyId` を控える）。
3. **実機検証**: 署名PUT/GET 成功・無署名/期限切れ 403・S3 直アクセス拒否（OAC証明）。
4. **削除**: `npx cdk destroy CloudFrontOacStack --exclusively`（CloudFront は起動中ずっと課金。検証後すぐ削除する）。
5. 結果を `lambda-express-api/技術検証.md` に追記。
