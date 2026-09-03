// Child model
// Each child document belongs to one parent user through parentId
const mongoose = require('mongoose');
const { SYNTHETIC_FIELDS } = require('../constants/syntheticData');

const childSchema = new mongoose.Schema(
    {
        parentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        firstName: { type: String, required: true, trim: true },
        middleName: { type: String, trim: true, default: null },
        lastName: { type: String, required: true, trim: true },
        dateOfBirth: { type: Date, required: true },
        gender: {
            type: String,
            enum: ['male', 'female', 'other', null],
            default: null,
        },
        relationship: { type: String, trim: true, default: null },
        profileIcon: { type: String, default: 'child1' },
        // Additive: references to GuardianLink documents for multi-guardian support.
        guardianLinks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'GuardianLink' }],

        // Synthetic/demo marker — false/null on every real child record.
        // Only scripts/generate-system-demo-data.js ever sets it, and it is the
        // only key its purge path matches on. See constants/syntheticData.js.
        ...SYNTHETIC_FIELDS,
    },
    // timestamps: true automatically creates createdAt and updatedAt
    { timestamps: true }
);

module.exports = mongoose.models.Child || mongoose.model('Child', childSchema);
