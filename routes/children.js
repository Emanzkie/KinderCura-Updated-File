// Child routes converted to MongoDB
// These routes are used by dashboard.html and profile.html to load/add child records
const express = require('express');
const mongoose = require('mongoose');
const Child = require('../models/Child');
const GuardianLink = require('../models/GuardianLink');
const { authMiddleware } = require('../middleware/auth');
const childAge = require('../js/shared/child-age');

const router = express.Router();

// Names are matched literally in the duplicate check, so characters such as
// "(" or "." in a valid name never act as regex syntax.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Compare only the calendar date so duplicate child checks stay simple
function sameDay(a, b) {
    return new Date(a).toISOString().split('T')[0] === new Date(b).toISOString().split('T')[0];
}

// Account roles on the parent side; any of them can own a child (Child.parentId).
const PARENT_SIDE_ROLES = ['parent', 'legal_guardian', 'foster_parent', 'court_appointed'];

// Return all children the caller can access:
//  - Parent-side roles → their own children (parentId match) + children from active GuardianLink
//  - Admins   → all children
//  - Guardians → children from active guardian links
async function getAccessibleChildren(userId, userRole) {
  let childIds = new Set();

  // Own children (parentId match). Checking for 'parent' alone hid a
  // legal_guardian's own registered child from them.
  if (PARENT_SIDE_ROLES.includes(userRole)) {
    const own = await Child.find({ parentId: userId }).sort({ createdAt: -1 }).select('+profileIcon').lean();
    own.forEach(c => childIds.add(String(c._id)));
  }

  // Linked children via GuardianLink for any user role
  const links = await GuardianLink.find({ guardianId: userId, status: 'active' }).lean();
  if (links.length) {
    links.forEach(l => childIds.add(String(l.childId)));
  }

  if (childIds.size === 0) {
    if (userRole === 'admin') return await Child.find({}).sort({ createdAt: -1 }).select('+profileIcon').lean();
    return [];
  }

  return await Child.find({ _id: { $in: [...childIds].map(id => id) } }).sort({ createdAt: -1 }).select('+profileIcon').lean();
}

// Return one child document only if the caller has access to it.
async function getAccessibleChild(childId, userId, userRole) {
  const child = await Child.findOne({ _id: childId }).lean();
  if (!child) return null;

  // Admin can access any child
  if (userRole === 'admin') return child;

  // Own child (parentId match)
  if (String(child.parentId) === String(userId)) return child;

  // Check GuardianLink
  const link = await GuardianLink.findOne({ childId: child._id, guardianId: userId, status: 'active' }).lean();
  if (link) return child;

  return null;
}

