// === Extracted from PARENT\profile.html (script block 1) ===
// API, KC, apiFetch, requireAuth, logout, initNav and toggleProfileMenu come
// from /api.js, which profile.html loads first. This page used to redefine
// them, so logging out here cleared only 4 of the kc_* keys.

document.addEventListener('click', (e) => {
    if (!e.target.closest('.profile-btn')) {
        const m = document.getElementById('profileMenu');
        if (m) m.style.display = 'none';
    }
});

/* ─────────────────────────────────────────────
   profile.html page logic
───────────────────────────────────────────── */
requireAuth();

// Upload parent or child profile picture
// type = 'parent' or 'child'
// childId is only needed when uploading a child's photo
async function uploadProfilePhoto(input, type, childId) {
    const file = input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', file);
    const url = type === 'child' ? `/upload/child/${childId}` : '/upload/profile';
    try {
        const res  = await fetch(`${API}${url}`, { method:'POST', headers:{Authorization:`Bearer ${KC.token()}`}, body:fd });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Upload failed');

        if (type === 'child') {
            const childPic = document.getElementById(`childProfilePic_${childId}`);
            if (childPic) childPic.src = data.path;
        } else {
            const parentPic = document.getElementById('parentProfilePic');
            if (parentPic) parentPic.src = data.path;
            const user = KC.user() || {};
            user.profileIcon = data.path;
            localStorage.setItem('kc_user', JSON.stringify(user));
            document.querySelectorAll('.profile-icon').forEach(img => {
                img.src = data.path;
                img.style.borderRadius = '50%';
                img.style.objectFit = 'cover';
            });
        }

        await loadProfile();
        if (typeof initNav === 'function') initNav();
        alert('Photo updated successfully!');
    } catch(e) {
        alert('Upload failed: ' + e.message);
    }
}

// Small helper to render one read-only info row
function field(label, value) {
    return `<div class="field-row">
        <p class="field-label">${label}</p>
        <p class="field-value">${value || '—'}</p>
    </div>`;
}

function calcAge(dob) {
    const d = new Date(dob), now = new Date();
    let y = now.getFullYear() - d.getFullYear(), m = now.getMonth() - d.getMonth();
    if (m < 0) { y--; m += 12; }
    return y > 0 ? `${y} yr${y>1?'s':''} ${m} mo` : `${m} month${m!==1?'s':''}`;
}

