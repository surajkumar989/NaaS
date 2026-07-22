import dotenv from 'dotenv';
dotenv.config();

import connectDB from './config/db.js';
import app from './app.js'
import { urlencoded } from 'express';

const PORT = process.env.PORT || 3000;

connectDB()
    .then(() => {
    app.listen(PORT, () => {
        console.log(`App listening on Port ${PORT}`);
    });
    })
    .catch((error) => {
    console.log("MongoDB connection failed !!!", error);
    process.exit(1);
    });


