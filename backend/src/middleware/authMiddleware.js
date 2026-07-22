// src/middleware/authMiddleware.js
import jwt from "jsonwebtoken";
import Developer from "../models/Developer.js";

const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ message: "No token provided" });
        }

        const token = authHeader.split(" ")[1];

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const developer = await Developer.findById(decoded.developerId).select("-passwordhash");
        if (!developer) {
            return res.status(401).json({ message: "Developer no longer exists" });
        }

        req.developer = developer;
        next();
    } catch (error) {
        return res.status(401).json({ message: "Invalid or expired token" });
    }
};

export default authMiddleware;