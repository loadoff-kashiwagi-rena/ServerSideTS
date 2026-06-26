# S3アップロード後にLambdaでバリデーションを行い、本番S3へ移動してRDSに保存する

## 概要

クライアントが Presigned URL で S3（一時置き場）にアップロードした後、
Lambda がファイルの検証を行い、問題なければ本番 S3 へ移動して RDS にレコードを保存する。

## 背景

現状は認証なしで誰でも S3 に何でもアップロードできる状態のため、
サーバーサイドでのバリデーションが必要。

## 処理フロー

```
① クライアント → POST /uploads/presign → Lambda
                                        ↓
② Lambda → 一時バケット（temp/）に Presigned URL 発行
                                        ↓
③ クライアント → PUT <Presigned URL> で mp4 を S3(temp/) へ直接アップロード
                                        ↓
④ クライアント → POST /uploads/complete (key) → Lambda
                                        ↓
⑤ Lambda → S3(temp/) からファイルを取得してバリデーション
   - ファイルサイズ確認
   - Content-Type 確認（video/mp4 か）
   - （任意）ファイルの先頭バイトで mp4 シグネチャ確認
                                        ↓
⑥ Lambda → S3(uploads/) へコピー（本番バケット）
                                        ↓
⑦ Lambda → RDS に保存（uploads テーブルへ INSERT）
   - user_id, s3_key, file_size, status 等
                                        ↓
⑧ Lambda → S3(temp/) の一時ファイルを削除
```

## やること

- [ ] S3 に `temp/` プレフィックスと `uploads/` プレフィックスを用意する
- [ ] `/uploads/presign` を `temp/` 向けに変更する
- [ ] `/uploads/complete` エンドポイントを新規作成する
- [ ] Lambda に `s3:GetObject`, `s3:CopyObject`, `s3:DeleteObject` 権限を追加する（CDK）
- [ ] RDS に `uploads` テーブルを作成する
- [ ] Lambda から RDS へ保存する処理を実装する

## 受け入れ条件

- バリデーション失敗時は `temp/` のファイルを削除し 400 を返す
- バリデーション成功時のみ RDS にレコードが残る
- 一時ファイルは必ず削除される（成功・失敗どちらでも）
