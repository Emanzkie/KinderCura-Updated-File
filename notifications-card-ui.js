// notifications-card-ui.js — the one notification bell + modal controller.
//
// Every role (parent, pediatrician, admin, secretary) loads this after api.js
// and uses the same markup (#notificationsModal / #notificationsList), so the
// bell behaves and looks the same everywhere. Page scripts must NOT declare
// their own openNotifications()/closeNotifications()/clearAllNotifications()…:
// a top-level function declaration in a later classic script silently replaces
// these, which is how most admin and pediatrician pages ended up with an older
// renderer and how some bells stopped opening at all.
//
// Server routes (routes/notifications.js), all scoped to the signed-in user:
//   GET    /notifications            list
//   PUT    /notifications/:id/read   mark one read
//   PUT    /notifications/read-all   mark all read
//   DELETE /notifications/:id        dismiss one (deletes it)
//   DELETE /notifications/clear-all  clear all (deletes them)
// Where a notification leads is decided by notificationDestination() in api.js.
(() => {
    if (window.__kcNotificationsReady) return;
    window.__kcNotificationsReady = true;

    const state = {
        items: [],
        loaded: false,  // true only after a successful load
        busy: false,    // a mark/clear/dismiss request is in flight
        loadToken: 0,   // ignores responses from an older open
        lastFocus: null,
    };

    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));

    // Same format as the parent reference modal, e.g. "10/11/2026, 11:30 PM".
    const fmt = (value) => {
        if (!value) return '';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString('en-US', {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    };

    const getModal = () => document.getElementById('notificationsModal');
    const getList = () => document.getElementById('notificationsList') || document.querySelector('#notificationsModal .notifications-list');
    const getClearButton = () => document.getElementById('clearNotificationsBtn');
    const getMarkAllButton = () => document.getElementById('markAllNotificationsReadBtn');
    const isOpen = () => {
        const modal = getModal();
        return Boolean(modal && modal.classList.contains('is-open'));
    };

    const idOf = (n) => String(n?.id ?? n?._id ?? '');
    const findItem = (id) => state.items.find((n) => idOf(n) === String(id));

    function api(endpoint, options) {
        if (typeof window.apiFetch !== 'function') return Promise.reject(new Error('Not signed in.'));
        return window.apiFetch(endpoint, options);
    }

    function destinationOf(n) {
        const target = typeof window.notificationDestination === 'function'
            ? window.notificationDestination(n)
            : String(n?.relatedPage || '').trim();
        return target ? String(target) : null;
    }

    async function refreshCount() {
        if (typeof window.loadNotificationCount !== 'function') return;
        try {
            await window.loadNotificationCount();
        } catch {}
    }

    // Lets a page keep its own notification widgets (e.g. the parent dashboard
    // preview card) in sync after a dismiss/clear/mark.
    function announceChange() {
        document.dispatchEvent(new CustomEvent('kc:notifications-changed'));
    }

    // Older markup may lack the Mark all read button or the whole action bar.
    function ensureActionBar(modal) {
        const header = modal.querySelector('.notifications-header, .notification-modal-header');
        let bar = modal.querySelector('.notification-action-bar, .clear-all-row');
        if (!bar && header) {
            bar = document.createElement('div');
            bar.className = 'notification-action-bar clear-all-row';
            header.insertAdjacentElement('afterend', bar);
        }
        if (!bar) return;
        if (!getMarkAllButton()) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mark-all-read-btn';
            btn.id = 'markAllNotificationsReadBtn';
            btn.textContent = 'Mark all read';
            btn.setAttribute('onclick', 'markAllNotificationsRead()');
            bar.insertBefore(btn, bar.firstChild);
        }
        if (!getClearButton()) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'clear-all-btn';
            btn.id = 'clearNotificationsBtn';
            btn.textContent = 'Clear all';
            btn.setAttribute('onclick', 'clearAllNotifications()');
            bar.appendChild(btn);
        }
    }

    function syncControls() {
        const hasItems = state.loaded && state.items.length > 0;
        const hasUnread = state.loaded && state.items.some((n) => !n.isRead);
        const clearButton = getClearButton();
        const markAllButton = getMarkAllButton();
        if (clearButton) clearButton.disabled = state.busy || !hasItems;
        if (markAllButton) markAllButton.disabled = state.busy || !hasUnread;

        const list = getList();
        if (!list) return;
        list.setAttribute('aria-busy', String(state.busy || !state.loaded));
        list.querySelectorAll('[data-notif-action]').forEach((btn) => {
            btn.disabled = state.busy;
        });
    }

    function renderMessage(text, withRetry) {
        const list = getList();
        if (!list) return;
        list.innerHTML = `<p class="notifications-empty">${esc(text)}</p>`
            + (withRetry ? '<p class="notifications-retry"><button type="button" class="notif-retry-btn" data-notif-action="retry">Try again</button></p>' : '');
    }

    function renderList() {
        const list = getList();
        if (!list) return;

        if (!state.items.length) {
            renderMessage('No notifications yet.');
            return;
        }

        list.innerHTML = state.items.map((n) => {
            const id = idOf(n);
            const target = destinationOf(n);
            const title = n.title || 'Notification';
            const time = fmt(n.createdAt);
            const unread = !n.isRead;
            return `
                <article class="notification-card${unread ? ' unread' : ''}" role="listitem" data-card-id="${esc(id)}">
                    <div class="notification-card-main${target ? ' has-target' : ''}" data-notif-card="${esc(id)}">
                        <span class="notif-icon" aria-hidden="true">!</span>
                        <div class="notif-content">
                            <p class="notif-title">${esc(title)}${unread ? '<span class="notif-sr-only"> (unread)</span>' : ''}</p>
                            ${n.message ? `<p class="notif-preview">${esc(n.message)}</p>` : ''}
                            ${time ? `<p class="notif-time"><time datetime="${esc(new Date(n.createdAt).toISOString())}">${esc(time)}</time></p>` : ''}
                            ${target ? `<button type="button" class="notif-open-link" data-notif-action="open" data-id="${esc(id)}">Open related page -&gt;</button>` : ''}
                        </div>
                    </div>
                    ${id ? `<button type="button" class="notif-delete" data-notif-action="delete" data-id="${esc(id)}" aria-label="Dismiss notification: ${esc(title)}" title="Dismiss">X</button>` : ''}
                </article>`;
        }).join('');
    }

    async function loadList() {
        const token = ++state.loadToken;
        state.loaded = false;
        state.items = [];
        renderMessage('Loading...');
        syncControls();

        try {
            const data = await api('/notifications');
            if (token !== state.loadToken) return;
            const items = Array.isArray(data.notifications) ? data.notifications : [];
            state.items = items.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
            state.loaded = true;
            renderList();
        } catch {
            if (token !== state.loadToken) return;
            // Never show "No notifications yet." for a failed request.
            renderMessage('Could not load notifications.', true);
        } finally {
            if (token === state.loadToken) syncControls();
        }
    }

    // Runs one mutating request at a time; the buttons stay disabled until it settles.
    async function exclusive(task) {
        if (state.busy) return;
        state.busy = true;
        syncControls();
        try {
            await task();
        } finally {
            state.busy = false;
            syncControls();
        }
    }

    function focusables(modal) {
        return Array.from(modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
            .filter((el) => !el.disabled && el.offsetParent !== null);
    }

    window.openNotifications = function openNotifications() {
        const modal = getModal();
        if (!modal) return Promise.resolve();
        ensureActionBar(modal);

        if (!isOpen()) {
            state.lastFocus = document.activeElement;
            modal.classList.add('is-open');
            modal.style.display = 'flex';
            modal.setAttribute('aria-hidden', 'false');
            document.documentElement.classList.add('kc-notifications-open');
            const closeButton = modal.querySelector('.notif-close, .close-btn');
            if (closeButton) closeButton.focus({ preventScroll: true });
        }

        return loadList();
    };

    window.closeNotifications = function closeNotifications() {
        const modal = getModal();
        if (!modal) return;
        state.loadToken += 1; // drop any response still on its way
        modal.classList.remove('is-open', 'show');
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        document.documentElement.classList.remove('kc-notifications-open');
        const back = state.lastFocus;
        state.lastFocus = null;
        if (back && typeof back.focus === 'function' && document.contains(back)) back.focus({ preventScroll: true });
    };

    window.markAllNotificationsRead = function markAllNotificationsRead() {
        return exclusive(async () => {
            if (!state.items.some((n) => !n.isRead)) return;
            try {
                await api('/notifications/read-all', { method: 'PUT' });
            } catch (err) {
                alert('Could not mark notifications as read: ' + err.message);
                return;
            }
            state.items.forEach((n) => { n.isRead = true; });
            renderList();
            await refreshCount();
            announceChange();
        });
    };

    window.clearAllNotifications = function clearAllNotifications() {
        return exclusive(async () => {
            if (!state.items.length) return;
            if (!window.confirm('Clear all notifications? They will be removed permanently.')) return;
            try {
                await api('/notifications/clear-all', { method: 'DELETE' });
            } catch (err) {
                alert('Could not clear notifications: ' + err.message);
                return;
            }
            state.items = [];
            renderList();
            await refreshCount();
            announceChange();
        });
    };

    // Accepts an id or an element carrying data-id.
    window.deleteNotification = function deleteNotification(ref) {
        const id = ref && typeof ref.getAttribute === 'function'
            ? (ref.getAttribute('data-id') || '')
            : String(ref ?? '');
        if (!id) return Promise.resolve();

        return exclusive(async () => {
            try {
                await api(`/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
            } catch (err) {
                alert('Could not dismiss notification: ' + err.message);
                return;
            }
            state.items = state.items.filter((n) => idOf(n) !== id);
            renderList();
            await refreshCount();
            announceChange();
        });
    };

    // Marks the notification read, then goes to its page. Without a page it is
    // only marked read, so a click never lands somewhere unrelated.
    async function openNotification(id) {
        const n = findItem(id);
        if (!n || state.busy) return;
        const target = destinationOf(n);

        if (!n.isRead) {
            try {
                await api(`/notifications/${encodeURIComponent(id)}/read`, { method: 'PUT' });
                n.isRead = true;
            } catch {}
            await refreshCount();
        }

        if (!target) {
            renderList();
            syncControls();
            announceChange();
            return;
        }

        if (typeof window.applyNotificationContext === 'function') window.applyNotificationContext(target);
        window.location.href = target;
    }

    document.addEventListener('click', (event) => {
        const modal = getModal();
        if (!modal || !isOpen()) return;

        // Backdrop only — clicks inside the panel never close it.
        if (event.target === modal) {
            window.closeNotifications();
            return;
        }
        if (!modal.contains(event.target)) return;

        const action = event.target.closest('[data-notif-action]');
        if (action) {
            event.preventDefault();
            event.stopPropagation();
            const kind = action.getAttribute('data-notif-action');
            if (kind === 'delete') window.deleteNotification(action);
            else if (kind === 'open') openNotification(action.getAttribute('data-id'));
            else if (kind === 'retry') loadList();
            return;
        }

        // Clicking the card body behaves like its "Open related page" link.
        const card = event.target.closest('[data-notif-card]');
        if (card) openNotification(card.getAttribute('data-notif-card'));
    });

    document.addEventListener('keydown', (event) => {
        if (!isOpen()) return;
        const modal = getModal();

        if (event.key === 'Escape') {
            event.preventDefault();
            window.closeNotifications();
            return;
        }

        // Keep keyboard focus inside the dialog while it is open.
        if (event.key === 'Tab') {
            const items = focusables(modal);
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
                event.preventDefault();
                first.focus();
            }
        }
    });
})();
