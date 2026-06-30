---
name: precommit-check
description: コミット前にこのリポジトリの品質チェック（oxlint / oxfmt / tsgo 型チェック）を実行し、失敗を修正してから通す。ユーザーが「コミット前にチェックして」「lint通して」「型エラー直して」「checkして」「コミットしていい状態にして」などと言ったとき、またはコミット/プッシュ直前に使う。
---

# コミット前チェック

このプロジェクトは Node 系ではなく **oxlint / oxfmt / tsgo**（TypeScript native preview）で品質を担保している。
ルート `package.json` の `check` がそれらをまとめている。コミット前にこれを green にする。

## 実行するコマンド

```bash
npm run check
```

これは内部で順に実行される:
1. `npm run lint` → `oxlint --type-aware`（型を見るリンター）
2. `npm run format:check` → `oxfmt --check '**/*.ts'`（フォーマット差分の検出）
3. `npm run typecheck` → `tsgo -p cdk --noEmit && tsgo -p lambda-express-api --noEmit`（cdk と lambda-express-api 両方の型チェック）

## 手順

1. リポジトリ直下で `npm run check` を実行する。
2. **green（全て成功）なら完了。** その旨を報告し、ユーザーがコミットを望めばコミットする。
3. 失敗したら、失敗した段階に応じて対応する:
   - **format失敗** → `npm run format` で自動整形する（手作業で直さない）。
   - **lint失敗** → まず `npm run lint:fix` で自動修正を試す。残りは内容を読んで手で直す。ルールを安易に無効化(disable)しない。
   - **typecheck失敗** → 型エラーを1件ずつ読み、根本原因を直す。`any` や `@ts-ignore` での握りつぶしは避ける。`cdk` と `lambda-express-api` のどちらの project かを意識する。
4. 修正したら `npm run check` を再実行し、green になるまで繰り返す。
5. green になったら、変更内容を簡潔に報告する。

## 注意

- `tsgo` / `oxlint` / `oxfmt` はこのリポジトリ固有の構成。`tsc` や `eslint` `prettier` を代わりに使わない。
- 型エラーを `any`・`@ts-ignore`・lint の `disable` コメントで隠さない。直せない場合は理由を添えてユーザーに相談する。
- コミットはユーザーが望んだときのみ行う。green になっただけで勝手にコミットしない。
