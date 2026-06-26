# 学習Q&A（このセッションで出た質問まとめ）

ハンズオンの中で出た疑問と、その回答を整理したもの。

---

## 1. ネットワーク / DB接続

### Q. Lambda を通して DB に情報を追加できますか？
できる。`POST /users` エンドポイントが実装済みで、Lambda → RDS Proxy → RDS(MySQL) 経由で
`users` テーブルに INSERT する。ただし最初は接続不可（タイムアウト）だった。原因は下記。

### Q. なぜ private サブネットのみにしたら Secrets Manager と接続できたの？
核心は **「Lambda の ENI はパブリックIPを持てない」** こと。

- Secrets Manager は VPC の外（インターネット側）の公開API。到達するには外へ出る経路が要る。
- **public サブネット → Internet Gateway(IGW)** は「送信元がパブリックIPを持つ通信」しか通せない。
  Lambda はパブリックIPが無いので IGW で弾かれ、30秒ハング → タイムアウトしていた。
- **private サブネット → NAT Gateway** は、NAT が自分のパブリックIP(EIP)を貸して外に出してくれる。
  だから private + NAT にしたら到達できて解決した。

> 直感に反するが「Lambdaをインターネットに出したいなら public ではなく NAT付き private サブネット」。

補足: CloudWatch Logs は前から成功していた。理由は **Logs用のVPCエンドポイント**があり、
インターネットに出ずVPC内の専用口で到達できたから。Secrets Manager にはその専用口が無かった。

### Q. 今の CDK のコードのままで問題なく動く？
動かない。CDK は public サブネットを指定したままで、これが接続不能を再現する状態だった。
`LAMBDA_SUBNET_IDS` を private 2つに変更して解決した。

### Q. 使わないのに、なぜ ID を書く必要があるの？
「ID」が2種類あって混同していた。

- **サブネットID**（`subnet-004a...`）: **書くし使う**。Lambdaの ENI をどこに置くかの指定に必須。
- **ルートテーブルID**: **書かないし使わない**。CDK の警告はこちらを指す。

→ 書くのは「使うID（サブネットID）」、書かないのは「使わないID（ルートテーブルID）」。矛盾していない。

### Q. cdk の警告（routeTableId が無い）はなぜ無害？
`fromSubnetId` はサブネットIDしか知らないため `.routeTable.routeTableId` が undefined になる、という予告。
今回そのプロパティを一度も読まない（ルートを追加する処理が無い）ので影響しない。
かつ変更していない側のサブネットでも同じ警告が出ており、以前から無害に出ていたもの。

---

## 2. アップロード / curl

### Q. `curl: Can't open '/video/16_9.mp4'` はどんな失敗？
アップロード失敗ではなく、curl が **ローカルのファイルを開けなかった**だけ（エラーコード26）。
S3 には1バイトも送っていない。パスが `/video/...`（ルート直下）で誤り。
正しくは `/Users/loadoff/workspace/ServerSideTS/video/16_9.mp4`。

---

## 3. CORS

### Q. この CORS のコードはどんな記述？
別オリジン（Nuxt: localhost:3001）からの呼び出しを許可する共通処理(ミドルウェア)。

- `Access-Control-Allow-Origin` … この相手は許可、とブラウザに伝える（最重要）
- `Access-Control-Allow-Methods/Headers` … 許可するメソッド/ヘッダ
- `if (OPTIONS) return 204` … **プリフライト（事前確認）**への返事。本体処理には進ませない

ブラウザは複雑なリクエスト前に `OPTIONS` で「送っていい？」と自動で確認する。それがプリフライト。

### Q. CORS エラーの赤い文の意味は？
```
blocked by CORS policy ... No 'Access-Control-Allow-Origin' header ...
upload.vue:24  POST .../uploads/presign net::ERR_FAILED
```
- 1行目=原因: ブラウザが「許可ヘッダが無い」と判断してブロック
- 2行目=結果: 24行目の fetch が失敗（ERR_FAILED）

ポイント: **サーバ間(curl)では起きず、ブラウザ経由でだけ起きる**安全機構。
許可ヘッダを返すミドルウェアを入れると通る（ビフォーアフターを実機で確認済み）。

---

## 4. presigned URL のセキュリティ

### Q. presigned URL が漏れたら、外部者も S3 に直接保存できる？
できる。ただし**署名した内容に固定**される。

漏れたURLでできること/できないこと（今回の設定: 300秒・key固定・PUT）:
- ⭕ その1キーに PUT（上書き含む） / ❌ 期限切れ後 / ❌ 別キー / ❌ GET・DELETE / ❌ 他ファイル閲覧

被害は「その特定キーに、有効期限内だけ、書き込める」に限定。

残るリスクと対策:
- サイズ・種別が無制限（署名対象が host のみ）→ **presigned POST** で `content-length-range` 等を強制
- 発行エンドポイントが無認証（最優先の穴）→ **ログイン必須**にする
- 上書き可 → **一意キー(UUID)** ＋必要ならバージョニング
- 有効期限は短く（300秒は妥当、用途次第で更に短縮）

---

## 関連ファイル
- 構成図: `ARCHITECTURE_session.md`
