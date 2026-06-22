# AWS デプロイ手順（Lambda + API Gateway + RDS）

Docker(docker-compose) で動かしている MySQL を AWS の RDS に移し、Express(TypeScript) を Lambda に上げて API Gateway 経由でブラウザから叩けるようにする手順。すべて **東京リージョン (`ap-northeast-1`)** の AWS マネジメントコンソール(GUI) 操作で行う。

## 最終構成

```
ブラウザ(フロント)
   │ HTTPS
   ▼
API Gateway (HTTP API, CORS有効)
   │ Lambdaプロキシ統合
   ▼
Lambda (Express / serverless-http)  ── VPCのプライベートサブネットに配置
   │                      │
   │ VPC内ルーティング      └─ NAT Gateway → インターネット → Secrets Manager(handson/db)
   ▼
RDS (MySQL8, DB名 handson)
```

- EC2 / ECS は作らない。
- Lambda はプライベートサブネット (PRIVATE_WITH_EGRESS) に配置し、NAT Gateway 経由で Secrets Manager のパブリック API に到達する。
- **VPC は新規作成せず、既存の VPC を使う。**

> この順番で進めること（VPC前提チェック → DB → シークレット → コード → Lambda → 公開）。

---

## ステップ1：既存VPCの前提条件チェック

VPC は新規作成しないが、今回の構成には以下が必要。使う既存VPCがこれを満たしているか **先に確認**する。

1. **VPC** コンソール → 使う VPC を選び、VPC ID をメモ。
2. **プライベートサブネットが2つ以上**あること（推奨は別AZ）。サブネット一覧で各サブネットの「ルートテーブル」を開き、`0.0.0.0/0` の宛先が **NAT Gateway (`nat-...`)** になっているものがプライベートサブネット。
3. その NAT Gateway が「利用可能」で、**パブリックサブネット側に Internet Gateway 経由の経路**があること（NATが外に出るために必要）。

> **デフォルトVPCの注意**：デフォルトVPCはパブリックサブネットのみで NAT Gateway が無いため、このままでは Lambda が Secrets Manager に到達できない。その場合は「プライベートサブネット＋NAT Gateway」を追加するか、別途 NAT を用意すること。
>
> 以降の手順で「VPC」を選ぶ場面では、この **既存VPC** と、ここで確認した **プライベートサブネット** を指定する。

---

## ステップ2：RDS（MySQL）を作る

docker-compose の内容に対応させる。初期データ投入のため、最初はパブリックアクセスを許可し、後で締める。

1. **RDS** →「**データベースの作成**」→ **標準作成**
2. エンジン：**MySQL 8.0.x**（compose の `mysql:8`）
3. テンプレート：**無料利用枠**
4. 設定：
   - DBインスタンス識別子：`handson-db`
   - マスターユーザー名：`root`
   - マスターパスワード：`password`
5. インスタンス：`db.t3.micro` / ストレージ 20GB
6. 接続：
   - VPC：**既存のVPC**（ステップ1で確認したもの）
   - DBサブネットグループ：自動作成のものでOK
   - **パブリックアクセス：あり**（※初期データ投入用。後で「なし」に変更）
   - VPCセキュリティグループ：**新規作成** → `handson-rds-sg`
7. 「**追加設定**」を展開 →「**最初のデータベース名：`handson`**」を入力（compose の `MYSQL_DATABASE`。入れ忘れ注意）
8. 作成 →「利用可能」になったら **エンドポイント** をメモ。

### RDSのセキュリティグループにルール追加
RDS →「接続とセキュリティ」→ `handson-rds-sg` →「インバウンドルールを編集」：
- **MYSQL/Aurora (3306)** / ソース **マイIP**（自分のPCから初期投入用）

---

## ステップ3：RDSに初期データを投入

`init/01-schema.sql` の内容を自分のPCから流す：

```bash
mysql -h <RDSエンドポイント> -u root -ppassword handson -e "
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO users (name) VALUES ('alice'), ('bob'), ('carol');
"
```

`mysql` コマンドが無ければ `brew install mysql-client`。投入後 `SELECT * FROM users;` で3件返れば成功。

---

## ステップ4：Secrets Manager に `handson/db` を作成

`getSecret()` はシークレットの中身をそのまま `mysql.createPool()` に渡すので、pool の設定キーで保存する。

1. **Secrets Manager** →「新しいシークレットを保存」→ **その他のシークレット**
2. 「平文」に貼り付け（**RDSエンドポイント**に置換）：

