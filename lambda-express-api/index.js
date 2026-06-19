// const serverlessExpress = require('@vendia/serverless-express')
const express = require('express')
const app = express();
const serverless = require('serverless-http')
const mysql = require('mysql2/promise')
const pool = mysql.createPool({
    host: '127.0.0.1',
    port: 3306,
    password: 'password',
    database: 'handson',
    user: 'root',
})

app.use(express.json());

app.get('/health', (req, res) => res.send({"status":"ok"}));

app.get('/users', async (req, res) => {
    const [ rows ] = await pool.query('SELECT id, name FROM users')
    res.send(rows)
});

app.get('/users/:id',  async (req, res) => {
    const [ rows ] = await pool.query('SELECT id, name FROM users WHERE id = ?', [req.params.id])
    if (rows[0]) {
        res.send(rows[0])
    } else {
        res.status(404).send({ message: 'Not found' })
    }
});

app.post('/users', async (req, res) => {
    const [ result ] = await pool.query('INSERT INTO users (name) VALUES (?)', [req.body.name])
    res.status(201).send({ id: result.insertId, name: req.body.name })
});


if (require.main === module) {
    app.listen(3000, () => console.log('listening on http://localhost:3000'))
} else {
    exports.handler = serverless(app);
}


// exports.handler = serverlessExpress({ app }) // これはLambda用
