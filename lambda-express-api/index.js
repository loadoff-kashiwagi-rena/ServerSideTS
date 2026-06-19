// const serverlessExpress = require('@vendia/serverless-express')
const express = require('express')
const app = express();
const serverless = require('serverless-http')
const mysql = require('mysql2/promise')
const pool = mysql.createPool({
    host: '127.0.0.1',
    port: 3306,
    password: 'password',
    database: 'mysql'
})

app.use(express.json());

app.get('/health', (req, res) => res.send({"status":"ok"}));

app.get('/users', async (req, res) => {
    const [ rows ] = await pool.query('SELECT id, name FROM users')
    res.send(rows)
});

app.get('/users/:id', (req, res) => res.send({ id: req.params.id}));

app.post('/users', (req, res) => res.send(req.body));


if (require.main === module) {
    app.listen(3000, () => console.log('listening on http://localhost:3000'))
} else {
    exports.handler = serverless(app);
}


// exports.handler = serverlessExpress({ app }) // これはLambda用