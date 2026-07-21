import mongoose from "mongoose";

const notificationLogSchema = new mongoose.Schema({

    projectId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Project",
        required: true,
    },
    deviceToken: {
        type: String,
        required: true,
    },
    title: {
        type: String,
        required: true,
    },
    body: {
        type: String,
        required: true,
    },
    status: {
        type: String,
        enum: ["queued", "sent", "failed"],
        default: "queued",
    },
    attempts: {
        type: Number,
        default: 0,
    },
    error: {
    type: String,
        default: null,
    },
    fcmMessageId: {
        type: String,
        default: null,
    },
    },
    { timestamps: true }, 
);


notificationLogSchema.index({ projectId: 1, createdAt: -1 }); // paginated log queries per project
notificationLogSchema.index({ status: 1 }); // analytics aggregation by status
notificationLogSchema.index(
    { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 90 },
); // TTL: auto-delete after 90 days

const NotificationLog = mongoose.model(
    "NotificationLog",
    notificationLogSchema,
);

export default NotificationLog;
