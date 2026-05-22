// MongoDB connection helper for KinderCura Step 1
// IMPORTANT: the connection string is read from .env using MONGODB_URI
// Example .env value: MONGODB_URI=mongodb://127.0.0.1:27017/kindercura
const mongoose = require('mongoose');
require('dotenv').config();

// Prevents duplicate reconnect attempts if connectDB() is called more than once
let isConnected = false;
// Guard: only register event listeners once per process lifetime
let listenersRegistered = false;

/**
 * Connect to MongoDB with retry/backoff and improved logging.
 * Throws the last error if all attempts fail.
 * @param {{retries?: number, delayMs?: number}} options
 */
async function connectDB({ retries = 5, delayMs = 1000 } = {}) {
    if (isConnected) return mongoose.connection;

    // This is where the app reads the MongoDB connection string.
    // 1) It first checks process.env.MONGODB_URI from your .env file.
    // 2) If that is missing, it falls back to the local default below.
    const mongoURI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/kindercura';

    // Keep Mongoose query behavior predictable.
    mongoose.set('strictQuery', true);

    // Detect serverless to apply tighter timeouts
    const isServerless = !!(process.env.VERCEL || process.env.NOW_REGION);

    const connectOptions = {
        autoIndex: true,
        // In serverless, fail fast instead of waiting 30 s (default)
        serverSelectionTimeoutMS: isServerless ? 4000 : 10000,
        socketTimeoutMS: isServerless ? 10000 : 30000,
        connectTimeoutMS: isServerless ? 4000 : 10000,
    };

    let attempt = 0;
    let lastError = null;

    while (attempt < retries) {
        attempt += 1;
        try {
            await mongoose.connect(mongoURI, connectOptions);
            isConnected = true;
            console.log('✅ Connected to MongoDB');

            // Only register listeners once — avoids memory leaks
            // on repeated warm-start calls.
            if (!listenersRegistered) {
                listenersRegistered = true;
                mongoose.connection.on('disconnected', () => {
                    console.warn('⚠️ MongoDB disconnected');
                    isConnected = false;
                });

                mongoose.connection.on('error', (err) => {
                    console.error('⚠️ MongoDB connection error:', err && err.stack ? err.stack : err);
                });
            }

            return mongoose.connection;
        } catch (err) {
            lastError = err;
            console.error(`❌ MongoDB connection failed (attempt ${attempt}/${retries}):`, err && err.stack ? err.stack : err);
            if (attempt >= retries) {
                console.error('❌ All MongoDB connection attempts failed.');
                throw lastError;
            }
            const backoff = delayMs * Math.pow(2, attempt - 1);
            console.log(`Retrying MongoDB connection in ${backoff}ms...`);
            await new Promise((res) => setTimeout(res, backoff));
        }
    }

    throw lastError;
}

module.exports = { connectDB, mongoose };
