// === Extracted from PARENT\custom-questions.html (script block 1) ===
// Protect page and allow parents only

requireAuth();
const user = KC.user();
if (user && user.role !== 'parent') {
  if (user.role === 'pediatrician') window.location.href = '/pedia/pediatrician-dashboard.html';
  else if (user.role === 'admin') window.location.href = '/admin/admin-dashboard.html';
}

// Track selected child so assigned questions can be filtered
function safeRequestedChildId() {
  try {
    return typeof getRequestedChildId === 'function'
      ? getRequestedChildId()
      : new URLSearchParams(window.location.search).get('childId');
  } catch {
    return null;
  }
}

function storedChildId() {
  try { return typeof KC?.childId === 'function' ? KC.childId() : localStorage.getItem('kc_childId'); }
  catch { return localStorage.getItem('kc_childId'); }
}

function storedAssessmentId() {
  try { return typeof KC?.assessmentId === 'function' ? KC.assessmentId() : localStorage.getItem('kc_assessmentId'); }
  catch { return localStorage.getItem('kc_assessmentId'); }
}

function saveParentChildContext(childId, assessmentId = null) {
  if (typeof setParentContext === 'function') {
    setParentContext(childId, assessmentId);
    return;
  }
  if (childId) localStorage.setItem('kc_childId', childId);
  else localStorage.removeItem('kc_childId');
  if (assessmentId) localStorage.setItem('kc_assessmentId', assessmentId);
  else localStorage.removeItem('kc_assessmentId');
}

function updateParentNavLinks() {
  const childId = currentChildId !== 'all' ? currentChildId : storedChildId();
  const assessmentId = storedAssessmentId();
  const setHref = (selector, baseHref, includeAssessment = false) => {
    const link = document.querySelector(selector);
    if (!link) return;
    const q = new URLSearchParams();
    if (childId) q.set('childId', childId);
    if (includeAssessment && assessmentId) q.set('assessmentId', assessmentId);
    link.href = q.toString() ? `${baseHref}?${q.toString()}` : baseHref;
  };

  // Keep question navigation in sync with the active child filter.
  setHref('.main-nav a[href="/parent/dashboard.html"]', '/parent/dashboard.html');
  setHref('.main-nav a[href="/parent/results.html"]', '/parent/results.html', true);
  setHref('.main-nav a[href="/parent/recommendations.html"]', '/parent/recommendations.html', true);
  setHref('.main-nav a[href="/parent/appointments.html"]', '/parent/appointments.html');
  setHref('.main-nav a[href="/parent/custom-questions.html"]', '/parent/custom-questions.html');
}

let currentChildId = safeRequestedChildId() || storedChildId() || 'all';
let allChildren = [];

