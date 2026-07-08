import { parseArgs } from "util"
import { loadEnv } from "../lib/load-env"
import { S3Client, CopyObjectCommand } from "@aws-sdk/client-s3"

loadEnv()

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-northeast-1"

const { values } = parseArgs({ options: {
    'src-bucket': { type: 'string' },
    'src-key': { type: 'string' },
    'dest-bucket': { type: 'string' },
    'dest-key': { type: 'string' },
}})

// s3:// や前後スラッシュを取り除いてバケット名を正規化する
const normalizeBucket = (b: string | undefined) =>
    b?.replace(/^s3:\/\//, '').replace(/^\/+|\/+$/g, '')
// キー先頭のスラッシュは S3 では別物になるため除去する
const normalizeKey = (k: string | undefined) => k?.replace(/^\/+/, '')

const srcBucket = normalizeBucket(values['src-bucket'])
const srcKey = normalizeKey(values['src-key'])
const destBucket = normalizeBucket(values['dest-bucket'])
// dest-key を省略したら src-key と同じキー名でコピー
const destKey = normalizeKey(values['dest-key']) || srcKey

if (!srcBucket || !srcKey || !destBucket) {
    console.error('使い方：npm run copy -- --src-bucket <name> --src-key <key> --dest-bucket <name> [--dest-key <key>]')
    process.exit(1)
}

const s3 = new S3Client({ region })

async function main() {
    const start = performance.now()
    await s3.send(new CopyObjectCommand({
        Bucket: destBucket,
        Key: destKey,
        // CopySource は「バケット名/キー」を URL エンコードして渡す
        CopySource: encodeURI(`${srcBucket}/${srcKey}`),
    }))
    const elapsedMs = performance.now() - start
    console.log(`✅ コピー完了（${elapsedMs.toFixed(1)} ms）`)
    console.log(`  from: s3://${srcBucket}/${srcKey}`)
    console.log(`  to  : s3://${destBucket}/${destKey}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
