# CloudFront署名付きURL + OAC 方式のアップロードフロー（説明用まとめ）

このリポジトリの「アップロード2系統」のうち **OAC方式** を、人に説明できるように整理したメモ。
※現状の本番採用は **S3 Presigned URL 方式**。OAC方式は技術検証済み（`ISSUE_cloudfront_oac_verification.md` / `lambda-express-api/技術検証.md`）で、採否はデータ量確定後のコスト判断待ち。

---

## いちばん大事な概念：署名は2種類ある

OAC方式では署名が **2種類** あり、ここを混同しやすい。

| 区間 | 署名の種類 | 誰が使う／見えるか |
|---|---|---|
| クライアント → CloudFront | **CloudFront署名付きURL**（RSA秘密鍵で署名。`trustedKeyGroups`が検証） | **クライアントが受け取るのはコレ** |
| CloudFront → S3 | **OAC（SigV4）** | CloudFront が裏で付ける。**クライアントには見えない** |

- クライアントが持つのは **「CloudFront署名付きURL」**。「OAC用のURL」ではない。
- **OAC はクライアントに渡すものではなく**、CloudFront が S3 へ転送する時に内部で付ける署名。

---

## 押さえる3つの核心（間違えやすい点）

1. **クライアントが持つのは CloudFront署名付きURL**（OACはCloudFront→S3の内部署名で、クライアントは見えない）。
2. **署名URLは Lambda がローカルで作る**（`@aws-sdk/cloudfront-signer` + RSA秘密鍵）。**S3にURL発行を依頼しない**。S3に頼むのはマルチパートの `UploadId`（`CreateMultipartUpload`）だけ。
3. **`POST /uploads/complete` が「検証 + コピー + RDS保存 + temp削除」を1回で完結**する。クライアントからの「RDS保存用リクエスト」は存在しない（別の往復を発明しない）。

---

## 正しいフロー全体

```
【① URL発行】
クライアント → API Gateway → Lambda
  Lambda が手元の秘密鍵で CloudFront署名付きURL を生成（S3への通信なし）
  ※マルチパートなら先に S3:CreateMultipartUpload で UploadId を取得
Lambda → クライアント：署名付きURL（＋UploadId）

【② 転送（★API Gateway を通らない別経路）】
クライアント →(署名付きURL)→ CloudFront
  CloudFront が署名を検証(trustedKeyGroups) → OAC(SigV4)でS3へ転送
  → バリデーション前S3 に各パートを PUT → S3 がパートごとに ETag を返す
クライアント → API Gateway → Lambda：ETag一覧 [{PartNumber, ETag}...] を返す
Lambda → S3:CompleteMultipartUpload（★これが引き金で S3 が結合＝再構築）

【③ 検証〜保存（complete 1回で完結）】
クライアント → API Gateway → Lambda：POST /uploads/complete
  Lambda: HeadObject で検証（サイズ・Content-Type 等）
    NG → バリデーション前S3を削除 → 400
    OK → バリデーション後S3へ CopyObject
       → RDS Proxy 経由で RDS へ INSERT
            INSERT失敗 → 後S3のコピーも前S3も削除（補償処理）
       → バリデーション前S3を削除（RDS保存の後）
  → 201
```

---

## 細かいが落としやすい点

- **削除の順番**：temp（バリデーション前）の削除は **RDS INSERT の後**。コピー直後ではない。
- **補償処理**：INSERT が失敗したら、コピー済みのバリデーション後S3も**両方削除**して整合を戻す（S3とRDSはトランザクションをまたげないため）。
- **マルチパートの再構築**：各パートのPUTだけでは完成しない。**ETag一覧をLambdaに返し → Lambdaが `CompleteMultipartUpload` を叩く**ことで初めてS3が結合する。自動ではない。
- **CloudFrontの役割**：主役は「①署名付きURLの検証（trustedKeyGroups）」と「②OACでSigV4署名してS3へ転送」。WAF/IP制限はそこに乗せる**追加保護**の位置づけ（WAF/IP確認"だけ"ではない）。
- **バケット構成**：要件では「バリデーション前/後を別バケット」に分離。ただし**現在の実装コード（`index.ts`）は1バケット内の `temp/` と `uploads/` プレフィックス**。設計（2バケット）と実装（プレフィックス）の差に注意。

---

## 説明練習（残りの範囲・自己チェック用）

「口頭で説明 → 誤りを厳しく添削」方式で定着させる。おすすめ順は **3 → 5 → 4(軽く)**。
各項目を見ずに言えるか自己テストする。

### 🥇 3. DB周り（最優先：一度つまずいた所）

因果を数字で語れると強い（`lambda-express-api/技術検証.md` に実測値あり）。

- [ ] **RDS** = DBサーバー本体（`→DB` と別ノードで書かない）
- [ ] **RDS Proxy** = 同時実行で増える接続を少数に束ねて枯渇を防ぐ
  - Lambda は同時実行で**プロセスが増える** → 各プロセスが最大10本ずつ接続を握る → **プロセス数×10本**で増える
  - RDS の上限（`max_connections`、ローカル実測151本）を超えると枯渇
  - Proxy が多数の接続を**少数のDB接続に多重化**して防ぐ
  - ※用語注意：捌くのは「リクエスト」ではなく「コネクション（接続）」。「セッションプール」ではない
- [ ] **Secrets Manager** = DB接続情報をコードに書かず起動時に取得（`getSecret()` → `mysql.createPool()`）
  - ウォーム/コールドとの関係：ウォームで残る＝開いた接続（プール）も握りっぱなし → だからProxyが要る

### 🥈 5. CDK（このリポジトリで一番「らしい」ポイント）

- [ ] 「作る」もの：**Lambda・IAM権限・API Gateway**（`new lambda.Function` / `fn.addToRolePolicy` / `new apigateway.LambdaRestApi`）
- [ ] 「作らず import するだけ」：**VPC・サブネット・SG**（`fromVpcAttributes` / `fromSubnetId` / `fromSecurityGroupId`）
- [ ] **なぜ import なのか**：新規作成すると **Proxy SG が Lambda SG を名指しした許可が壊れる**から。既存リソースへの依存を壊さない
- [ ] CDKの基本形：`new リソース(this, '名前', {設定})` の繰り返し（`cdk/CDK_入門メモ.md`）

### 🥉 4. アップロード基盤（現状採用の presigned URL 方式：軽く復習）

OAC方式は上記で習得済み。残りは**現状採用の S3 Presigned URL 方式**を一言で言えるか。

- [ ] presign の PUT は**クライアント→S3直行**で **API GW/Lambda を通らない**
- [ ] そのURLが何をできるかは**署名したLambda実行ロールのIAM権限**で決まる（使う側＝クライアントはURLを持つだけ）
- [ ] 直PUTはAPI GWを通らない弱点 → **S3バケットポリシーの `aws:SourceIp`** でIP制限を別途担保（現状方針）

---

## 関連ドキュメント

- `lambda-express-api/技術検証.md` … アップロード方式の比較・OAC実機検証結果・マルチパート詳細
- `ISSUE_cloudfront_oac_verification.md` … OAC技術検証の目的・構成・受け入れ条件
- `ARCHITECTURE_session.md` … 全体アーキテクチャ図（機能A/B）
- `lambda-express-api/index.ts` … `/uploads/presign`・`/uploads/complete` の実装
