# RDS + RDS Proxy 接続手順（GUI / 東京リージョン）

Lambda(Express) から **RDS Proxy 経由**で RDS(MySQL) に接続する手順。
すべて AWS マネジメントコンソール(GUI) / `ap-northeast-1`。

RDS Proxy = Lambda と RDS の間で **DB接続をプール（使い回し）** する仕組み。
Lambda の大量同時実行による接続枯渇を防ぐ。

```
クライアント → API Gateway → Lambda(VPC内) → RDS Proxy → RDS(MySQL)
```

---

## このリポジトリの現状（調査済み）

| 項目 | 状態 |
|------|------|
| VPC | ✅ `vpc-0a06e9131f00316ec`（10.0.0.0/16）が利用可 |
| プライベートサブネット | ✅ 2つ・別AZ … `subnet-004a44a992a6b4754`(1a) / `subnet-0c6a14ba71f893b3c`(1c) |
| RDS インスタンス | ❌ 未作成 → ステップ1で作る |
| Secrets Manager `handson/db` | ⚠️ 存在するが **キーが `user`**。Proxy は `username` が必要 → ステップ3で修正 |
| Lambda | ⚠️ CDK でデプロイ済みだが **VPC 未配置** → ステップ6で対応 |

---

## 用意するもの（チェックリスト）

- [ ] **RDS(MySQL) インスタンス**（ステップ1）
- [ ] **Secrets Manager シークレット**に `username` / `password` キー（ステップ3）
- [ ] **RDS Proxy 用 IAM ロール**（シークレット読取り。ステップ4でProxy作成時に自動生成可）
- [ ] **セキュリティグループ3種の経路**：Lambda SG → Proxy SG → RDS SG（ステップ5）
- [ ] **RDS Proxy 本体**（ステップ4）
- [ ] **Lambda を VPC に配置 ＆ 接続先を Proxy エンドポイントに変更**（ステップ6）

---

## ステップ1：RDS(MySQL) を作る

`AWS_DEPLOY.md` のステップ2と同じ。要点のみ:

1. RDS →「データベースの作成」→ **標準作成** → **MySQL 8.0.x**
2. テンプレート：無料利用枠 / `db.t3.micro` / 20GB
3. 接続：**VPC = `vpc-0a06e9131f00316ec`**、**パブリックアクセス = なし**
4. SG：新規 `handson-rds-sg`
5. 「追加設定」→ **最初のデータベース名：`handson`**（入れ忘れ注意）
6. 作成 →「利用可能」になったら **エンドポイント** をメモ
7. 初期データ投入は `AWS_DEPLOY.md` ステップ3参照

> RDS Proxy を使う場合、最終的にアプリの接続先は **RDS ではなく Proxy のエンドポイント**になる。
> RDS のエンドポイントは Proxy 作成時のターゲット指定にだけ使う。

---

## ステップ2：（任意）RDS の認証情報を Secrets Manager 管理にする

RDS 作成時に「認証情報の管理」で **Secrets Manager** を選ぶと、RDS が専用シークレットを自動作成する。
この手順書では既存の `handson/db` を使うので、ここは飛ばしてステップ3へ。

---

## ステップ3：Secrets Manager `handson/db` に `username` を追加（重要）

**RDS Proxy はシークレットの `username` / `password` キーで DB にログインする。**
現状の `handson/db` は `user` キーなので、`username` を**追加**する（`user` は残してOK。アプリ側が使っている）。

1. Secrets Manager → `handson/db` →「シークレットの値を取得する」→「編集」
2. 平文(JSON) に `username` を追加（値は `user` と同じDBユーザー名）：
   ```json
   {
     "host": "<RDSエンドポイント>",
     "port": 3306,
     "user": "root",
     "username": "root",      // ← Proxy 用に追加
     "password": "password",
     "database": "handson"
   }
   ```
3. 保存

---

## ステップ4：RDS Proxy を作る

1. **RDS コンソール → 左メニュー「プロキシ」→「プロキシの作成」**
2. **プロキシ設定**
   - エンジンの互換性：**MySQL**
   - プロキシ識別子：`handson-rds-proxy`
   - アイドルクライアント接続タイムアウト：既定(30分)でOK
