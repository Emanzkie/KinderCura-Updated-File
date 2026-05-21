// api/index.js — Vercel serverless wrapper for the Express `app`
const serverless = require('serverless-http');
const app = require('../server');
const { connectDB } = require('../db');

const handler = serverless(app);

module.exports = async (req, res) => {
    if (!global.__kc_db_connected) {
        try {
            await connectDB();
            global.__kc_db_connected = true;
        } catch (e) {
            console.error('DB connection failed in serverless function:', e && e.stack ? e.stack : e);
        }
    }

    return handler(req, res);
};
