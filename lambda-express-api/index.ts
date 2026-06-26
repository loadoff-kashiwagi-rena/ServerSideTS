// const serverlessExpress = require('@vendia/serverless-express')
import express, { RequestHandler, Request, Response, NextFunction } from 'express'
import serverLess from 'serverless-http'
import mysql, { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import swaggerUi from 'swagger-ui-express'
import swaggerJsDoc from 'swagger-jsdoc'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { fromIni } from '@aws-sdk/credential-providers'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
const app = express()

const swaggerSpec = swaggerJsDoc({
    definition: {
        openapi: '3.0.0',
        info: { title: 'Users API', version: '1.0.0' },
    },
    apis: [__filename],
})

// Lambda 上では実行ロールの認証情報を使う（環境変数 AWS_LAMBDA_FUNCTION_NAME で判定）。
// ローカルでは ~/.aws のプロファイルを使う。
const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME
const client = new SecretsManagerClient({
    region: 'ap-northeast-1',
    ...(isLambda ? {} : { credentials: fromIni({ profile: 'mvtk-refactoring' }) }),
})

// mp4 アップロード用 S3。presigned URL（署名付きアップロードURL）の発行に使う。
// 発行自体はローカル計算で S3 への通信は発生しない。実アップロードはクライアントが
// このURLへ直接 PUT する（API Gateway / Lambda を経由しない）。
const UPLOAD_BUCKET = 'handson-mp4-upload-698031349306'
const s3 = new S3Client({
    region: 'ap-northeast-1',
    // ローカルは ~/.aws のプロファイル（AWS_PROFILE があればそれ、無ければ mvtk-refactoring）。
    ...(isLambda
        ? {}
        : { credentials: fromIni({ profile: process.env.AWS_PROFILE ?? 'mvtk-refactoring' }) }),
})

const wrap =
    (handler: RequestHandler): RequestHandler =>
    (req, res, next) =>
        Promise.resolve(handler(req, res, next)).catch(next)

let pool: mysql.Pool | undefined

async function getSecret() {
    const secretId = 'handson/db'
    try {
        const command = new GetSecretValueCommand({ SecretId: secretId })
        const response = await client.send(command)
        if (!response.SecretString) {
            throw new Error('SecretString is empty')
        }
        console.log(JSON.stringify({ level: 'info', event: 'getSecret.success', secretId }))
        return JSON.parse(response.SecretString)
    } catch (e) {
        console.error(
            JSON.stringify({
                level: 'error',
                event: 'getSecret.failed',
                secretId,
                error: String(e),
            }),
        )
        throw e
    }
}

async function getPool() {
    if (pool) return pool
    try {
        const secret = await getSecret()
        pool = mysql.createPool(secret)
        console.log(JSON.stringify({ level: 'info', event: 'getPool.created' }))
        return pool
    } catch (e) {
        console.error(JSON.stringify({ level: 'error', event: 'getPool.failed', error: String(e) }))
        throw e
    }
}

/**
 * RDS内の複数クエリを1つのトランザクションでまとめて実行する。
 * callback内が正常に終わればcommit、例外が投げられればrollbackする。
 * 取得したコネクションはどの経路でも必ずreleaseされる。
 *
 * @example
 * const id = await withTransaction(async (conn) => {
 *     const [r] = await conn.query<ResultSetHeader>('INSERT INTO users (name) VALUES (?)', [name])
 *     await conn.query('INSERT INTO profiles (user_id, url) VALUES (?, ?)', [r.insertId, url])
 *     return r.insertId
 * })
 */
// 今後のトランザクション系エンドポイント（複数テーブルへの書き込み等）で使用予定。
// 使い始めたらこの oxlint-disable は削除する。
// oxlint-disable-next-line no-unused-vars
async function withTransaction<T>(
    callback: (conn: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
    const conn = await (await getPool()).getConnection()
    try {
        await conn.beginTransaction()
        const result = await callback(conn)
        await conn.commit()
        console.log(JSON.stringify({ level: 'info', event: 'withTransaction.commit' }))
        return result
    } catch (e) {
        await conn.rollback()
        console.error(
            JSON.stringify({ level: 'error', event: 'withTransaction.rollback', error: String(e) }),
        )
        throw e
    } finally {
        conn.release()
    }
}

function validateName(req: Request, res: Response, next: NextFunction) {
    if (!req.body.name || typeof req.body.name !== 'string' || !req.body.name.trim()) {
        return res.status(400).send({ message: 'name is required' })
    }
    if (req.body.name.trim().length > 255) {
        return res.status(400).send({ message: 'name is too long' })
    }
    return next()
}

function validateId(req: Request, res: Response, next: NextFunction) {
    const id = Number(req.params.id)
    if (isNaN(id) || !Number.isInteger(id) || id < 1) {
        return res.status(400).send({ message: 'id must be a number' })
    }
    return next()
}

app.use(express.json())

app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now()
    res.on('finish', () => {
        console.log(
            JSON.stringify({
                level: 'info',
                event: 'access',
                method: req.method,
                path: req.originalUrl,
                status: res.statusCode,
                durationMs: Date.now() - start,
            }),
        )
    })
    next()
})

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))

