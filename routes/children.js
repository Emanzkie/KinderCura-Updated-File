// Child routes converted to MongoDB
// These routes are used by dashboard.html and profile.html to load/add child records
const express = require('express');
const Child = require('../models/Child');
const GuardianLink = require('../models/GuardianLink');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Compare only the calendar date so duplicate child checks stay simple
function sameDay(a, b) {
    return new Date(a).toISOString().split('T')[0] === new Date(b).toISOString().split('T')[0];
}

// Return all children the caller can access:
//  - Parents  → their own children (parentId match) + children from active GuardianLink
//  - Admins   → all children
//  - Guardians → children from active guardian links
async function getAccessibleChildren(userId, userRole) {
  let childIds = new Set();

  // Own children (parentId match) for parent-role users
  if (userRole === 'parent') {
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
        const { firstName, middleName, lastName, dateOfBirth, gender, relationship } = req.body;

        if (!firstName || !lastName || !dateOfBirth) {
            return res.status(400).json({ error: 'First name, last name, and date of birth are required.' });
        }

        const cleanFirst = String(firstName).trim();
        const cleanLast = String(lastName).trim();
        const dob = new Date(dateOfBirth);

        const existing = await Child.findOne({
            parentId: req.user.userId,
            firstName: new RegExp(`^${cleanFirst}$`, 'i'),
            lastName: new RegExp(`^${cleanLast}$`, 'i'),
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
