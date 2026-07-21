import mongoose from 'mongoose'

const developerSchema=new mongoose.Schema(
    {
        name:{
            type:String,
            required:true,
            trim:true
        },
        email:{
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
        },
        passwordhash:{
            type:String,
            required:true
        }
    },
    {timestamps:true}
);

const Developer=mongoose.model("Developer",developerSchema);

export default Developer