/**
 * @openapi
 * /health:
 *   get:
 *     summary: ヘルスチェック
 *     responses:
 *       200:
 *         description: OK
 */
app.get('/health', (req, res) => res.send({ status: 'ok' }))

/**
 * @openapi
 * /uploads/presign:
 *   post:
 *     summary: mp4アップロード用の presigned URL を発行
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               filename:
 *                 type: string
 *     responses:
 *       200:
 *         description: 署名付きアップロードURL
 */
app.post(
    '/uploads/presign',
    wrap(async (req, res) => {
        const filename = req.body?.filename
        if (!filename || typeof filename !== 'string' || !filename.trim()) {
            return res.status(400).send({ message: 'filename is required' })
        }
        // S3 内での保存先（キー）。uploads/ 配下にまとめる。
        const key = `uploads/${filename.trim()}`
        // 「このバケットに、このキーで、video/mp4 を PUT してよい」という許可。
        const command = new PutObjectCommand({
            Bucket: UPLOAD_BUCKET,
            Key: key,
            ContentType: 'video/mp4',
        })
        // 300秒だけ有効な署名付き PUT URL。クライアントはこのURLへ直接アップロードする。
        const url = await getSignedUrl(s3, command, { expiresIn: 300 })
        console.log(JSON.stringify({ level: 'info', event: 'presign.issued', key }))
        res.send({ url, key, expiresIn: 300 })
    }),
)

/**
 * @openapi
 * /users:
 *   get:
 *     summary: ユーザー一覧取得
 *     responses:
 *       200:
 *         description: ユーザーの配列
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 */
app.get(
    '/users',
    wrap(async (req, res) => {
        const [rows] = await (await getPool()).query('SELECT id, name FROM users')
        res.send(rows)
    }),
)

/**
 * @openapi
 * /users/{id}:
 *   get:
 *     summary: ユーザー1件取得
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: ユーザー
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       404:
 *         description: Not found
 */
app.get(
    '/users/:id',
    validateId,
    wrap(async (req, res) => {
        const [rows] = await (
            await getPool()
        ).query<RowDataPacket[]>('SELECT id, name FROM users WHERE id = ?', [req.params.id])
        if (rows[0]) {
            res.send(rows[0])
        } else {
            res.status(404).send({ message: 'Not found' })
        }
    }),
)

/**
 * @openapi
 * /users:
 *   post:
 *     summary: ユーザー作成
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserInput'
 *     responses:
 *       201:
 *         description: 作成されたユーザー
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 */
app.post(
    '/users',
    validateName,
    wrap(async (req, res) => {
        const [result] = await (
            await getPool()
        ).query<ResultSetHeader>('INSERT INTO users (name) VALUES (?)', [req.body.name])
        res.status(201).send({ id: result.insertId, name: req.body.name })
    }),
)

/**
 * @openapi
 * /users/{id}:
 *   put:
 *     summary: ユーザー更新
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserInput'
 *     responses:
 *       200:
 *         description: 更新されたユーザー
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       404:
 *         description: Not found
 */
app.put(
    '/users/:id',
    validateName,
    validateId,
    wrap(async (req, res) => {
        const [result] = await (
            await getPool()
        ).query<ResultSetHeader>('UPDATE users SET name = ? WHERE id = ?', [
            req.body.name,
            req.params.id,
        ])
        if (result.affectedRows === 0) {
            return res.status(404).send({ message: 'Not found' })
        }
        return res.status(200).send({ id: req.params.id, name: req.body.name })
    }),
)

/**
 * @openapi
 * /users/{id}:
 *   delete:
 *     summary: ユーザー削除
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       204:
 *         description: 削除成功
 *       404:
 *         description: Not found
 */
app.delete(
    '/users/:id',
    validateId,
    wrap(async (req, res) => {
        const [result] = await (
            await getPool()
        ).query<ResultSetHeader>('DELETE FROM users WHERE id = ?', [req.params.id])
        if (result.affectedRows === 0) {
            return res.status(404).send({ message: 'Not found' })
        }
        return res.status(204).send()
    }),
)

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    console.error(
        JSON.stringify({
            level: 'error',
            event: 'unhandledError',
            method: req.method,
            path: req.originalUrl,
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
        }),
    )
    res.status(500).send({ message: 'Internal Server Error' })
})

if (require.main === module) {
    app.listen(3000, () => console.log('listening on http://localhost:3000'))
} else {
    exports.handler = serverLess(app)
}

// exports.handler = serverlessExpress({ app }) // これはLambda用

/**
 * @openapi
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           example: 1
 *         name:
 *           type: string
 *           example: 山田太郎
 *     UserInput:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         name:
 *           type: string
 *           example: 山田太郎
 */
