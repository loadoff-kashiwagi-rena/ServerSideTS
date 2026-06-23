# CDK を自分で書けるようになる — 入門メモ

このプロジェクトの `lib/lambda-express-api-stack.ts` を題材に、ゼロから組み立てる形で CDK の書き方をまとめたメモ。
CDK は覚えることが少なく、**たった1つのパターンの繰り返し**でできている。まずそれを掴むのが最短。

---

## CDK を書く前に：たった1つの「型（パターン）」

CDK のコードは、99% がこの形の繰り返し。

```ts
new リソースの種類(this, '名前', { 設定 })
```

| 部分 | 意味 | 例 |
|------|------|-----|
| `リソースの種類` | 何を作るか | `lambda.Function`, `apigateway.LambdaRestApi` |
| `this` | どこに作るか（＝このスタックの中） | いつも `this` |
| `'名前'` | CDK 内での識別名（自分で決める） | `'ExpressFn'`, `'Api'` |
| `{ 設定 }` | 細かいオプション | メモリ量、タイムアウトなど |

**これだけ。** Lambda も API Gateway も IAM も、全部この形。
これが分かれば「あとは作りたいリソースの名前と設定を調べて埋めるだけ」になる。

---

## Step 0：いちばん外側の「箱」を作る

まず、何も中身が無い空っぽのスタックを書く。

```ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class LambdaExpressApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ↓ ここに作りたいリソースを足していく
  }
}
```

ここは**毎回ほぼコピペでOK**な「お決まりの枠」。意味だけ掴めば十分。

- `class LambdaExpressApiStack extends Stack` → 「Stack を土台にした、自分のスタック」を定義
- `constructor(...) { super(...) }` → スタックが作られるときに最初に呼ばれる初期化処理（おまじないと思ってOK）
- **`constructor` の中（`super(...)` の下）に、Step1 以降のリソースを書き足していく**

この枠を `bin/app.ts` が呼び出すことで、スタックが組み立てられる（＝入口）。

---

## Step 1：Lambda（アプリ本体）を1つ作る

さっきの「型」に当てはめる。まず一番シンプルな形。

```ts
import * as lambda from 'aws-cdk-lib/aws-lambda';

const fn = new lambda.Function(this, 'ExpressFn', {
  runtime: lambda.Runtime.NODEJS_22_X,        // 何の言語/バージョンで動かすか
  handler: 'dist/index.handler',              // 最初に呼ぶ関数（index.ts の handler）
  code: lambda.Code.fromAsset('...アプリの場所...'),  // どのコードを載せるか
});
```

ポイント:
- `new lambda.Function(this, 'ExpressFn', {...})` ← **さっきの型そのもの**
- `const fn = ` で**変数に受け取っている**のが大事。あとで「この Lambda に権限を付ける」「この Lambda に API をつなぐ」と**参照する**ために名前を付けている
- `runtime` / `handler` / `code` が Lambda の最低限の3点セット

`memorySize` や `timeout` は「あれば便利な追加設定」で、書かなければデフォルト値が使われる。
このプロジェクトでは丁寧に指定してある。

```ts
  memorySize: 512,
  timeout: Duration.seconds(30),
```

> 💡 `code` の `bundling` の部分（Docker フォールバックなど）は中級テクニック。
> 今は「**アプリをビルドして zip で載せる設定**」とだけ理解すればOK。

---

## Step 2：その Lambda に「権限」を付ける

Lambda が Secrets Manager を読めるようにする。
ここは「型」とは少し違い、**さっき作った `fn` に対してメソッドを呼ぶ**形。

```ts
import * as iam from 'aws-cdk-lib/aws-iam';

fn.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],   // 何をしてよいか
    resources: ['...対象のARN...'],                // どのリソースに対してか
  }),
);
```

読み方:
- `fn.addToRolePolicy(...)` → 「`fn`（Lambda）に権限ルールを追加して」
- `actions` = 許可する操作、`resources` = 操作してよい相手

**「actions（何を） × resources（どれに）」がセットで1つの権限**、と覚えると IAM はだいたい読める。

---

## Step 3：API Gateway をつないで外から呼べるようにする

また「型」に戻る。今度は HTTP の入口を作り、Step1 の `fn` に紐付ける。

```ts
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

const api = new apigateway.LambdaRestApi(this, 'Api', {
  handler: fn,        // ← Step1 の Lambda を指定。ここで「つながる」
  proxy: true,        // 全URL・全メソッドを Lambda に丸投げ（ルーティングは Express 任せ）
  deployOptions: { stageName: 'prod' },
});
```

**Step1 の `fn` を `handler: fn` として渡している**のがポイント。
これで「API Gateway に来たリクエスト → Lambda へ」という線がつながる。変数で受け取っておいた理由がここで活きる。

---

## Step 4：デプロイ後に URL を表示する

最後に、完成した API の URL をターミナルに出す設定。

```ts
import { CfnOutput } from 'aws-cdk-lib';

new CfnOutput(this, 'ApiUrl', {
  value: api.url,     // ← Step3 の api が持っている URL
});
```

`new CfnOutput(this, 'ApiUrl', {...})` ← これも**型は同じ**。`api.url` で Step3 の成果物を参照している。

---

## 全体を振り返ると…

このスタックは、結局この4ステップ。

```
① Lambda を作る        →  const fn = new lambda.Function(...)
② fn に権限を付ける     →  fn.addToRolePolicy(...)
③ API を作って fn に繋ぐ →  const api = new apigateway.LambdaRestApi({ handler: fn })
④ URL を出力する        →  new CfnOutput({ value: api.url })
```

気づいてほしいのは、**①③④はすべて `new 何か(this, '名前', {設定})` という同じ型**だということ。

> CDK を書く ＝「作りたいリソースを探して、この型に当てはめて、必要なら変数でつないでいく」だけ。

---

## 🎯 練習問題

理解を定着させるための練習。難易度を選べる。

- **【初級】** Lambda の**メモリを 512 → 1024 に変える**にはどこをどう直す？
- **【中級】** Lambda に**環境変数 `STAGE=prod` を追加**したい。`lambda.Function` の設定に何を足す？
  （ヒント：`environment` というオプションがある）
- **【上級】** 今の構成に、**もう1つ別の Lambda（例：`HelloFn`）を追加**するとしたら、どんなコードを書く？
  （「型」を思い出して）
