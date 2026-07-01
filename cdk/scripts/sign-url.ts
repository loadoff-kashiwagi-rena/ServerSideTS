import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from 'node:util'
import { getSignedUrl } from '@aws-sdk/cloudfront-signer'
import { loadEnv } from "../lib/load-env"

loadEnv()

const distDomain = process.env.DIST_DOMAIN
const publicKeyId = process.env.PUBLIC_KEY_ID

if (!distDomain || !publicKeyId) {
    console.error('env に DIST_DOMAIN と PUBLIC_KEY_ID を設定してください')
    process.exit(1)
}

const { values } = parseArgs({ options: {
    path: { type: 'string' },
    'expires-in': { type: 'string', default: '300'},
}})
if (!values.path) { 
    console.error('使い方：npm run sign -- --path <key> [--expires-in <sec>]')
    process.exit(1)
}

const privateKey = fs.readFileSync(path.join(__dirname, '..', 'keys', 'cf_private_key.pem'), 'utf8')
const url = `https://${distDomain}/${values.path.replace(/^\//, '')}`
const dateLessThan = new Date(Date.now() + Number(values['expires-in']) * 1000).toISOString()

console.log(getSignedUrl({ url, keyPairId: publicKeyId, privateKey, dateLessThan}))
