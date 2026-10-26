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

        // One thread per appointment, newest first. Threads for the same child
        // used to be merged into one row that opened only the newest
        // appointment: the older conversations were unreachable, and the row's
        // unread badge counted messages that opening it never marked as read.
        const threads = rawThreads
            .map(t => ({ ...t, unread: t.unread || 0 }))
            .sort((a,b) => new Date(b.appointmentDate) - new Date(a.appointmentDate));

        const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        tl.innerHTML = threads.map(t=>{
            const d   = new Date(t.appointmentDate);
            const ini = escapeHtml((t.parentName||'P').split(' ').map(w=>w[0]||'').join('').substring(0,2).toUpperCase());
            const av  = t.parentPhoto&&t.parentPhoto.startsWith('/uploads/')
                      ? `<img src="${escapeHtml(t.parentPhoto)}" style="width:100%;height:100%;object-fit:cover;">` : ini;
            return `<div class="thread-item${t.appointmentId==activeApptId?' active':''}" onclick="openThread(${Number(t.appointmentId)})">
                <div class="thread-avatar">${av}</div>
                <div class="thread-info">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <p class="thread-name">${escapeHtml(t.childName || 'Child')} – ${escapeHtml(t.parentName||'Parent')}</p>
                        ${t.unread>0?`<span class="thread-badge">${t.unread}</span>`:''}
                    </div>
                    <p class="thread-sub"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Appointment: ${M[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}</p>
                </div>
            </div>`;
        }).join('');
        const urlAppt = new URLSearchParams(window.location.search).get('apptId');
        if(urlAppt&&!activeApptId) openThread(parseInt(urlAppt));
        else if(!activeApptId&&threads.length) openThread(threads[0].appointmentId);
    }catch(e){
        document.getElementById('threadsList').innerHTML=`<div style="padding:1rem;color:var(--status-attention-fg);font-size:.82rem;">${escapeHtml(e.message)}</div>`;
    }
}

// Open one conversation thread
async function openThread(apptId){
    if(pollTimer) pollTimer.stop();
    activeApptId=apptId; lastMsgId=0;
    document.querySelectorAll('.thread-item').forEach(el=>el.classList.remove('active'));
    const el = document.querySelector(`.thread-item[onclick="openThread(${apptId})"]`);
    if(el) el.classList.add('active');
    document.getElementById('pchHeader').style.display   = 'block';
    document.getElementById('chatInputArea').style.display = 'block';
    document.getElementById('chatMessages').innerHTML     = '<div style="text-align:center;padding:2rem;color:var(--text-light);">Loading…</div>';
    await loadMessages();
    pollTimer = window.KC.poll(pollMessages, 4000);
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
            ${gender  ? `<span class="pch-badge pb-gender">${escapeHtml(gender)}</span>` : ''}
            <span class="pch-badge ${sbCls}">${escapeHtml(statusLabel)}</span>
        `;
        document.getElementById('pchReason').textContent = info.reason||'General Check-up';

        /* Avatar: child photo → parent photo → initials */
        const avEl  = document.getElementById('pchAvatar');
        const photo = info.childPhoto||info.parPhoto;
        if(photo&&photo.startsWith('/uploads/')){
            avEl.innerHTML=`<img src="${escapeHtml(photo)}" style="width:100%;height:100%;object-fit:cover;"
                                 onerror="this.onerror=null;this.style.display='none'">`;
        } else {
            avEl.textContent = `${(info.childFirst||'?')[0]}${(info.childLast||'')[0]||''}`.toUpperCase();
            avEl.style.color = '#FAFAF6';
        }

        /* Video link */
        try{
            const vd   = await apiFetch(`/videos/appointment/${activeApptId}`);
            const vids = vd.videos||[];
            const vbtn = document.getElementById('pchVideoBtn');
            if(vids.length){ vbtn.href=vids[0].filePath; vbtn.innerHTML=`<img src="/icons/change_photo.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> View Video (${Number(vids.length)})`; vbtn.style.display='inline-flex'; }
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
        // Initials also land inside a JS string in the onerror attribute below, where
        // HTML-escaping is not enough, so keep letters and digits only.
        const ini     = (m.senderName||'?').split(' ').map(w=>w[0]||'').join('').substring(0,2).toUpperCase().replace(/[^\p{L}\p{N}]/gu,'');

        let avInner;
        if(m.senderPhoto&&m.senderPhoto.startsWith('/uploads/')){
            avInner=`<img src="${escapeHtml(m.senderPhoto)}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;"
                         onerror="this.onerror=null;this.outerHTML='<span style=\\'display:flex;width:32px;height:32px;border-radius:50%;background:var(--primary);color:#FAFAF6;font-weight:700;font-size:.7rem;align-items:center;justify-content:center;\\'>${ini}</span>'">`;
        } else {
            avInner=`<span style="display:flex;width:32px;height:32px;border-radius:50%;background:var(--primary);color:#FAFAF6;font-weight:700;font-size:.7rem;align-items:center;justify-content:center;">${ini}</span>`;
        }

        const videoHtml = m.videoPath ? `<div class="msg-video-wrap">
            <video src="${escapeHtml(m.videoPath)}" controls playsinline></video>
            <div class="msg-video-label"><img src="/icons/change_photo.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(m.videoName||'Video')}</div>
        </div>` : '';

        return `<div class="msg-row ${cls}">
            <div class="msg-av">${avInner}</div>
            <div class="msg-body">
                ${!mine?`<p class="msg-sender-name">${escapeHtml(m.senderName||'Parent')}</p>`:''}
                <div class="msg-bubble">${m.message?`<span>${escapeHtml(m.message)}</span>`:''}${videoHtml}</div>
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


function toggleProfileMenu(){ const m=document.getElementById('profileMenu'); m.style.display=m.style.display==='none'?'block':'none'; }
document.addEventListener('click',e=>{ if(!e.target.closest('.profile-btn')) document.getElementById('profileMenu').style.display='none'; });
// Initial page load
document.addEventListener('DOMContentLoaded', () => {
    loadNotificationCount(); loadThreads(); loadNotificationCount(); });
window.addEventListener('beforeunload',()=>{ if(pollTimer) pollTimer.stop(); });
