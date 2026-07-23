import crypto from "crypto";

const generateApiKey = () => {
    const rawKey = `naas_${crypto.randomBytes(24).toString("hex")}`;
    const hashedKey = crypto.createHash("sha256").update(rawKey).digest("hex");
    return { rawKey, hashedKey };
};

const hashApiKey = (rawKey) => {
    return crypto.createHash("sha256").update(rawKey).digest("hex");
};

export { generateApiKey, hashApiKey };