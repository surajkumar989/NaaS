import { Router } from "express";
import { createProject, getProjects, regenerateApiKey } from "../controllers/projectController.js";
import authMiddleware from "../middleware/authMiddleware.js";

const router = Router();

router.use(authMiddleware); // every route below requires a logged-in developer

router.post("/", createProject);
router.get("/", getProjects);
router.post("/:id/regenerate-key", regenerateApiKey);

export default router;