function flash(msg, ok = true) {
  const el = document.getElementById('flashMsg');
  el.style.display = 'block';
  el.style.padding = '0.9rem 1rem';
  el.style.borderRadius = '10px';
  el.style.background = ok ? '#dff3e7' : '#fde8e8';
  el.style.color = ok ? '#2d6a4f' : '#c0392b';
  el.textContent = msg;
  setTimeout(() => { el.style.display = 'none'; }, 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function encodeJsString(value) {
  return JSON.stringify(String(value ?? '')).replace(/"/g, '&quot;');
}

function hasAnswer(assignment) {
  return assignment && assignment.answer !== null && assignment.answer !== undefined && String(assignment.answer).trim() !== '';
}

function getAssignmentSetId(assignment) {
  const setObj = assignment?.questionSetId;
  if (setObj && typeof setObj === 'object' && setObj._id) return String(setObj._id);
  return assignment?.questionSetId ? String(assignment.questionSetId) : null;
}

function getAssignmentGroupKey(assignment) {
  const setId = getAssignmentSetId(assignment);
  if (!setId) return `standalone:${assignment.assignmentId}`;
  const childId = assignment?.childId ? String(assignment.childId) : 'unknown-child';
  const appointmentId = assignment?.appointmentId != null ? String(assignment.appointmentId) : 'no-appointment';
  return `set:${setId}|child:${childId}|appointment:${appointmentId}`;
}

// Load every child of the logged-in parent
async function loadChildren() {
  const data = await apiFetch('/children');
  allChildren = data.children || [];

  const picker = document.getElementById('childPicker');
  picker.innerHTML = '<option value="all">All children</option>';

  if (!allChildren.length) {
    document.getElementById('childNameLine').textContent = 'No child registered';
    document.getElementById('questionSummary').textContent = 'Please add a child first in your profile.';
    return [];
  }

  allChildren.forEach(child => {
    picker.innerHTML += `<option value="${child.id}">${esc(child.firstName)} ${esc(child.lastName)}</option>`;
  });

  const exists = allChildren.some(c => String(c.id) === String(currentChildId));
  if (!exists && currentChildId !== 'all') currentChildId = allChildren.length === 1 ? allChildren[0].id : 'all';
  if (currentChildId === 'all' && allChildren.length === 1) currentChildId = allChildren[0].id;

  picker.value = currentChildId;
  if (currentChildId !== 'all') saveParentChildContext(currentChildId, storedAssessmentId());
  updateHeaderLine();
  updateParentNavLinks();
  return allChildren;
}

function updateHeaderLine() {
  if (!allChildren.length) {
    document.getElementById('childNameLine').textContent = 'No child registered';
    return;
  }

  if (currentChildId === 'all') {
    document.getElementById('childNameLine').textContent = `All children (${allChildren.length})`;
  } else {
    const active = allChildren.find(c => String(c.id) === String(currentChildId));
    document.getElementById('childNameLine').textContent = active
      ? `${active.firstName} ${active.lastName}`
      : 'Selected child';
  }
}

function openAppointmentsPage() {
  const childId = currentChildId !== 'all' ? currentChildId : storedChildId();
  if (childId) saveParentChildContext(childId, storedAssessmentId());
  window.location.href = childId
    ? `/parent/appointments.html?childId=${encodeURIComponent(childId)}`
    : '/parent/appointments.html';
}

// Change visible questions based on selected child
function changeChildFilter() {
  currentChildId = document.getElementById('childPicker').value;
  if (currentChildId !== 'all') saveParentChildContext(currentChildId, storedAssessmentId());
  updateHeaderLine();
  updateParentNavLinks();
  loadAssignedQuestions();
}

// Build the answer input based on question type
function buildAnswerInput(a, groupKey) {
  const options = Array.isArray(a.options) ? a.options : [];
  const currentAnswer = hasAnswer(a) ? String(a.answer).trim() : '';
  const safeGroupKey = esc(groupKey);

  if (a.questionType === 'yes_no') {
    return `
      <div class="choice-row" id="choices_${a.assignmentId}">
        <button class="choice-btn${currentAnswer === 'Yes' ? ' selected' : ''}" type="button" onclick="selectChoice(${a.assignmentId}, ${encodeJsString('Yes')})">Yes</button>
        <button class="choice-btn${currentAnswer === 'No' ? ' selected' : ''}" type="button" onclick="selectChoice(${a.assignmentId}, ${encodeJsString('No')})">No</button>
      </div>
      <input type="hidden" data-group-key="${safeGroupKey}" id="answer_${a.assignmentId}" value="${esc(currentAnswer)}">
    `;
  }

  if (a.questionType === 'multiple_choice') {
    return `
      <div class="choice-row" id="choices_${a.assignmentId}">
        ${options.map(opt => `
          <button class="choice-btn${currentAnswer === String(opt).trim() ? ' selected' : ''}" type="button" onclick="selectChoice(${a.assignmentId}, ${encodeJsString(opt)})">${esc(opt)}</button>
        `).join('')}
      </div>
      <input type="hidden" data-group-key="${safeGroupKey}" id="answer_${a.assignmentId}" value="${esc(currentAnswer)}">
    `;
  }

  return `<textarea class="text-answer" data-group-key="${safeGroupKey}" id="answer_${a.assignmentId}" placeholder="Type your answer here...">${esc(currentAnswer)}</textarea>`;
}

// Group pending assignments by questionSetId
function groupAssignmentsBySet(assignments) {
  const grouped = new Map();
  
  assignments.forEach(a => {
    const setId = getAssignmentSetId(a);
    if (!setId) return;

    const setObj = a.questionSetId;
    const groupKey = getAssignmentGroupKey(a);
    const setTitle = a.setTitle || ((setObj && setObj.title) ? setObj.title : null);
    
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        groupKey,
        setId,
        setTitle,
        questions: [],
        childId: a.childId,
        childName: a.childName,
        appointmentId: a.appointmentId ?? null,
        pediatricianName: a.pediatricianName
      });
    }
    grouped.get(groupKey).questions.push(a);
  });
  
  return Array.from(grouped.values()).map(group => {
    const questions = group.questions.slice().sort((a, b) => Number(a.questionId || 0) - Number(b.questionId || 0));
    const answeredCount = questions.filter(hasAnswer).length;
    const lastActivity = questions.reduce((latest, q) => {
      const ts = new Date(q.answeredAt || q.createdAt || 0).getTime();
      return Number.isFinite(ts) ? Math.max(latest, ts) : latest;
    }, 0);

    return {
      ...group,
      questions,
      answeredCount,
      totalCount: questions.length,
      isComplete: questions.length > 0 && answeredCount === questions.length,
      lastActivity
    };
  }).sort((a, b) => b.lastActivity - a.lastActivity);
}

