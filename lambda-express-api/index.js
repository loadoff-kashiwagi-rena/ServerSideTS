// const serverlessExpress = require('@vendia/serverless-express')
const express = require('express')
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager')
const { fromIni } = require('@aws-sdk/credential-providers')
const app = express();
const serverless = require('serverless-http')
const mysql = require('mysql2/promise')

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

app.get('/health', (req, res) => res.send({"status":"ok"}));

app.get('/users', async (req, res) => {
    const [ rows ] = await (await getPool()).query('SELECT id, name FROM users')
    res.send(rows)
});

app.get('/users/:id',  async (req, res) => {
    const [ rows ] = await (await getPool()).query('SELECT id, name FROM users WHERE id = ?', [req.params.id])
    if (rows[0]) {
        res.send(rows[0])
    } else {
        res.status(404).send({ message: 'Not found' })
    }
});

app.post('/users', async (req, res) => {
    const [ result ] = await (await getPool()).query('INSERT INTO users (name) VALUES (?)', [req.body.name])
    res.status(201).send({ id: result.insertId, name: req.body.name })
});


if (require.main === module) {
    app.listen(3000, () => console.log('listening on http://localhost:3000'))
} else {
    exports.handler = serverless(app);
}


// exports.handler = serverlessExpress({ app }) // これはLambda用
