import mongoose from "mongoose";

const projectSchema=new mongoose.Schema({
    developerID:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Developer",
        required:true,
    },
    projectname:{
        type:String,
        required:true,
        trim:true,
    },
    apikey:{
        type:String,
        required:true,
        unique:true,
    },
    fcmServiceAccount:{
        type:String,
        required:true,
    }
},{timestamps:true});

const Project = mongoose.model("Project",projectSchema)

export default Project;