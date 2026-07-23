import express from "express";
import authRoutes from './routes/authRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import cors from 'cors'

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({limit:"100kb"}))

app.use(express.urlencoded({extended:true,limit:"100kb"}))

app.use(express.static("public"))

app.get('/', (req, res) => {
    res.send(`<h1> Hello World</h1>`);
});

app.use('/auth', authRoutes);

app.use('/projects', projectRoutes);

app.use(cors({
    origin: process.env.CORS_ORIGIN,
    credential: true,
    }),
);



export default app;