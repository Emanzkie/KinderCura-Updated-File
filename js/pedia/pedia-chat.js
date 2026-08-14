// === Extracted from PEDIA\pedia-chat.html (script block 1) ===
// Page helpers and auth
const API = window.location.origin + '/api';
function getToken(){ return localStorage.getItem('kc_token'); }
function getUser(){ try{ return JSON.parse(localStorage.getItem('kc_user')); }catch{ return null; } }
// Logout always returns to the root login page
function doLogout(){ ['kc_token','kc_user','kc_childId','kc_assessmentId','kc_viewChildId'].forEach(k=>localStorage.removeItem(k)); window.location.href='/login.html'; }

const _user = getUser();
if(!getToken()||!_user){ window.location.href='/login.html'; }
else if(_user.role==='parent'){ window.location.href='/parent/chat.html'; }
if(_user){
    document.getElementById('navWelcome').textContent = `Dr. ${_user.firstName} ${_user.lastName||''}`;
    if(_user.profileIcon&&_user.profileIcon.startsWith('/uploads/'))
        document.getElementById('navProfilePic').src = _user.profileIcon;
}

// Shared API fetch helper with JWT token
async function apiFetch(url, opts={}){
    const r = await fetch(`${API}${url}`, { ...opts, headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${getToken()}`, ...opts.headers } });
    const d = await r.json();
    if(!r.ok) throw new Error(d.error||`Error ${r.status}`);
    return d;
}

// Active chat state
let activeApptId=null, pollTimer=null, lastMsgId=0, pendingVideoFile=null;

/* ── Threads ────────────────────────────────────────────── */
// Load approved appointment conversations for the sidebar
async function loadThreads(){
    try{
        const data    = await apiFetch('/chat/threads');
        const rawThreads = data.threads||[];
        const tl      = document.getElementById('threadsList');
        if(!rawThreads.length){
            tl.innerHTML='<div style="padding:1.5rem;text-align:center;color:var(--text-light);font-size:.85rem;">No active conversations yet.</div>';
            return;
        }

        const grouped = {};
        rawThreads.forEach(t => {
            const key = (t.childId && t.parentId) ? `${t.childId}_${t.parentId}` : t.appointmentId;
            if (!grouped[key]) {
                grouped[key] = { ...t, unread: t.unread || 0 };
            } else {
                grouped[key].unread += (t.unread || 0);
                if (new Date(t.appointmentDate) > new Date(grouped[key].appointmentDate)) {
                    grouped[key].appointmentDate = t.appointmentDate;
                    grouped[key].appointmentId = t.appointmentId;
                }
            }
        });
        const threads = Object.values(grouped).sort((a,b) => new Date(b.appointmentDate) - new Date(a.appointmentDate));

        const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        tl.innerHTML = threads.map(t=>{
            const d   = new Date(t.appointmentDate);
            const ini = (t.parentName||'P').split(' ').map(w=>w[0]||'').join('').substring(0,2).toUpperCase();
            const av  = t.parentPhoto&&t.parentPhoto.startsWith('/uploads/')
                      ? `<img src="${t.parentPhoto}" style="width:100%;height:100%;object-fit:cover;">` : ini;
            return `<div class="thread-item${t.appointmentId==activeApptId?' active':''}" onclick="openThread(${t.appointmentId})">
                <div class="thread-avatar">${av}</div>
                <div class="thread-info">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <p class="thread-name">${t.childName || 'Child'} – ${t.parentName||'Parent'}</p>
                        ${t.unread>0?`<span class="thread-badge">${t.unread}</span>`:''}
                    </div>
                    <p class="thread-sub"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Latest: ${M[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}</p>
                </div>
            </div>`;
        }).join('');
        const urlAppt = new URLSearchParams(window.location.search).get('apptId');
        if(urlAppt&&!activeApptId) openThread(parseInt(urlAppt));
        else if(!activeApptId&&threads.length) openThread(threads[0].appointmentId);
    }catch(e){
        document.getElementById('threadsList').innerHTML=`<div style="padding:1rem;color:var(--status-attention-fg);font-size:.82rem;">${e.message}</div>`;
    }
}

// Open one conversation thread
async function openThread(apptId){
    if(pollTimer) clearInterval(pollTimer);
    activeApptId=apptId; lastMsgId=0;
    document.querySelectorAll('.thread-item').forEach(el=>el.classList.remove('active'));
    const el = document.querySelector(`.thread-item[onclick="openThread(${apptId})"]`);
    if(el) el.classList.add('active');
    document.getElementById('pchHeader').style.display   = 'block';
    document.getElementById('chatInputArea').style.display = 'block';
    document.getElementById('chatMessages').innerHTML     = '<div style="text-align:center;padding:2rem;color:var(--text-light);">Loading…</div>';
    await loadMessages();
    pollTimer = setInterval(pollMessages, 4000);
}

/* ── Load messages + populate header ───────────────────── */
// Load messages and fill the rich patient header
async function loadMessages(){
    if(!activeApptId) return;
    try{
        const data = await apiFetch(`/chat/${activeApptId}`);
        const msgs = data.messages||[];
        const info = data.appointmentInfo||{};

        /* Parent name */
        const parFull   = `${info.parFirst||''} ${info.parLast||''}`.trim();
        /* Child name */
        const childFull = `${info.childFirst||''} ${info.childLast||''}`.trim();

        /* Child age */
        let ageStr='';
        if(info.childDob){
            const dob=new Date(info.childDob), now=new Date();
            let y=now.getFullYear()-dob.getFullYear(), mo=now.getMonth()-dob.getMonth();
            if(mo<0){y--;mo+=12;}
            ageStr = y>0 ? `${y}y${mo>0?' '+mo+'mo':''}` : `${mo}mo`;
        }

        /* Status badge class */
        const sbCls = info.status==='approved'?'pb-approved':info.status==='completed'?'pb-completed':'pb-other';
        const statusLabel = (info.status||'').charAt(0).toUpperCase()+(info.status||'').slice(1);
        const gender = info.childGender ? info.childGender.charAt(0).toUpperCase()+info.childGender.slice(1) : '';

        /* Fill header */
        document.getElementById('pchParentName').textContent = parFull||'—';
        document.getElementById('pchChildName').textContent  = childFull||'—';
        document.getElementById('pchBadges').innerHTML = `
            ${ageStr  ? `<span class="pch-badge pb-age">${ageStr}</span>` : ''}
            ${gender  ? `<span class="pch-badge pb-gender">${gender}</span>` : ''}
            <span class="pch-badge ${sbCls}">${statusLabel}</span>
        `;
        document.getElementById('pchReason').textContent = info.reason||'General Check-up';

        /* Avatar: child photo → parent photo → initials */
        const avEl  = document.getElementById('pchAvatar');
        const photo = info.childPhoto||info.parPhoto;
        if(photo&&photo.startsWith('/uploads/')){
            avEl.innerHTML=`<img src="${photo}" style="width:100%;height:100%;object-fit:cover;"
                                 onerror="this.onerror=null;this.style.display='none'">`;
        } else {
            avEl.textContent = `${(info.childFirst||'?')[0]}${(info.childLast||'')[0]||''}`.toUpperCase();
            avEl.style.color = 'white';
        }

        /* Video link */
        try{
            const vd   = await apiFetch(`/videos/appointment/${activeApptId}`);
            const vids = vd.videos||[];
            const vbtn = document.getElementById('pchVideoBtn');
            if(vids.length){ vbtn.href=vids[0].filePath; vbtn.textContent=`📹 View Video (${vids.length})`; vbtn.style.display='inline-flex'; }
            else { vbtn.style.display='none'; }
        }catch{ document.getElementById('pchVideoBtn').style.display='none'; }

        renderMessages(msgs);
        if(msgs.length) lastMsgId = msgs[msgs.length-1].id;
    }catch(e){ console.error(e); }
}

// Poll for new messages while this thread is open
async function pollMessages(){
    if(!activeApptId) return;
    try{
        const data=await apiFetch(`/chat/${activeApptId}`);
        const msgs=data.messages||[];
        if(msgs.length&&msgs[msgs.length-1].id!==lastMsgId){ renderMessages(msgs); lastMsgId=msgs[msgs.length-1].id; loadThreads(); }
    }catch{}
}

/* ── Render messages ────────────────────────────────────── */
// Render chat bubbles for both pedia and parent
function renderMessages(msgs){
    const container = document.getElementById('chatMessages');
    const myId      = _user.userId||_user.id;
    if(!msgs.length){
    container.innerHTML = `
        <div class="empty-chat">
            <img src="/icons/chatbubble.png" alt="Chat Bubble Icon" style="width:52px;height:52px;object-fit:contain;display:block;margin-bottom:.8rem;">
            <p style="font-weight:600;">No messages yet</p>
            <p style="font-size:.85rem;">Send the parent a message to get started.</p>
        </div>
    `;
    return;
}
    container.innerHTML = msgs.map(m=>{
        const mine    = m.senderId===myId;
        const cls     = mine?'mine':'theirs';
        const timeStr = new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        const ini     = (m.senderName||'?').split(' ').map(w=>w[0]||'').join('').substring(0,2).toUpperCase();

        let avInner;
        if(m.senderPhoto&&m.senderPhoto.startsWith('/uploads/')){
            avInner=`<img src="${m.senderPhoto}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;"
                         onerror="this.onerror=null;this.outerHTML='<span style=\\'display:flex;width:32px;height:32px;border-radius:50%;background:var(--primary);color:white;font-weight:700;font-size:.7rem;align-items:center;justify-content:center;\\'>${ini}</span>'">`;
        } else {
            avInner=`<span style="display:flex;width:32px;height:32px;border-radius:50%;background:var(--primary);color:white;font-weight:700;font-size:.7rem;align-items:center;justify-content:center;">${ini}</span>`;
        }

        const videoHtml = m.videoPath ? `<div class="msg-video-wrap">
            <video src="${m.videoPath}" controls playsinline></video>
            <div class="msg-video-label">📹 ${m.videoName||'Video'}</div>
        </div>` : '';

        return `<div class="msg-row ${cls}">
            <div class="msg-av">${avInner}</div>
            <div class="msg-body">
                ${!mine?`<p class="msg-sender-name">${m.senderName||'Parent'}</p>`:''}
                <div class="msg-bubble">${m.message?`<span>${m.message}</span>`:''}${videoHtml}</div>
                <div class="msg-time">${timeStr}</div>
            </div>
        </div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
}

/* ── Video attach ───────────────────────────────────────── */
// Attach one local video file before sending
function handleChatVideo(e){
    const f=e.target.files[0]; if(!f) return;
    if(f.size>150*1024*1024){ alert('Video must be under 150 MB.'); return; }
    pendingVideoFile=f;
    document.getElementById('videoAttachName').textContent=`${f.name} (${(f.size/1024/1024).toFixed(1)} MB)`;
    document.getElementById('videoAttachPreview').style.display='flex';
}
function clearAttach(){
    pendingVideoFile=null;
    document.getElementById('chatVideoInput').value='';
    document.getElementById('videoAttachPreview').style.display='none';
}
// Upload attached video to backend before sending message
async function uploadChatVideo(){
    if(!pendingVideoFile) return null;
    const fd=new FormData(); fd.append('video',pendingVideoFile);
    const pw=document.getElementById('uploadProg'), pb=document.getElementById('uploadProgBar');
    pw.style.display='block'; pb.style.width='10%';
    return new Promise(resolve=>{
        const xhr=new XMLHttpRequest();
        xhr.upload.onprogress=e=>{ if(e.lengthComputable) pb.style.width=`${Math.round(e.loaded/e.total*100)}%`; };
        xhr.onload=()=>{ pw.style.display='none'; pb.style.width='0%'; try{ const r=JSON.parse(xhr.responseText); resolve(r.success?r:null); }catch{ resolve(null); } };
        xhr.onerror=()=>{ pw.style.display='none'; resolve(null); };
        xhr.open('POST', `${window.location.origin}/api/videos/chat`);
        xhr.setRequestHeader('Authorization',`Bearer ${getToken()}`);
        xhr.send(fd);
    });
}

/* ── Send ───────────────────────────────────────────────── */
// Send text message and optional video
async function sendMessage(){
    const input=document.getElementById('msgInput');
    const text=input.value.trim();
    if(!text&&!pendingVideoFile) return;
    if(!activeApptId) return;
    const btn=document.getElementById('sendBtn'); btn.disabled=true;
    try{
        let vPath=null,vName=null,vSize=null;
        if(pendingVideoFile){ const r=await uploadChatVideo(); if(r){ vPath=r.path; vName=r.fileName; vSize=pendingVideoFile.size; } }
        await apiFetch(`/chat/${activeApptId}`,{ method:'POST', body:JSON.stringify({ message:text||null, videoPath:vPath, videoName:vName, videoSize:vSize }) });
        input.value=''; input.style.height='auto';
        clearAttach(); await loadMessages();
    }catch(e){ alert(e.message); }
    finally{ btn.disabled=false; input.focus(); }
}

function handleKey(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(); } }
function autoResize(el){ el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,110)+'px'; }



// Format notification timestamps in one consistent style
function formatDateTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
}