3. **ターゲットグループ設定**
   - データベース：ステップ1で作った **RDS インスタンスを選択**
   - 接続プールの最大接続率：既定(100%)
4. **接続**
   - **Secrets Manager のシークレット：`handson/db` を選択**
   - **IAM ロール**：「新しい IAM ロールを作成」（シークレット読取り権限を自動付与）
   - **IAM 認証**：学習用は **「必須にしない（Not required）」** でOK
     （※より安全にするなら「必須」にし、Lambda 側でトークン生成。ステップ6の補足参照）
   - **サブnet**：プライベートサブnet **2つ**を選択
     （`subnet-004a44a992a6b4754` / `subnet-0c6a14ba71f893b3c`）
   - **VPC セキュリティグループ**：新規 or 既存。ここでは `handson-proxy-sg` を新規作成
5. 作成 →「利用可能」になったら **プロキシのエンドポイント** をメモ

---

## ステップ5：セキュリティグループの経路を開ける

通信は **Lambda SG → Proxy SG → RDS SG** の3段。各 SG のインバウンドに 3306 を許可する。

1. **Proxy SG（`handson-proxy-sg`）** のインバウンド：
   - タイプ MySQL/Aurora (3306)、ソース = **Lambda の SG**
2. **RDS SG（`handson-rds-sg`）** のインバウンド：
   - タイプ MySQL/Aurora (3306)、ソース = **Proxy SG（`handson-proxy-sg`）**

> Lambda の SG は、ステップ6で Lambda を VPC 配置したときに決まる。
> 先に Lambda 用 SG（例 `handson-lambda-sg`）を作っておくと指定しやすい。

---

## ステップ6：Lambda を VPC に入れ、接続先を Proxy にする

現在 Lambda は CDK デプロイ済みだが **VPC 未配置**。Proxy(VPC内) に到達するには VPC 配置が必須。

### 6-1. Lambda を VPC に配置
- Lambda コンソール → 関数 `lambda-express-api` →「設定」→「VPC」→「編集」
  - VPC：`vpc-0a06e9131f00316ec`
  - サブネット：プライベート2つ
  - セキュリティグループ：`handson-lambda-sg`
- ※ CDK 管理下なので、本来は **CDK 側に `vpc` / `securityGroups` を追記して再デプロイ**するのが正攻法
  （GUI で直接変更すると次の `cdk deploy` で巻き戻る）

### 6-2. 接続先を Proxy エンドポイントに変更
- `index.ts` は `handson/db` の `host` で接続している。
- **シークレットの `host` を「RDSエンドポイント」→「Proxy のエンドポイント」に書き換える**だけでよい
  （コード変更不要。Proxy 経由になる）

### 6-3. （ローカルとの分岐）
`index.ts` の `fromIni({ profile: 'mvtk-refactoring' })` はローカル前提。
Lambda 上では実行ロール認証になるよう環境で分岐させる（`AWS_DEPLOY.md` ステップ5参照）。

### 補足：IAM 認証を「必須」にした場合
- Lambda 実行ロールに `rds-db:connect` 権限を付与
- 接続時に `RDS.Signer` で一時トークンを生成し、パスワードの代わりに使う
- パスワードレスで安全だが、コード変更が必要。学習用は「必須にしない」が手軽。

---

## 動作確認

```bash
curl https://<API_GatewayのURL>/prod/users
# → ユーザー一覧(JSON) が返れば Proxy 経由で DB 接続できている
```

---

## コストと後片付け

- **RDS Proxy は無料枠対象外**（DBの vCPU 時間課金）。RDS インスタンスも停止/削除しないと課金継続。
- 片付け：RDS Proxy 削除 → RDS 削除 →（不要なら）SG 削除。
- Lambda/API Gateway は `cd cdk && npx cdk destroy` で削除。

---

## つまずきやすいポイント

- シークレットに **`username` キー**が無いと Proxy が DB ログインに失敗する（`user` だけではダメ）。
- Proxy のサブネットは **別AZ 2つ以上**が必須。
- SG は **3段（Lambda→Proxy→RDS）すべて**開けないと繋がらない。
- アプリの接続先は **Proxy エンドポイント**（RDS 直ではない）。
- Lambda を **VPC に入れる**のを忘れない（入れないと Proxy に到達不可）。
