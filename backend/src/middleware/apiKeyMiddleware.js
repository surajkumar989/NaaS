import Project from "../models/Project.js";
import { hashApiKey } from "../utils/apiKey.js";

const apiKeyMiddleware = async (req, res, next) => {
    try {
        const rawKey = req.headers["x-api-key"];

        if (!rawKey) {
            return res.status(401).json({ message: "Missing API key" });
        }

        const hashedKey = hashApiKey(rawKey);

        const project = await Project.findOne({ apiKey: hashedKey });
        if (!project) {
            return res.status(401).json({ message: "Invalid API key" });
        }

        req.project = project;
        next();
    } catch (error) {
        console.log("API key middleware error:", error);
        return res.status(500).json({ message: "Something went wrong verifying the API key" });
    }
};

export default apiKeyMiddleware;