// Small escape helper so notification text is safe to render in HTML
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

// Decide where a notification should open based on the current user role
function notificationDestination(n) {
    let role = '';
    try {
        role = String((JSON.parse(localStorage.getItem('kc_user')) || {}).role || '').toLowerCase();
    } catch {}

    const title = String(n?.title || '').toLowerCase();
    const type  = String(n?.type  || '').toLowerCase();
    const msg   = String(n?.message || '').toLowerCase();

    if (role === 'pediatrician') {
        if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/pedia/pedia-chat.html';
        if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/pedia/pediatrician-appointments.html';
        if (type === 'assessment' || title.includes('custom question') || title.includes('assessment question') || title.includes('question answered')) return '/pedia/pedia-questions.html';
        if (title.includes('diagnosis') || msg.includes('diagnosis') || title.includes('recommendation') || msg.includes('recommendation')) return '/pedia/pediatrician-patients.html';
        return '/pedia/pediatrician-dashboard.html';
    }

    if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/parent/chat.html';
    if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/parent/appointments.html';
    if (type === 'assessment' || title.includes('custom question') || title.includes('assessment question') || title.includes('question assigned') || title.includes('question answered')) return '/parent/custom-questions.html';
    if (title.includes('recommendation') || msg.includes('recommendation')) return '/parent/recommendations.html';
    if (title.includes('result') || title.includes('diagnosis') || msg.includes('diagnosis')) return '/parent/results.html';
    return '/parent/dashboard.html';
}

