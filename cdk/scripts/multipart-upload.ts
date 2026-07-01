import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from "util"
import { loadEnv } from "../lib/load-env"
import { getSignedUrl } from '@aws-sdk/cloudfront-signer'


loadEnv()

const distDomain = process.env.DIST_DOMAIN
const publicKeyId = process.env.PUBLIC_KEY_ID

if (!distDomain || !publicKeyId) {
    console.error('env に DIST_DOMAIN と PUBLIC_KEY_ID を設定してください')
    process.exit(1)
}

const { values } = parseArgs({ options: {
    file: { type: 'string' },
    key: { type: 'string' },
    'part-size': { type: 'string', default: '10'},
}})

if (!values.file || !values.key) {
    console.error('使い方：npm run mp -- --file <localPath> --key <s3key> [--part-size <MB>]')
    process.exit(1)
}

const partSizeMB = Number(values['part-size'])
if (!Number.isFinite(partSizeMB) || partSizeMB < 5) {
    console.error('part-size は 5 以上の数値（MB）で指定してください')
    process.exit(1)
}

const buffer = fs.readFileSync(path.join(__dirname, '..', values.file))
const partCount = Math.ceil(buffer.length / (partSizeMB * 1024 * 1024))

const privateKey = fs.readFileSync(path.join(__dirname, '..', 'keys', 'cf_private_key.pem'), 'utf8')

function signUrl(pathWithQuery: string, expiresInSec = 300): string {
    const url = `https://${distDomain}/${pathWithQuery.replace(/^\//, '')}`
    const dateLessThan = new Date(Date.now() + expiresInSec * 1000).toISOString()
    return getSignedUrl({ url, keyPairId: publicKeyId!, privateKey, dateLessThan })
}

async function initiate(key: string): Promise<string> {
    const res = await fetch(signUrl(`${key}?uploads`), { method: 'POST' })
    const xml = await res.text()
    const m = xml.match(/<UploadId>(.+?)<\/UploadId>/)
    if (!m) throw new Error(`initiate 失敗: ${res.status}\n${xml}`)
    return m[1]
}

async function uploadPart(key: string, uploadId: string, n: number, body: Buffer): Promise<string> {
    const url = signUrl(`${key}?partNumber=${n}&uploadId=${uploadId}`)
    const res = await fetch(url, { method: 'PUT', body })
    if (!res.ok) throw new Error(`part ${n} 失敗: ${res.status}\n${await res.text()}`)
    const etag = res.headers.get('etag')
    if (!etag) throw new Error(`part ${n}: ETag が返らない`)
    return etag
}

async function complete(key: string, uploadId: string, parts: {n:number; etag:string}[]): Promise<void> {
    const xml =
        '<CompleteMultipartUpload>' +
        parts.map(p => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('') +
        '</CompleteMultipartUpload>'
    const res = await fetch(signUrl(`${key}?uploadId=${uploadId}`), {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },   // ★これが無いと AccessDenied
        body: xml,
    })
    if (!res.ok) throw new Error(`complete 失敗: ${res.status}\n${await res.text()}`)
}

async function abort(key: string, uploadId: string): Promise<void> {
    await fetch(signUrl(`${key}?uploadId=${uploadId}`), { method: 'DELETE' })
    console.error(`中断しました（uploadId=${uploadId}）`)
}

async function main() {
    const uploadId = await initiate(values.key!)
    console.log('UploadId =', uploadId)
    try {
        const parts = []
        for (let n = 1; n <= partCount; n++) {
            const start = (n - 1) * partSizeMB * 1024 * 1024
            const end = Math.min(n * partSizeMB * 1024 * 1024, buffer.length)
            const etag = await uploadPart(values.key!, uploadId, n, buffer.subarray(start, end))
            parts.push({ n, etag })
        }
        await complete(values.key!, uploadId, parts)
        console.log('✅ 完了')
    } catch (e) {
        await abort(values.key!, uploadId)
        throw e
    }
}

main().catch((e) => { console.error(e); process.exit(1) })
