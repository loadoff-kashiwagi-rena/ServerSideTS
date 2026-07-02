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

### デプロイ・実機検証（完了 2026-07-01）

- [x] `cdk deploy` → 署名URL生成（`cdk/scripts/sign-url.ts`）→ 実機検証 → `cdk destroy`（課金停止）まで実施
- [x] 署名URL経由の PUT / GET 成功、無署名・署名切れ 403、S3 直アクセス 403（OAC証明）を確認
- [x] mp4（29MB）の保存・取得、マルチパートアップロード（自作 `cdk/scripts/multipart-upload.ts`・3パート）も md5 一致で確認
- 詳細な結果は `lambda-express-api/技術検証.md` の「【技術検証】CloudFront署名付きURL + OAC の実機検証」節に記録済み。

### 判断・記録

- [x] 検証結果を `lambda-express-api/技術検証.md` に追記
- [ ] データ量確定後、コスト試算 vs セキュリティ便益で採否を判断（← 残る唯一のオープン項目）

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


Lambda はデフォルトでは、サーバー単体なのでプライベートネットワーク（VPC）は関係ない。VPC内では ENI（プライベートIP）しか保持できないため、IGW はパブリックIPを持つ通信しか通さないので、Secrets Manager と接続することができない。Lambda→NAT の順で IGW に出られるようになる。この時 NAT が自分のパブリックIP（EIP）を送信元として貸す（肩代わりする）ので、パブリックIPを持たない Lambda でも IGW を通れるようになる。これで Secrets Manager を参照できる。