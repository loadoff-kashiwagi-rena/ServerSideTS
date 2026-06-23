# RDS に初期データを投入する手順（GUI + Docker）

作成した RDS(MySQL) は **中身が空っぽ**。`init/01-schema.sql`（テーブル定義＋初期データ）を流し込む手順。

対象 RDS:
- インスタンス: `handson-rds`
- エンドポイント: `handson-rds.cjgw0qcwotux.ap-northeast-1.rds.amazonaws.com`
- ユーザー / パスワード / DB名: `root` / `password` / `handson`

---

## 全体の流れ

```
① RDS をパブリックサブネットに移す（外から届くようにする）
        ↓
② Docker で使い捨ての mysql クライアントを起動して SQL を流す
        ↓
③ 投入できたか確認
        ↓
④ 後片付け（外からの接続穴を塞ぐ）
```

---

## なぜひと手間必要なのか（背景）

最初に `mysql -h ... < init/01-schema.sql` を実行したら、2つの壁にぶつかった。

| 壁 | 原因 | 対策 |
|----|------|------|
| `command not found: mysql` | Mac に MySQL クライアント未インストール | **Docker** で使い捨て起動（PCに入れない） |
| `Can't connect ... (111)` | RDS が**プライベートサブネット**にあり外から届かない | **パブリックサブネットに移す**（手順①） |

> プライベートサブネットは出口が NAT Gateway のみ＝「中から外へ」専用で、「外から中へ」入れない。
> だから「パブリックアクセス: あり」にしても、PC からは接続できなかった。

---

## ① RDS をパブリックサブネットに移す（GUI）

### 1-1. パブリック用の DB サブネットグループを作る

1. **RDS コンソール → 左メニュー「サブネットグループ」→「DB サブネットグループを作成」**
2. 入力：

   | 項目 | 値 |
   |------|-----|
   | 名前 | `handson-public-subnet-group` |
   | VPC | `vpc-0a06e9131f00316ec` |

3. アベイラビリティーゾーン：**`ap-northeast-1a`** と **`ap-northeast-1c`**
4. サブネット：**パブリックサブネット2つ**を選ぶ（ここが重要）
   - `subnet-0de1fb012fd66ce60`（1a）
   - `subnet-083178aeae3fe6929`（1c）
5. 「作成」

### 1-2. RDS をそのグループに変更

1. **RDS →「データベース」→ `handson-rds` → 右上「変更」**
2. **「接続」**セクションの **「DB サブネットグループ」** を `handson-public-subnet-group` に変更
3. 「パブリックアクセス」が **あり** になっているか確認
4. 「続行」→ **「すぐに適用」** → 「変更を実行」
5. ステータスが `modifying` → `available` に戻るまで数分待つ

> 💡 「変更」画面に DB サブネットグループの項目が無い場合は、末尾の「作り直す場合」を参照。

### 1-3. 自分の IP を許可（まだなら）

1. RDS → `handson-rds` →「接続とセキュリティ」→ VPC セキュリティグループのリンク
2. 「インバウンドのルールを編集」→「ルールを追加」
   - タイプ：**MySQL/Aurora**（3306）
   - ソース：**マイIP**
3. 保存

---

## ② Docker でデータを流し込む

Docker Desktop を起動した状態で、`lambda-express-api` ディレクトリで実行：

```bash
docker run --rm -i mysql:8 mysql \
  -h handson-rds.cjgw0qcwotux.ap-northeast-1.rds.amazonaws.com \
  -u root -ppassword handson < init/01-schema.sql
```

- `--rm` … 終わったらコンテナを自動削除（PCに残らない）
- `-i` … `< init/01-schema.sql` を流し込むための標準入力
- エラーが出なければ成功

---

## ③ 投入できたか確認

```bash
docker run --rm mysql:8 mysql \
  -h handson-rds.cjgw0qcwotux.ap-northeast-1.rds.amazonaws.com \
  -u root -ppassword handson \
  -e "SHOW TABLES; SELECT * FROM users LIMIT 5;"
```

`users` テーブルとデータが表示されれば OK。

---

## ④ 後片付け（投入が終わったら）

外から DB に届く穴を塞ぐ。

1. RDS のセキュリティグループ → **「マイIP」3306 ルールを削除**
2. （任意）RDS →「変更」→ **パブリックアクセス「なし」**
   - RDS Proxy は VPC 内から繋ぐので、なしにしても Proxy 経由なら動く

---

## トラブル時：RDS を作り直す場合

「変更」画面にサブネットグループの項目が無い／うまく移せないときは、
**RDS は空なので作り直すのが確実**。

1. ①-1 のパブリックサブネットグループを作る
2. `handson-rds` を**削除**（「最終スナップショット作成」のチェックは**外す**）
3. もう一度「フル設定」で作成し、**接続で `handson-public-subnet-group` を指定**
   - パブリックアクセス：あり
   - 「追加設定」→ 最初のデータベース名：**`handson`**（入れ忘れ注意）
4. 新しいエンドポイントをメモして ②へ

---

## 次のステップ

データ投入が終わったら `RDS_PROXY_SETUP.md` に戻り、RDS Proxy の作成へ進む。
- シークレット `handson/db` の `host` を RDS（→後で Proxy）エンドポイントに更新
- シークレットに `username` キーを追加（Proxy 用）
