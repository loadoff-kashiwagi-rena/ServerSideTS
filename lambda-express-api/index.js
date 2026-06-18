const serverlessExpress = require('@vendia/serverless-express')
const app = require('express')()

app.use('/health', (req, res) => res.send({"status":"ok"}));

app.listen(3000)


exports.handler = serverlessExpress({ app })