// const serverlessExpress = require('@vendia/serverless-express')
const app = require('express')()

app.get('/health', (req, res) => res.send({"status":"ok"}));

app.listen(3000, () => console.log('listening on http://localhost:3000'))


// exports.handler = serverlessExpress({ app }) // これはLambda用