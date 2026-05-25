# Fix Parent Dashboard Assessment Flickering

## File: `js/parent/dashboard.js`

### Change 1 — Add tracking variables (after line 23)

Replace:
```js
let _switcherSignature = null;
```

With:
```js
let _switcherSignature = null;
let _dashboardLoadCounter = 0;
let _lastRenderedChildId = null;
```

### Change 2 — Replace `loadDashboard()` body (lines 115–141)

Replace everything from:
```js
    // Reset placeholders so stale data from a previously-selected child does
    // not linger on-screen while the new child's assessments are being fetched.
    document.getElementById('skillList').innerHTML = '<p class="text-center text-muted">No assessment yet</p>';
    document.getElementById('assessmentBox').innerHTML = '<p class="text-center text-muted" style="padding:1rem;">No assessment yet</p>';
    document.getElementById('recList').innerHTML = '<p class="text-center text-muted">No recommendations yet</p>';

    if (childId) {
        try {
            const hist = await apiFetch(`/assessments/${childId}/history`);
            const assessments = (hist.assessments || []).filter(a => a.overallScore !== null);
            if (assessments.length > 0) {
                const latest = assessments[0];
                localStorage.setItem('kc_assessmentId', latest.id);
                renderSkills(latest);
                renderAssessment(latest);
                try {
                    const recs = await apiFetch(`/recommendations/${latest.id}`);
                    renderRecs(recs.recommendations || []);
                } catch {}
            } else {
                localStorage.removeItem('kc_assessmentId');
            }
        } catch {}
    }
```

With:
```js
    // Clear stale data only when the active child changed — avoids flicker on
    // the 5-second interval poll when the same child is still selected.
    const childChanged = String(childId) !== String(_lastRenderedChildId);
    if (childChanged) {
        document.getElementById('skillList').innerHTML = '<p class="text-center text-muted">Loading assessment data...</p>';
        document.getElementById('assessmentBox').innerHTML = '<p class="text-center text-muted" style="padding:1rem;">Loading assessment data...</p>';
        document.getElementById('recList').innerHTML = '<p class="text-center text-muted">Loading recommendations...</p>';
    }

    if (childId) {
        console.log('[PARENT_DASHBOARD] Fetch latest assessment', { childId, loadId });
        try {
            const hist = await apiFetch(`/assessments/${childId}/history`);
            console.log('[PARENT_DASHBOARD] Response received', { childId, loadId });

            // Ignore stale response from a previous loadDashboard call
            if (loadId !== _dashboardLoadCounter) {
                console.log('[PARENT_DASHBOARD] Stale response ignored', { loadId, current: _dashboardLoadCounter });
                return;
            }

            const assessments = (hist.assessments || []).filter(a => a.overallScore !== null);
            if (assessments.length > 0) {
                const latest = assessments[0];
                localStorage.setItem('kc_assessmentId', latest.id);
                renderSkills(latest);
                renderAssessment(latest);
                _lastRenderedChildId = String(childId);
                console.log('[PARENT_DASHBOARD] Valid assessment rendered', { childId, assessmentId: latest.id, loadId });
                try {
                    const recs = await apiFetch(`/recommendations/${latest.id}`);
                    renderRecs(recs.recommendations || []);
                } catch {}
            } else {
                _lastRenderedChildId = String(childId);
                if (childChanged) {
                    document.getElementById('skillList').innerHTML = '<p class="text-center text-muted">No assessment yet</p>';
                    document.getElementById('assessmentBox').innerHTML = '<p class="text-center text-muted" style="padding:1rem;">No assessment yet</p>';
                }
                localStorage.removeItem('kc_assessmentId');
                console.log('[PARENT_DASHBOARD] Empty response handled', { childId, loadId });
            }
        } catch (err) {
            console.log('[PARENT_DASHBOARD] Fetch error', { childId, loadId, error: err.message });
            if (loadId === _dashboardLoadCounter && childChanged) {
                document.getElementById('skillList').innerHTML = '<p class="text-center text-muted">No assessment yet</p>';
                document.getElementById('assessmentBox').innerHTML = '<p class="text-center text-muted" style="padding:1rem;">No assessment yet</p>';
                _lastRenderedChildId = String(childId);
            }
        }
    }
```

### Change 3 — Add `loadId` increment at start of `loadDashboard()` (line 86)

After the opening `async function loadDashboard() {`, add:
```js
    _dashboardLoadCounter++;
    const loadId = _dashboardLoadCounter;
    console.log('[PARENT_DASHBOARD] Load start', { loadId });
```

---

## What This Fixes

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Data blinks every 5s | Unconditional DOM reset at lines 117-119 runs before fetch completes | Only clear DOM when child actually changes |
| Race condition on child switch | No fetch-tracking mechanism | `_dashboardLoadCounter` ignores stale responses |
| "No assessment yet" flashes during valid data | Same reset overwrites rendered content | Interval polls preserve existing data; only replace on child change |
| Hard to debug | No visibility into render flow | `[PARENT_DASHBOARD]` logs at every stage |

## What Stays the Same

- All render functions, child switcher, charts, notifications, nav
- 5-second interval polling continues (no longer causes flicker)
- HTML structure and CSS
