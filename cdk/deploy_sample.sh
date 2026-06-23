export AWS_PROFILE=xxxx # AWSプロファイル名を設定
cdk deploy

# MEMO: test,prodなど環境毎のdeploy.shを用意して、スタック名を環境変数付きで実行するほうが良いかも(.envではなく)