// Keep the bell badge in sync on every page that uses the shared modal
async function loadNotificationCount() {
    try {
        const data = await apiFetch('/notifications/count');
        const badge = document.querySelector('.notification-badge');
        if (!badge) return;
        const unread = data.unread || 0;
        badge.textContent = unread;
        badge.style.display = unread > 0 ? 'flex' : 'none';
    } catch {
        const badge = document.querySelector('.notification-badge');
        if (badge) {
            badge.textContent = '0';
            badge.style.display = 'none';
        }
    }
}

// Mark only one notification as read when the user opens or clicks it
async function markNotificationRead(id) {
    try {
        await apiFetch(`/notifications/${id}/read`, { method: 'PUT' });
        await loadNotificationCount();
    } catch {}
}

// Remove one notification from the user's list
async function deleteNotification(id) {
    if (!confirm('Remove this notification?')) return;
    try {
        await apiFetch(`/notifications/${id}`, { method: 'DELETE' });
        await openNotifications();
        await loadNotificationCount();
    } catch (err) {
        alert('Could not remove notification: ' + err.message);
    }
}

// Delete every notification so old items do not stay in the modal forever
async function clearAllNotifications() {
    if (!confirm('Clear all notifications?')) return;
    try {
        await apiFetch('/notifications/clear-all', { method: 'DELETE' });
        await openNotifications();
        await loadNotificationCount();
    } catch (err) {
        alert('Could not clear notifications: ' + err.message);
    }
}