// Load parent profile + child list from MongoDB routes
// This is the main function that fills the page after login
async function loadProfile() {
    console.log('[loadProfile] Starting...');
    let user = KC.user();
    try {
        const userData = await apiFetch('/auth/me');
        console.log('[loadProfile] User data from API:', userData);
        if (userData && userData.user) {
            const cached = KC.user() || {};
            const mergedUser = { ...cached, ...userData.user };
            // Preserve uploaded avatar if server returns default/non-uploaded icon
            if (
                cached.profileIcon &&
                String(cached.profileIcon).startsWith('/uploads/') &&
                (
                    !mergedUser.profileIcon ||
                    !String(mergedUser.profileIcon).startsWith('/uploads/')
                )
            ) {
                mergedUser.profileIcon = cached.profileIcon;
            }
            user = mergedUser;
            localStorage.setItem('kc_user', JSON.stringify(mergedUser));
        }
    } catch(e) { 
        console.error('[loadProfile] Could not fetch fresh user data:', e.message); 
    }

    if (user) {
        console.log('[loadProfile] Setting parent fields for user:', user.firstName, user.lastName);
        const hasUpload = user.profileIcon && String(user.profileIcon).startsWith('/uploads/');
        const profileSrc = hasUpload ? user.profileIcon : '/icons/profile.png';
        const srcSuffix = hasUpload ? `?t=${Date.now()}` : '';

        if (hasUpload) {
            const pic = document.getElementById('parentProfilePic');
            if (pic) pic.src = user.profileIcon;
        }

        const navPic = document.getElementById('navProfilePic');
        if (navPic) {
            navPic.src = profileSrc + srcSuffix;
            navPic.style.objectFit = 'cover';
        }

        document.querySelectorAll('.profile-icon').forEach(img => {
            if (img.id === 'navProfilePic') return;
            img.src = profileSrc + srcSuffix;
            img.style.borderRadius = '50%';
            img.style.objectFit = 'cover';
        });
        document.getElementById('parentFields').innerHTML =
            field('Name', [user.firstName, user.middleName, user.lastName].filter(Boolean).join(' ')) +
            field('Email', user.email) +
            field('Username', user.username) +
            field('Account Type', user.role.charAt(0).toUpperCase()+user.role.slice(1));
        document.getElementById('editFirst').value = user.firstName || '';
        document.getElementById('editLast').value  = user.lastName || '';
    } else {
        console.warn('[loadProfile] No user data available');
    }

    try {
        console.log('[loadProfile] Fetching children...');
        const data = await apiFetch('/children');
        console.log('[loadProfile] Children data from API:', data);
        const children = data.children;
        if (children && children.length) {
            // Keep the currently selected child if it still exists.
            const savedChildId = localStorage.getItem('kc_childId');
            const hasSavedChild = children.some(c => c.id === savedChildId);
            if (!hasSavedChild) {
                localStorage.setItem('kc_childId', children[0].id);
            }
            let html = '';
            const me = String((KC.user() || {}).id || '');
            children.forEach((c) => {
                // Only the registering parent may edit; linked children are read-only here.
                const canEdit = me && String(c.parentId) === me;
                const dob = new Date(c.dateOfBirth);
                const childPic = c.profileIcon && c.profileIcon.startsWith('/uploads/') ? c.profileIcon : '/icons/profile.png';
                html += `
                <div class="child-card">
                    <div class="child-card-left">
                        <div class="child-photo-upload">
                            <img id="childProfilePic_${c.id}" src="${childPic}" alt="Child profile photo">
                            <label for="childPhotoUpload_${c.id}" class="child-photo-edit" title="Change photo"></label>
                            <input type="file" id="childPhotoUpload_${c.id}" accept="image/*" style="display:none;" onchange="uploadProfilePhoto(this,'child','${c.id}')">
                        </div>
                        <label for="childPhotoUpload_${c.id}" class="child-photo-hint">Click to update photo</label>
                    </div>
                    <div class="child-card-right">
                        <div class="fields-grid">
                            ${field('Name', [c.firstName, c.middleName, c.lastName].filter(Boolean).join(' '))}
                            ${field('Date of Birth', dob.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}))}
                            ${field('Age', calcAge(c.dateOfBirth))}
                            ${field('Gender', c.gender ? c.gender.charAt(0).toUpperCase()+c.gender.slice(1) : '—')}
                            ${field('Relationship', c.relationship || '—')}
                        </div>
                        <button class="btn btn-primary btn-full-small" onclick="localStorage.setItem('kc_childId','${c.id}');window.location.href='/parent/screening.html'">Start Assessment</button>
                        ${canEdit ? `<button type="button" class="btn btn-secondary btn-full-small" style="margin-top:.5rem;" onclick="toggleEditChild('${c.id}')">Edit Details</button>
                        <div id="editChildForm_${c.id}" class="add-child-form">
                            <h3 class="form-title">Edit Child Details</h3>
                            <div id="editChildErr_${c.id}" class="err-msg" role="alert"></div>
                            <p class="hint-text">Date of birth cannot be changed here because it decides which screening questions apply.</p>
                            <div class="form-group"><label for="editChildFirst_${c.id}">First Name</label><input type="text" id="editChildFirst_${c.id}" maxlength="80" value="${escapeHtml(c.firstName)}"></div>
                            <div class="form-group"><label for="editChildMiddle_${c.id}">Middle Name (Optional)</label><input type="text" id="editChildMiddle_${c.id}" maxlength="80" value="${escapeHtml(c.middleName)}"></div>
                            <div class="form-group"><label for="editChildLast_${c.id}">Last Name</label><input type="text" id="editChildLast_${c.id}" maxlength="80" value="${escapeHtml(c.lastName)}"></div>
                            <div class="form-group">
                                <label for="editChildGender_${c.id}">Gender</label>
                                <select id="editChildGender_${c.id}">
                                    ${[['', 'Not specified'], ['male', 'Male'], ['female', 'Female'], ['other', 'Other']]
                                        .map(([v, label]) => `<option value="${v}"${(c.gender || '') === v ? ' selected' : ''}>${label}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-row">
                                <button type="button" id="saveChildBtn_${c.id}" class="btn btn-primary btn-half" onclick="saveChild('${c.id}')">Save</button>
                                <button type="button" class="btn btn-secondary btn-half" onclick="toggleEditChild('${c.id}')">Cancel</button>
                            </div>
                        </div>` : ''}
                    </div>
                </div>`;
            });
            document.getElementById('childFields').innerHTML = html;
        } else {
            document.getElementById('childFields').innerHTML = '<p class="hint-text" style="text-align:center;">No child registered yet.</p>';
        }
    } catch (e) {
        console.error('Child load error:', e);
        document.getElementById('childFields').innerHTML = `<p style="color:var(--text-light);text-align:center;padding:1rem;">Could not load child info.</p>`;
    }
}

function toggleEditParent() {
    const form = document.getElementById('editParentForm');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
}
function toggleChangePassword() {
    const form = document.getElementById('changePasswordForm');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
}
function toggleEditChild(childId) {
    const form = document.getElementById(`editChildForm_${childId}`);
    if (form) form.style.display = form.style.display === 'block' ? 'none' : 'block';
}

// Save a child's edited name and gender to PUT /api/children/:childId
async function saveChild(childId) {
    const err = document.getElementById(`editChildErr_${childId}`);
    const btn = document.getElementById(`saveChildBtn_${childId}`);
    err.style.display = 'none';
    const firstName = document.getElementById(`editChildFirst_${childId}`).value.trim();
    const middleName = document.getElementById(`editChildMiddle_${childId}`).value.trim();
    const lastName = document.getElementById(`editChildLast_${childId}`).value.trim();
    const gender = document.getElementById(`editChildGender_${childId}`).value;
    if (!firstName || !lastName) {
        err.textContent = 'First name and last name are required.';
        err.style.display = 'block';
        return;
    }
    btn.disabled = true;
    try {
        await apiFetch(`/children/${encodeURIComponent(childId)}`, {
            method: 'PUT',
            body: JSON.stringify({ firstName, middleName, lastName, gender }),
        });
        await loadProfile();
    } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
        btn.disabled = false;
    }
}

function showAddChildForm() {
    document.getElementById('addChildForm').style.display = 'block';
}

// Save edited parent name fields to /api/auth/update-profile
async function saveParentProfile() {
    const err = document.getElementById('editErr');
    err.style.display = 'none';
    const firstName = document.getElementById('editFirst').value.trim();
    const lastName  = document.getElementById('editLast').value.trim();
    if (!firstName || !lastName) { err.textContent='Name is required.'; err.style.display='block'; return; }
    try {
        const data = await apiFetch('/auth/update-profile', {
            method:'PUT',
            body: JSON.stringify({ firstName, lastName })
        });
        if (data.user) {
            localStorage.setItem('kc_user', JSON.stringify(data.user));
        }
        toggleEditParent();
        await loadProfile();
        alert('Profile updated!');
    } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
    }
}

// Save a new password to /api/auth/change-password
async function changePassword() {
    const err = document.getElementById('pwErr');
    err.style.display = 'none';
    const current = document.getElementById('currentPw').value;
    const pw  = document.getElementById('newPw').value;
    const cpw = document.getElementById('confirmPw').value;
    if (!current) { err.textContent='Enter your current password.'; err.style.display='block'; return; }
    if (pw.length < 8) { err.textContent='Password must be at least 8 characters.'; err.style.display='block'; return; }
    if (pw !== cpw)    { err.textContent='Passwords do not match.'; err.style.display='block'; return; }
    try {
        await apiFetch('/auth/change-password', {
            method:'PUT',
            body: JSON.stringify({ currentPassword: current, password: pw })
        });
        document.getElementById('currentPw').value = '';
        document.getElementById('newPw').value = '';
        document.getElementById('confirmPw').value = '';
        alert('Password changed successfully!');
        toggleChangePassword();
    } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
    }
}

// Add another child using the MongoDB children route
// After saving the new child, immediately open that child's pre-assessment.
async function addChild() {
    const err = document.getElementById('addChildErr');
    err.style.display = 'none';

    const firstName    = document.getElementById('newChildFirst').value.trim();
    const middleName   = document.getElementById('newChildMiddle').value.trim();
    const lastName     = document.getElementById('newChildLast').value.trim();
    const dateOfBirth  = document.getElementById('newChildDob').value;
    const gender       = document.getElementById('newChildGender').value;
    const relationship = document.getElementById('newChildRelationship').value.trim();

    if (!firstName || !lastName || !dateOfBirth) {
        err.textContent = 'First name, last name and date of birth are required.';
        err.style.display = 'block';
        return;
    }

    try {
        const data = await apiFetch('/children/register', {
            method: 'POST',
            body: JSON.stringify({
                firstName,
                middleName: middleName || null,
                lastName,
                dateOfBirth,
                gender: gender || null,
                relationship: relationship || null
            })
        });

        // Save the new child as the active child, then go straight to screening.
        if (data.childId) {
            localStorage.setItem('kc_childId', data.childId);
            localStorage.setItem('kc_viewChildId', data.childId);
        }
        localStorage.removeItem('kc_assessmentId');
        window.location.href = '/parent/screening.html';
    } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
    }
}

// Page startup
// 1) check login
// 2) fill nav
// 3) load profile data
document.addEventListener('DOMContentLoaded', () => {
    initNav();
    document.querySelectorAll('a.logout').forEach(a => {
        a.addEventListener('click', e => { e.preventDefault(); logout(); });
    });
    loadProfile();
});
