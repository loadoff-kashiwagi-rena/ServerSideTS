// const serverlessExpress = require('@vendia/serverless-express')
const express = require('express')
const app = express();
const serverless = require('serverless-http')

app.use(express.json());

app.get('/health', (req, res) => res.send({"status":"ok"}));

app.get('/users', (req, res) => res.send([{ id: 1, name: "alice" }, { id: 2, name: "bob" }]));

app.get('/users/:id', (req, res) => res.send({ id: req.params.id}));

app.post('/users', (req, res) => res.send(req.body));


if (require.main === module) {
    app.listen(3000, () => console.log('listening on http://localhost:3000'))
} else {
    exports.handler = serverless(app);
}


// exports.handler = serverlessExpress({ app }) // これはLambda用