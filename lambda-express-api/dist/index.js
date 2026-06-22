"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// const serverlessExpress = require('@vendia/serverless-express')
const express_1 = __importDefault(require("express"));
const serverless_http_1 = __importDefault(require("serverless-http"));
const promise_1 = __importDefault(require("mysql2/promise"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const swagger_jsdoc_1 = __importDefault(require("swagger-jsdoc"));
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const credential_providers_1 = require("@aws-sdk/credential-providers");
const app = (0, express_1.default)();
const swaggerSpec = (0, swagger_jsdoc_1.default)({
    definition: {
        openapi: '3.0.0',
        info: { title: 'Users API', version: '1.0.0' },
    },
    apis: [__filename],
});
const client = new client_secrets_manager_1.SecretsManagerClient({
    region: 'ap-northeast-1',
    credentials: (0, credential_providers_1.fromIni)({ profile: 'mvtk-refactoring' })
});
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
let pool;
async function getSecret() {
    const command = new client_secrets_manager_1.GetSecretValueCommand({ SecretId: 'handson/db' });
    const response = await client.send(command);
    if (!response.SecretString) {
        throw new Error('SecretString is empty');
    }
    return JSON.parse(response.SecretString);
}
async function getPool() {
    if (pool)
        return pool;
    const secret = await getSecret();
    pool = promise_1.default.createPool(secret);
    return pool;
}
function validateName(req, res, next) {
    if (!req.body.name || typeof req.body.name !== 'string' || !req.body.name.trim()) {
        return res.status(400).send({ message: 'name is required' });
    }
    if (req.body.name.trim().length > 255) {
        return res.status(400).send({ message: 'name is too long' });
    }
    next();
}
function validateId(req, res, next) {
    const id = Number(req.params.id);
    if (isNaN(id) || !Number.isInteger(id) || id < 1) {
        return res.status(400).send({ message: 'id must be a number' });
    }
    next();
}
app.use(express_1.default.json());
app.use('/api-docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swaggerSpec));
/**
 * @openapi
 * /health:
 *   get:
 *     summary: ヘルスチェック
 *     responses:
 *       200:
 *         description: OK
 */
app.get('/health', (req, res) => res.send({ "status": "ok" }));
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
app.get('/users', wrap(async (req, res) => {
    const [rows] = await (await getPool()).query('SELECT id, name FROM users');
    res.send(rows);
}));
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
app.get('/users/:id', validateId, wrap(async (req, res) => {
    const [rows] = await (await getPool()).query('SELECT id, name FROM users WHERE id = ?', [req.params.id]);
    if (rows[0]) {
        res.send(rows[0]);
    }
    else {
        res.status(404).send({ message: 'Not found' });
    }
}));
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
app.post('/users', validateName, wrap(async (req, res) => {
    const [result] = await (await getPool()).query('INSERT INTO users (name) VALUES (?)', [req.body.name]);
    res.status(201).send({ id: result.insertId, name: req.body.name });
}));
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
app.put('/users/:id', validateName, validateId, wrap(async (req, res) => {
    const [result] = await (await getPool()).query('UPDATE users SET name = ? WHERE id = ?', [req.body.name, req.params.id]);
    if (result.affectedRows === 0) {
        return res.status(404).send({ message: 'Not found' });
    }
    res.status(200).send({ id: req.params.id, name: req.body.name });
}));
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
app.delete('/users/:id', validateId, wrap(async (req, res) => {
    const [result] = await (await getPool()).query('DELETE FROM users WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
        return res.status(404).send({ message: 'Not found' });
    }
    res.status(204).send();
}));
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send({ message: 'Internal Server Error' });
});
if (require.main === module) {
    app.listen(3000, () => console.log('listening on http://localhost:3000'));
}
else {
    exports.handler = (0, serverless_http_1.default)(app);
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
//# sourceMappingURL=index.js.map