// Load all children the logged-in user can access.
// GET /api/children
router.get('/', authMiddleware, async (req, res) => {
    try {
        const children = await getAccessibleChildren(req.user.userId, req.user.role);
        
        const normalized = children.map(c => ({
            id: String(c._id),
            firstName: c.firstName || '',
            middleName: c.middleName || '',
            lastName: c.lastName || '',
            dateOfBirth: c.dateOfBirth,
            gender: c.gender || '',
            relationship: c.relationship || '',
            profileIcon: c.profileIcon || 'child1',  // Ensure default value
            parentId: String(c.parentId)
        }));
        
        res.json({ success: true, children: normalized });
    } catch (err) {
        console.error('Error fetching children:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add a new child for the logged-in parent
// POST /api/children/register
router.post('/register', authMiddleware, async (req, res) => {
    try {
        // A child belongs to the account that registers it (Child.parentId),
        // so only parent-side accounts may register one. Pediatricians,
        // secretaries and admins could otherwise create children under their
        // own accounts.
        if (!PARENT_SIDE_ROLES.includes(req.user.role)) {
            return res.status(403).json({ error: 'Only parent accounts can register a child.' });
        }

        const { firstName, middleName, lastName, dateOfBirth, gender, relationship } = req.body;

        if (!firstName || !lastName || !dateOfBirth) {
            return res.status(400).json({ error: 'First name, last name, and date of birth are required.' });
        }

        // Same 3-8 year rule as sign-up (js/shared/child-age.js).
        const ageCheck = childAge.checkChildAge(dateOfBirth, childAge.todayInTimeZone(childAge.CLINIC_TIME_ZONE));
        if (!ageCheck.ok) {
            return res.status(400).json({ error: ageCheck.message });
        }

        const cleanFirst = String(firstName).trim();
        const cleanLast = String(lastName).trim();
        const dob = new Date(dateOfBirth);

        const existing = await Child.findOne({
            parentId: req.user.userId,
            firstName: new RegExp(`^${escapeRegex(cleanFirst)}$`, 'i'),
            lastName: new RegExp(`^${escapeRegex(cleanLast)}$`, 'i'),
        });

        if (existing && sameDay(existing.dateOfBirth, dob)) {
            return res.status(409).json({ error: 'This child is already registered for this parent.' });
        }

        const child = await Child.create({
            parentId: req.user.userId,
            firstName: cleanFirst,
            middleName: middleName ? String(middleName).trim() : null,
            lastName: cleanLast,
            dateOfBirth: dob,
            gender: gender || null,
            relationship: relationship || null,
        });

        res.status(201).json({
            success: true,
            childId: String(child._id),
            message: 'Child registered successfully.',
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const CHILD_NAME_MAX_LENGTH = 80;
const CHILD_GENDERS = ['male', 'female', 'other'];

// Edit a child's name and gender. Owner only (Child.parentId); linked
// guardians cannot rename a child. Date of birth is deliberately not
// editable: it decides screening eligibility and every stored result's age.
// PUT /api/children/:childId
router.put('/:childId', authMiddleware, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(String(req.params.childId))) {
            return res.status(404).json({ error: 'Child not found.' });
        }
        const child = await Child.findById(req.params.childId);
        if (!child) return res.status(404).json({ error: 'Child not found.' });
        if (String(child.parentId) !== String(req.user.userId)) {
            return res.status(403).json({ error: 'Only the parent who registered this child can edit their details.' });
        }

        const { firstName, middleName, lastName, gender } = req.body;
        const clean = (v) => String(v ?? '').trim();
        const next = {
            firstName: firstName !== undefined ? clean(firstName) : child.firstName,
            middleName: middleName !== undefined ? (clean(middleName) || null) : child.middleName,
            lastName: lastName !== undefined ? clean(lastName) : child.lastName,
            gender: gender !== undefined ? (clean(gender).toLowerCase() || null) : child.gender,
        };

        if (!next.firstName || !next.lastName) {
            return res.status(400).json({ error: 'First name and last name are required.' });
        }
        if ([next.firstName, next.middleName, next.lastName].some((n) => n && n.length > CHILD_NAME_MAX_LENGTH)) {
            return res.status(400).json({ error: `Names must be ${CHILD_NAME_MAX_LENGTH} characters or fewer.` });
        }
        if (next.gender !== null && !CHILD_GENDERS.includes(next.gender)) {
            return res.status(400).json({ error: 'Gender must be male, female or other.' });
        }

        // Same duplicate rule as registration: one parent cannot hold two
        // children with the same name and date of birth.
        const twin = await Child.findOne({
            _id: { $ne: child._id },
            parentId: child.parentId,
            firstName: new RegExp(`^${escapeRegex(next.firstName)}$`, 'i'),
            lastName: new RegExp(`^${escapeRegex(next.lastName)}$`, 'i'),
        });
        if (twin && sameDay(twin.dateOfBirth, child.dateOfBirth)) {
            return res.status(409).json({ error: 'Another child with this name and date of birth is already registered.' });
        }

        Object.assign(child, next);
        await child.save();

        res.json({
            success: true,
            child: {
                id: String(child._id),
                firstName: child.firstName,
                middleName: child.middleName || '',
                lastName: child.lastName,
                dateOfBirth: child.dateOfBirth,
                gender: child.gender || '',
                relationship: child.relationship || '',
                profileIcon: child.profileIcon || 'child1',
                parentId: String(child.parentId),
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Load one child by id, but only if the caller has access to it.
// GET /api/children/:childId
router.get('/:childId', authMiddleware, async (req, res) => {
    try {
        const child = await getAccessibleChild(req.params.childId, req.user.userId, req.user.role);
        if (!child) {
            return res.status(404).json({ error: 'Child not found.' });
        }

        res.json({ 
            success: true, 
            child: { 
                ...child, 
                id: String(child._id),
                profileIcon: child.profileIcon || 'child1'  // Ensure default
            } 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
