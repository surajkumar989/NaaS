import dotenv from 'dotenv';
dotenv.config();
import connectDB from './config/db.js';
import express from'express'

await connectDB();

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => {
    res.send(`
        <h1> Hello World</h1>
        ${process.env.PORT}
        <h1> MONGODB CONNECTED!!</h1>
    `);
});

app.listen(PORT, () => {
    console.log(`App listening on Port ${PORT}`);
});
