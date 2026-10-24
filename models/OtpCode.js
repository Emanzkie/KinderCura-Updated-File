// OTP model
// Stores temporary email verification codes before registration finishes
const mongoose = require('mongoose');

const otpCodeSchema = new mongoose.Schema(
    {
        email: { type: String, required: true, trim: true, lowercase: true, index: true },
        code: { type: String, required: true, trim: true },
        expiresAt: { type: Date, required: true },
        used: { type: Boolean, default: false },
        // 'password_reset' rows hold a sha256 of a 6-digit code and must never
        // satisfy signup verification. Rows written before this field existed
        // have no purpose and are signup codes.
        purpose: { type: String, enum: ['signup', 'password_reset'], default: 'signup' },
        // Wrong guesses against a password-reset code; the row is voided at 5.
        attempts: { type: Number, default: 0 },
        // When a signup code was accepted by /verify-otp. /register only trusts
        // a recent verification; rows from before this field are never trusted.
        verifiedAt: { type: Date, default: null },
    },
    // Only keep createdAt because OTP rows do not need updatedAt
    { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.models.OtpCode || mongoose.model('OtpCode', otpCodeSchema);