function renderPendingStandalone(a) {
  return `
    <div class="question-card">
      <div class="meta-badges">
        <span class="badge badge-child">${esc(a.childName || 'Child')}</span>
        <span class="badge badge-domain">${esc(a.domain || 'Other')}</span>
        <span class="badge badge-type">${esc((a.questionType || '').replace('_',' / '))}</span>
        <span class="badge badge-state">Pending</span>
      </div>
      <p style="font-weight:700;font-size:1rem;margin:.1rem 0 .4rem;">${esc(a.questionText)}</p>
      <p style="font-size:.82rem;color:var(--text-light);margin:.15rem 0 .7rem;">Assigned by: Dr. ${esc(a.pediatricianName || 'Pediatrician')}</p>
      <div class="answer-box">${buildAnswerInput(a, getAssignmentGroupKey(a))}</div>
      <div style="margin-top:1rem;display:flex;justify-content:flex-end;">
        <button class="btn btn-primary" onclick="submitAnswer(${a.assignmentId})">Submit Answer</button>
      </div>
    </div>
  `;
}

function renderAnsweredSet(group) {
  const answeredAt = group.questions.find(hasAnswer)?.answeredAt;
  return `
    <div class="page-card" style="border-left:4px solid #2d6a4f;">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:1rem;margin-bottom:1rem;">
        <div style="flex:1;">
          <h4 style="margin:0 0 .25rem;font-size:1rem;color:var(--status-positive-fg);">${esc(group.setTitle || `Question Set (${group.totalCount})`)}</h4>
          <p style="margin:0;font-size:.8rem;color:var(--text-light);">For ${esc(group.childName || 'Child')} | From Dr. ${esc(group.pediatricianName || 'Pediatrician')} | ${group.totalCount} question${group.totalCount !== 1 ? 's' : ''}</p>
        </div>
        <span style="background:var(--status-positive-bg);color:var(--status-positive-fg);border-radius:8px;padding:.25rem .6rem;font-size:.75rem;font-weight:700;">Answered</span>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:1rem;">
        ${group.questions.map((a, index) => `
          <div class="question-card" style="margin-bottom:1rem;">
            <div class="meta-badges">
              <span class="badge badge-domain">${esc(a.domain || 'Other')}</span>
              <span class="badge badge-type">${esc((a.questionType || '').replace('_',' / '))}</span>
              <span class="badge badge-done">Q${index + 1}</span>
            </div>
            <p style="font-weight:700;font-size:.95rem;margin:.2rem 0 .5rem;">${esc(a.questionText)}</p>
            <div style="background:var(--bg-primary);border-radius:10px;padding:.9rem 1rem;">
              <p style="margin:0 0 .25rem;font-size:.8rem;color:var(--text-light);">Your answer</p>
              <p style="margin:0;font-weight:600;">${esc(a.answer || '')}</p>
            </div>
          </div>
        `).join('')}
      </div>

      <p style="margin:0;font-size:.78rem;color:var(--text-light);">Answered at: ${answeredAt ? new Date(answeredAt).toLocaleString() : '-'}</p>
    </div>
  `;
}

