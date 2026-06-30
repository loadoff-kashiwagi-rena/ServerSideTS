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

### CDK（実装済み）

- [x] 検証用スタック `cdk/lib/cloudfront-oac-stack.ts` を新規作成（既存 LambdaExpressApiStack に非干渉）
- [x] 完全プライベート S3 を新規作成（名前は `.env` から注入）
- [x] OAC オリジン（READ/WRITE/DELETE）+ バケットポリシー自動生成
- [x] CloudFront Distribution（ALLOW_ALL / ALL_VIEWER_EXCEPT_HOST_HEADER / CACHING_DISABLED / trustedKeyGroups）
- [x] 署名URL用 RSA 鍵ペア生成（`cdk/keys/`・gitignore）＋ `PublicKey` / `KeyGroup`
- [x] `cdk/bin/app.ts` に `.env` ローダと OACスタック登録（プレースホルダ時はスキップ）
- [x] `tsc --noEmit` / `cdk synth` で生成テンプレートを検証

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

## 受け入れ条件

- 署名付きURL経由の PUT / GET が CloudFront を通って成功する
- 無署名・署名切れのリクエストは 403 で拒否される
- S3 への直アクセスは拒否され、CloudFront(OAC) 経由のみアクセスできる
- 既存の Presigned URL 構成（LambdaExpressApiStack）に影響を与えない

## 補足（検証環境の既知の注意点）

- ローカルは Docker 未起動 ＆ 既存 build スクリプトが `tsgo -p`（引数不足）でこけるため、
  `LambdaExpressApiStack` のアセットバンドルが synth 時に失敗する。OAC 検証には無関係で、
  `cdk synth CloudFrontOacStack --exclusively` で回避できる。
