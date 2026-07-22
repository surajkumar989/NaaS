// src/controllers/authController.js
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Developer from "../models/Developer.js";

const SALT_ROUNDS = 10;

const signup = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ message: "name, email, and password are all required" });
        }

        const existingDeveloper = await Developer.findOne({ email });
        if (existingDeveloper) {
            return res.status(409).json({ message: "An account with this email already exists" });
        }

        const passwordhash = await bcrypt.hash(password, SALT_ROUNDS);
        await Developer.create({ name, email, passwordhash });

        return res.status(201).json({ message: "Account created" });
    } catch (error) {
        console.log("Signup error:", error);
        return res.status(500).json({ message: "Something went wrong during signup" });
    }
};

const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: "email and password are required" });
        }

        const developer = await Developer.findOne({ email });
        if (!developer) {
            return res.status(401).json({ message: "Invalid email or password" });
        }

        const isPasswordCorrect = await bcrypt.compare(password, developer.passwordhash);
        if (!isPasswordCorrect) {
            return res.status(401).json({ message: "Invalid email or password" });
        }

        const token = jwt.sign(
            { developerId: developer._id },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        return res.status(200).json({ token });
    } catch (error) {
        console.log("Login error:", error);
        return res.status(500).json({ message: "Something went wrong during login" });
    }
};

export { signup, login };