import Project from "../models/Project.js";
import { generateApiKey, hashApiKey } from "../utils/apiKey.js";
import { encrypt } from "../utils/encryption.js";

const createProject = async (req, res) => {
    try {
        const { projectName, fcmServiceAccount } = req.body;

        if (!projectName || !fcmServiceAccount) {
            return res.status(400).json({ message: "projectName and fcmServiceAccount are required" });
        }

        const { rawKey, hashedKey } = generateApiKey();

        const encryptedCredential = encrypt(JSON.stringify(fcmServiceAccount));

        const project = await Project.create({
            developerID: req.developer._id,   // matches schema's developerID
            projectname: projectName,          // matches schema's projectname
            apikey: hashedKey,                 // matches schema's apikey
            fcmServiceAccount: encryptedCredential,
        });

        return res.status(201).json({
            projectId: project._id,
            apiKey: rawKey, // shown ONCE — never retrievable again after this response
        });
    } catch (error) {
        console.log("Create project error:", error);
        return res.status(500).json({ message: "Something went wrong creating the project" });
    }
};

const getProjects = async (req, res) => {
    try {
        const projects = await Project.find({ developerID: req.developer._id })
            .select("-fcmServiceAccount -apikey");

        return res.status(200).json(projects);
    } catch (error) {
        console.log("Get projects error:", error);
        return res.status(500).json({ message: "Something went wrong fetching projects" });
    }
};

const regenerateApiKey = async (req, res) => {
    try {
        const project = await Project.findOne({
            _id: req.params.id,
            developerID: req.developer._id,
        });

        if (!project) {
            return res.status(404).json({ message: "Project not found" });
        }

        const { rawKey, hashedKey } = generateApiKey();

        project.apikey = hashedKey;
        await project.save();

        return res.status(200).json({ apiKey: rawKey });
    } catch (error) {
        console.log("Regenerate API key error:", error);
        return res.status(500).json({ message: "Something went wrong regenerating the API key" });
    }
};

export { createProject, getProjects, regenerateApiKey };