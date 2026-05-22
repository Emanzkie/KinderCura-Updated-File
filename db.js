// db.js — MongoDB connection helper optimized for Vercel serverless
// - Requires `MONGODB_URI` (no localhost fallback)
// - Uses cached connection promise stored on `global` to avoid duplicate connects
// - Short retries suitable for serverless (default: 2)
// - Fast-fail timeouts: serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000
const mongoose = require('mongoose');
require('dotenv').config();

const DEFAULT_RETRIES = 2;
const DEFAULT_DELAY_MS = 500;

// Persist a small cache on the global object so warm invocations reuse it.
const globalAny = global;
if (!globalAny.__mongooseGlobal) {
    globalAny.__mongooseGlobal = { conn: null, promise: null, listenersRegistered: false };
}
const cached = globalAny.__mongooseGlobal;

mongoose.set('strictQuery', true);

/**
 * Connect to MongoDB with a serverless-friendly cached promise.
 * Throws a clear error if `MONGODB_URI` is not provided.
 * @param {{retries?: number, delayMs?: number}} options
 */
async function connectDB({ retries = DEFAULT_RETRIES, delayMs = DEFAULT_DELAY_MS } = {}) {
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) {
        throw new Error('MONGODB_URI environment variable is required. Set it in Vercel project settings.');
    }

    if (cached.conn) return cached.conn;
    if (cached.promise) return cached.promise;

    const connectOptions = {
        autoIndex: true,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        connectTimeoutMS: 5000,
    };

    // Build a single promise that performs a small number of retries.
    cached.promise = (async () => {
        let attempt = 0;
        let lastError = null;
        while (attempt < retries) {
            attempt += 1;
            try {
                await mongoose.connect(mongoURI, connectOptions);
                cached.conn = mongoose.connection;

                if (!cached.listenersRegistered) {
                    cached.listenersRegistered = true;
                    mongoose.connection.on('disconnected', () => {
                        console.warn('⚠️ MongoDB disconnected');
                        cached.conn = null;
                    });
                    mongoose.connection.on('error', (err) => {
                        console.error('⚠️ MongoDB connection error:', err && err.stack ? err.stack : err);
                    });
                }

                console.log('✅ Connected to MongoDB');
                return cached.conn;
            } catch (err) {
                lastError = err;
                console.error(`❌ MongoDB connection failed (attempt ${attempt}/${retries}):`, err && err.stack ? err.stack : err);
                if (attempt >= retries) break;
                const backoff = delayMs * Math.pow(2, attempt - 1);
                await new Promise((res) => setTimeout(res, backoff));
            }
        }

        // Allow future calls to try again.
        cached.promise = null;
        throw lastError;
    })();

    return cached.promise;
}

module.exports = { connectDB, mongoose };