// Optional helper so users can mark everything as seen without deleting them
async function markAllNotificationsRead() {
    try {
        await apiFetch('/notifications/read-all', { method: 'PUT' });
        await openNotifications();
        await loadNotificationCount();
    } catch (err) {
        alert('Could not mark notifications as read: ' + err.message);
    }
}

// Mark read first, then send the user to the related page
async function goToNotificationTarget(id, target) {
    await markNotificationRead(id);
    window.location.href = target;
}

// Shared notification modal renderer used by both parent and pediatrician pages
async function openNotifications() {
    const modal = document.getElementById('notificationsModal');
    const listEl = modal ? modal.querySelector('.notifications-list') : null;
    if (!modal || !listEl) return;

    modal.style.display = 'flex';
    listEl.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Loading...</p>';

    try {
        const data = await apiFetch('/notifications');
        const notifications = Array.isArray(data.notifications) ? data.notifications : [];

        if (!notifications.length) {
            listEl.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1.5rem;">No notifications yet.</p>';
            return;
        }

        const hasUnread = notifications.some(n => !n.isRead);
        const tools = `
            <div style="display:flex;justify-content:flex-end;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--border);background:white;position:sticky;top:0;z-index:1;">
                ${hasUnread ? '<button onclick="markAllNotificationsRead()" style="border:1px solid var(--border);background:white;color:var(--primary);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Mark all read</button>' : ''}
                <button onclick="clearAllNotifications()" style="border:1px solid #e6b0b0;background:white;color:var(--status-attention-fg);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Clear all</button>
            </div>`;

        const items = notifications.map((n) => {
            const dest = notificationDestination(n);
            const unreadStyle = n.isRead ? '' : 'background:var(--surface-tint);border-left:3px solid var(--primary);';
            const click = dest
                ? `goToNotificationTarget(${n.id}, '${dest}')`
                : `markNotificationRead(${n.id})`;

            return `
                <div class="notification-item" style="display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:1rem;border-bottom:1px solid var(--border);${unreadStyle}">
                    <div onclick="${click}" style="flex:1;cursor:pointer;min-width:0;">
                        <p style="font-weight:${n.isRead ? '400' : '700'};font-size:.9rem;margin:0 0 .2rem;color:var(--text-dark);">${escapeHtml(n.title || '')}</p>
                        <p style="font-size:.82rem;color:var(--text-dark);margin:0 0 .25rem;line-height:1.45;">${escapeHtml(n.message || '')}</p>
                        <p style="font-size:.75rem;color:var(--text-light);margin:0;">${formatDateTime(n.createdAt)}</p>
                        ${dest ? '<p style="font-size:.72rem;color:var(--primary);margin:.35rem 0 0;">Open related page →</p>' : ''}
                    </div>
                    <button onclick="event.stopPropagation();deleteNotification(${n.id})" title="Remove notification" style="border:none;background:none;color:var(--status-attention-fg);cursor:pointer;font-size:1rem;line-height:1;padding:.15rem .25rem;">&#215;</button>
                </div>`;
        }).join('');

        listEl.innerHTML = tools + items;
    } catch {
        listEl.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Could not load notifications.</p>';
    }
}

function closeNotifications() {
    const modal = document.getElementById('notificationsModal');
    if (modal) modal.style.display = 'none';
}


function toggleProfileMenu(){ const m=document.getElementById('profileMenu'); m.style.display=m.style.display==='none'?'block':'none'; }
document.addEventListener('click',e=>{ if(!e.target.closest('.profile-btn')) document.getElementById('profileMenu').style.display='none'; });
// Initial page load
document.addEventListener('DOMContentLoaded', () => {
    loadNotificationCount(); loadThreads(); loadNotificationCount(); });
window.addEventListener('beforeunload',()=>{ if(pollTimer) clearInterval(pollTimer); });