// Show grouped questions that still need answers (one card per question set)
function renderPending(setGroups, standaloneAssignments) {
  const el = document.getElementById('pendingList');
  if (!setGroups.length && !standaloneAssignments.length) {
    el.innerHTML = '<div class="empty-state">No pending custom questions right now.</div>';
    return;
  }
  
  const groupedHtml = setGroups.map(group => {
    const questions = group.questions;
    const totalCount = group.totalCount;
    const setTitle = group.setTitle || `Question Set (${group.totalCount} ${group.totalCount === 1 ? 'question' : 'questions'})`;

    return `
      <div class="page-card" style="border-left:4px solid var(--primary);">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:1rem;margin-bottom:1rem;">
          <div style="flex:1;">
            <h4 style="margin:0 0 .25rem;font-size:1rem;color:var(--primary);">📋 ${esc(setTitle)}</h4>
            <p style="margin:0;font-size:.8rem;color:var(--text-light);">From Dr. ${esc(questions[0]?.pediatricianName || 'Pediatrician')} • ${totalCount} question${totalCount !== 1 ? 's' : ''}</p>
          </div>
          <span style="background:var(--status-caution-bg);color:var(--status-caution-fg);border-radius:8px;padding:.25rem .6rem;font-size:.75rem;font-weight:700;">Pending</span>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:1rem;">
          ${questions.map(a => `
            <div class="question-card" style="margin-bottom:1rem;">
              <div style="display:flex;justify-content:space-between;align-items:start;gap:.5rem;margin-bottom:.6rem;">
                <div style="flex:1;">
                  <span class="badge badge-domain" style="margin-bottom:.4rem;display:inline-block;">${esc(a.domain || 'Other')}</span>
                  <span class="badge badge-type" style="margin-bottom:.4rem;display:inline-block;">${esc((a.questionType || '').replace('_',' / '))}</span>
                  <p style="font-weight:700;font-size:.95rem;margin:.4rem 0 .2rem;">${esc(a.questionText)}</p>
                </div>
              </div>
              <div class="answer-box">${buildAnswerInput(a, group.groupKey)}</div>
            </div>
          `).join('')}
        </div>

        <div style="border-top:1px solid var(--border);padding-top:1rem;display:flex;justify-content:flex-end;gap:.6rem;flex-wrap:wrap;">
          <button class="btn btn-secondary" onclick="clearSetAnswers('${group.groupKey}')">Clear Answers</button>
          <button class="btn btn-primary" onclick="submitSetAnswers('${group.groupKey}', '${group.setId}')">Submit Complete Set</button>
        </div>
      </div>
    `;
  }).join('');

  const standaloneHtml = standaloneAssignments.map(renderPendingStandalone).join('');
  el.innerHTML = groupedHtml + standaloneHtml;
}

// Show questions that the parent already answered
function renderAnswered(setGroups, standaloneAssignments) {
  const el = document.getElementById('answeredList');
  if (!setGroups.length && !standaloneAssignments.length) {
    el.innerHTML = '<div class="empty-state">No answered custom questions yet.</div>';
    return;
  }

  const groupedHtml = setGroups.map(renderAnsweredSet).join('');
  const standaloneHtml = standaloneAssignments.map(a => `
    <div class="question-card">
      <div class="meta-badges">
        <span class="badge badge-child">${esc(a.childName || 'Child')}</span>
        <span class="badge badge-domain">${esc(a.domain || 'Other')}</span>
        <span class="badge badge-type">${esc((a.questionType || '').replace('_',' / '))}</span>
        <span class="badge badge-done">Answered</span>
      </div>
      <p style="font-weight:700;font-size:1rem;margin:.1rem 0 .4rem;">${esc(a.questionText)}</p>
      <p style="font-size:.82rem;color:var(--text-light);margin:.15rem 0 .7rem;">Assigned by: Dr. ${esc(a.pediatricianName || 'Pediatrician')}</p>
      <div style="background:var(--bg-primary);border-radius:10px;padding:.9rem 1rem;">
        <p style="margin:0 0 .25rem;font-size:.8rem;color:var(--text-light);">Your answer</p>
        <p style="margin:0;font-weight:600;">${esc(a.answer || '')}</p>
      </div>
      <p style="margin:.7rem 0 0;font-size:.78rem;color:var(--text-light);">Answered at: ${a.answeredAt ? new Date(a.answeredAt).toLocaleString() : '—'}</p>
    </div>
  `).join('');

  el.innerHTML = groupedHtml + standaloneHtml;
}

// Save a selected choice to the hidden answer field
function selectChoice(assignmentId, value) {
  const hidden = document.getElementById(`answer_${assignmentId}`);
  if (hidden) hidden.value = value;

  const wrap = document.getElementById(`choices_${assignmentId}`);
  if (!wrap) return;
  wrap.querySelectorAll('.choice-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.textContent.trim() === String(value).trim());
  });
}

// Submit one answer back to the backend (legacy support for standalone questions)
async function submitAnswer(assignmentId) {
  const input = document.getElementById(`answer_${assignmentId}`);
  const answer = input ? input.value.trim() : '';
  if (!answer) {
    flash('Please answer the question first.', false);
    return;
  }

  try {
    await apiFetch(`/questions/answer/${assignmentId}`, {
      method: 'POST',
      body: JSON.stringify({ answer })
    });
    flash('Answer submitted successfully.');
    await loadAssignedQuestions();
  } catch (e) {
    flash(e.message, false);
  }
}

