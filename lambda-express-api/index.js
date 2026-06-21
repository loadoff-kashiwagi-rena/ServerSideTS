// const serverlessExpress = require('@vendia/serverless-express')
const express = require('express')
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager')
const { fromIni } = require('@aws-sdk/credential-providers')
const app = express();
const serverless = require('serverless-http')
const mysql = require('mysql2/promise')
const swaggerUi = require('swagger-ui-express')
const swaggerJsdoc = require('swagger-jsdoc')

const swaggerSpec = swaggerJsdoc({
    definition: {
        openapi: '3.0.0',
        info: { title: 'Users API', version: '1.0.0' },
    },
    apis: [__filename],
})

const client = new SecretsManagerClient({
    region: 'ap-northeast-1',
    credentials: fromIni({ profile: 'mvtk-refactoring' })
})

let pool

async function getSecret() {
    const command = new GetSecretValueCommand({ SecretId: 'handson/db'})
    const response = await client.send(command)
    return JSON.parse(response.SecretString)
}

async function getPool() {
    if (pool) return pool
    const secret = await getSecret()
    pool = mysql.createPool(secret)
    return pool
}

app.use(express.json());

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))

if (require.main === module) {
    app.listen(3000, () => console.log('listening on http://localhost:3000'))
} else {
    exports.handler = serverless(app);
}

/**
 * @openapi
 * /health:
 *   get:
 *     summary: ヘルスチェック
 *     responses:
 *       200:
 *         description: OK
 */
app.get('/health', (req, res) => res.send({"status":"ok"}));

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
app.get('/users', async (req, res) => {
    const [ rows ] = await (await getPool()).query('SELECT id, name FROM users')
    res.send(rows)
});

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
app.get('/users/:id',  async (req, res) => {
    const [ rows ] = await (await getPool()).query('SELECT id, name FROM users WHERE id = ?', [req.params.id])
    if (rows[0]) {
        res.send(rows[0])
    } else {
        res.status(404).send({ message: 'Not found' })
    }
});

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
app.post('/users', async (req, res) => {
    const [ result ] = await (await getPool()).query('INSERT INTO users (name) VALUES (?)', [req.body.name])
    res.status(201).send({ id: result.insertId, name: req.body.name })
});

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
app.put('/users/:id', async (req, res) => {
    const [ result ] = await (await getPool()).query('UPDATE users SET name = ? WHERE id = ?', [req.body.name, req.params.id])
    if (result.affectedRows === 0) {
        return res.status(404).send({ message: 'Not found' })
    }
    res.status(200).send({ id: req.params.id, name: req.body.name })
})

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
app.delete('/users/:id', async (req, res) => {
    const [ result ] = await (await getPool()).query('DELETE FROM users WHERE id = ?', [req.params.id])
    if (result.affectedRows === 0) {
        return res.status(404).send({ message: 'Not found' })
    }
    res.status(204).send()
})


if (require.main === module) {
    app.listen(3000, () => console.log('listening on http://localhost:3000'))
} else {
    exports.handler = serverless(app);
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