```json
{
  "host": "handson-db.xxxx.ap-northeast-1.rds.amazonaws.com",
  "user": "root",
  "password": "password",
  "database": "handson",
  "port": 3306
}
```

3. シークレット名：**`handson/db`**（`index.ts` の `SecretId` と完全一致させる）
4. 保存（リージョンが東京であること）。

---

## ステップ5：コードを2箇所修正してビルド

**① 認証情報** — ローカルプロファイルは Lambda に無いので削除し、実行ロールを使わせる：

```ts
// 修正前
const client = new SecretsManagerClient({
    region: 'ap-northeast-1',
    credentials: fromIni({ profile: 'mvtk-refactoring' })
})

// 修正後
const client = new SecretsManagerClient({ region: 'ap-northeast-1' })
```

**② CORS** — 別オリジンのフロントから叩くため追加：

```bash
npm install cors @types/cors
```
```ts
import cors from 'cors'
// app.use(express.json()) の前に
app.use(cors())   // 学習用に全許可。本番はフロントのドメインに限定
```

デプロイ用zipを作る（`dist/` と `node_modules/` を zip 直下に入れる）：

```bash
npm run build
zip -r function.zip dist node_modules package.json
```

> ハンドラは `dist/index.handler` を指定する（`exports.handler` がビルド後 `dist/index.js` に入るため）。

---

## ステップ6：Lambdaの実行ロールを作る

1. **IAM** →「ロールを作成」→ AWSサービス → **Lambda**
2. ポリシーを2つ付与：
   - `AWSLambdaVPCAccessExecutionRole`（VPC内で動くENI作成に必須）
   - `SecretsManagerReadWrite`（学習用。本番は最小権限に）
3. ロール名：`handson-lambda-role` → 作成

---

## ステップ7：Lambda関数を作る

1. **Lambda** →「関数の作成」→ **一から作成**
2. 設定：
   - 関数名：`handson-api`
   - ランタイム：**Node.js 22.x**
   - 実行ロール：**既存のロール** → `handson-lambda-role`
3. 「**コード**」タブ →「アップロード元」→「**.zipファイル**」→ `function.zip` をアップロード
4. 「**ランタイム設定**」→「編集」→ **ハンドラ：`dist/index.handler`**
5. 「**設定**」→「一般設定」→ タイムアウトを **30秒** に（VPC＋コールドスタート対策）
6. 「**設定**」→「**VPC**」→「編集」：
   - VPC：**既存のVPC**（ステップ1で確認したもの）
   - サブネット：**プライベートサブネット2つ**（ステップ1で NAT 向きルートを確認したもの）
   - セキュリティグループ：**新規作成** → `handson-lambda-sg`

### RDSのSGにLambdaからの接続を許可
RDS → `handson-rds-sg` →「インバウンドルールを編集」→ ルール追加：
- **MYSQL/Aurora (3306)** / ソース **カスタム** → `handson-lambda-sg` を選択

---

## ステップ8：API Gatewayで公開

1. **API Gateway** →「APIを作成」→ **HTTP API** の「構築」
2. 統合：**Lambda** → `handson-api`
3. API名：`handson-api` → ルートは自動（`ANY /{proxy+}` 等）でOK
4. 左メニュー「**CORS**」を設定：
   - Access-Control-Allow-Origin：`*`（本番はフロントのドメイン）
   - Methods：`GET, POST, PUT, DELETE, OPTIONS`
   - Headers：`content-type`
5. 「**ステージ**」→ **Invoke URL**（`https://xxxx.execute-api.ap-northeast-1.amazonaws.com`）をメモ。

ブラウザで `https://<Invoke URL>/health` → `{"status":"ok"}`、`/users` で alice/bob/carol が返れば完成。フロントの fetch 先をこの Invoke URL にする。

---

## ステップ9：RDSを締める（推奨）

初期投入が終わったら RDS をプライベート化する。
- RDS → `handson-rds-sg` のインバウンドから **マイIP の3306ルールを削除**（Lambda SG のルールは残す）
- さらに厳格にするなら RDS →「変更」→ **パブリックアクセス：なし**

これで RDS へは Lambda 経由でしか到達できなくなる。

---

## つまずきやすいポイント

- Lambda のハンドラを **`dist/index.handler`** にする。
- Lambda を **プライベートサブネット** に置き、**Lambda SG を RDS SG で許可**する。
- Lambda の **タイムアウトを延長**（VPC + コールドスタートで初回が遅い）。
- RDS 作成時に **「最初のデータベース名 `handson`」** を入れ忘れない。
- Secrets Manager の名前は **`handson/db`** とコードの `SecretId` を一致させる。