// Clear all answers for a question set (UI only)
function clearSetAnswers(groupKey) {
  if (!confirm('Clear all answers in this set? Your progress will be lost.')) return;
  
  const allInputs = document.querySelectorAll(`[data-group-key="${groupKey}"][id^="answer_"]`);
  if (!allInputs.length) {
    flash('This question set is no longer available.', false);
    return;
  }

  allInputs.forEach(input => {
    input.value = '';
    const choicesContainer = document.getElementById(`choices_${input.id.replace('answer_', '')}`);
    if (choicesContainer) {
      choicesContainer.querySelectorAll('.choice-btn').forEach(btn => btn.classList.remove('selected'));
    }
  });
  
  flash('Answers cleared for this set.');
}

// Submit all answers for a question set at once (batch submission)
async function submitSetAnswers(groupKey, setId) {
  const allInputs = Array.from(document.querySelectorAll(`[data-group-key="${groupKey}"][id^="answer_"]`));
  if (!allInputs.length) {
    flash('This question set is no longer available.', false);
    return;
  }

  const answers = [];
  
  allInputs.forEach(input => {
    const answer = input.value.trim();
    const assignmentId = input.id.replace('answer_', '');
    
    answers.push({
      assignmentId: Number(assignmentId),
      answer
    });
  });
  
  const missingAnswers = answers.filter(item => !item.answer);
  if (missingAnswers.length > 0) {
    flash(`Please answer all ${allInputs.length} question${allInputs.length !== 1 ? 's' : ''} in this set before submitting.`, false);
    return;
  }
  
  try {
    await apiFetch(`/questions/set/${setId}/answer-batch`, {
      method: 'POST',
      body: JSON.stringify({ answers })
    });
    
    flash(`✓ All ${answers.length} answer${answers.length !== 1 ? 's' : ''} submitted successfully!`);
    await loadAssignedQuestions();
  } catch (e) {
    flash(`Error submitting answers: ${e.message}`, false);
  }
}

// Load all assigned custom questions for the parent
async function loadAssignedQuestions() {
  try {
    await loadChildren();

    if (!allChildren.length) {
      document.getElementById('pendingList').innerHTML = '<div class="empty-state">No child found.</div>';
      document.getElementById('answeredList').innerHTML = '<div class="empty-state">No child found.</div>';
      return;
    }

    const targetChildren = currentChildId === 'all'
      ? allChildren
      : allChildren.filter(c => String(c.id) === String(currentChildId));

    const bundles = await Promise.all(
      targetChildren.map(async child => {
        const data = await apiFetch(`/questions/assigned/${child.id}`);
        return (data.assignments || []).map(a => ({
          ...a,
          childId: child.id,
          childName: `${child.firstName} ${child.lastName}`
        }));
      })
    );

    const assignments = bundles.flat().sort((a, b) => {
      const da = new Date(a.answeredAt || a.createdAt || 0).getTime();
      const db = new Date(b.answeredAt || b.createdAt || 0).getTime();
      return db - da;
    });

    const setAssignments = assignments.filter(a => !!getAssignmentSetId(a));
    const standaloneAssignments = assignments.filter(a => !getAssignmentSetId(a));
    const groupedSets = groupAssignmentsBySet(setAssignments);
    const pendingSetGroups = groupedSets.filter(group => !group.isComplete);
    const answeredSetGroups = groupedSets.filter(group => group.isComplete);
    const pendingStandalone = standaloneAssignments.filter(a => !hasAnswer(a));
    const answeredStandalone = standaloneAssignments.filter(a => hasAnswer(a));

    const pendingCount = pendingSetGroups.length + pendingStandalone.length;
    const answeredCount = answeredSetGroups.length + answeredStandalone.length;
    const pending = { length: pendingCount };
    const answered = { length: answeredCount };

    const summaryLabel = currentChildId === 'all'
      ? `Across ${targetChildren.length} child${targetChildren.length > 1 ? 'ren' : ''}`
      : `For selected child`;

    document.getElementById('questionSummary').textContent = `${summaryLabel} | ${pendingCount} pending | ${answeredCount} answered`;

    document.getElementById('questionSummary').textContent = `${summaryLabel} · ${pending.length} pending · ${answered.length} answered`;
    document.getElementById('questionSummary').textContent = `${summaryLabel} | ${pendingCount} pending | ${answeredCount} answered`;
    updateParentNavLinks();
    renderPending(pendingSetGroups, pendingStandalone);
    renderAnswered(answeredSetGroups, answeredStandalone);
  } catch (e) {
    document.getElementById('questionSummary').textContent = 'Could not load custom questions.';
    document.getElementById('pendingList').innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
    document.getElementById('answeredList').innerHTML = '<div class="empty-state">—</div>';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initNav();
  document.querySelectorAll('a.logout').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  }));
  loadAssignedQuestions();
});
