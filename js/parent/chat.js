// === Extracted from PARENT\chat.html (script block 1) ===
/* Make sure only logged-in users can access this page */
requireAuth();

const _user = KC.user();

/* Redirect wrong roles away from parent chat */
if (_user?.role === 'pediatrician') window.location.href = '/pedia/pedia-chat.html';
else if (_user?.role === 'admin') window.location.href = '/admin/admin-dashboard.html';

/* Chat state variables */
let activeApptId = null;
let pollTimer = null;
let lastMsgId = 0;
let pendingVideoFile = null;

/* Small wrapper so all chat requests use your apiFetch with token */
async function chatFetch(url, opts = {}) {
  return apiFetch(url, opts);
}

/* Load conversation list on the left */
async function loadThreads() {
  try {
    const data = await chatFetch('/chat/threads');
    const rawThreads = data.threads || [];
    const tl = document.getElementById('threadsList');

    if (!rawThreads.length) {
      tl.innerHTML = `
        <div style="padding:1.5rem;text-align:center;color:var(--text-light);font-size:.85rem;">
          No conversations yet.<br>
          <a href="/parent/appointments.html" style="color:var(--primary);">Book an appointment first</a>
        </div>`;
      return;
    }

    const grouped = {};
    rawThreads.forEach(t => {
      const key = (t.childId && t.pediatricianId) ? `${t.childId}_${t.pediatricianId}` : t.appointmentId;
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

    tl.innerHTML = threads.map(t => {
      const d = new Date(t.appointmentDate);
      const initials = `Dr. ${(t.pediatricianName || '').split(' ').map(w => w[0] || '').join('').substring(0,2).toUpperCase()}`;

      /* Use doctor photo if available, otherwise initials */
      const avatar = t.pedPhoto && t.pedPhoto.startsWith('/uploads/')
        ? `<img src="${t.pedPhoto}" style="width:100%;height:100%;object-fit:cover;">`
        : initials;

      return `
        <div class="thread-item${t.appointmentId == activeApptId ? ' active' : ''}" onclick="openThread(${t.appointmentId})">
          <div class="thread-avatar">${avatar}</div>
          <div class="thread-info">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <p class="thread-name">${t.childName || 'Child'} – Dr. ${t.pediatricianName || 'Pediatrician'}</p>
              ${t.unread > 0 ? `<span class="thread-badge">${t.unread}</span>` : ''}
            </div>
            <p class="thread-sub"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Latest: ${M[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}</p>
          </div>
        </div>`;
    }).join('');

    /* Open appointment from URL if passed */
    const urlAppt = new URLSearchParams(window.location.search).get('apptId');
    if (urlAppt && !activeApptId) openThread(parseInt(urlAppt, 10));
    else if (!activeApptId && threads.length) openThread(threads[0].appointmentId);
  } catch (e) {
    document.getElementById('threadsList').innerHTML = `<div style="padding:1rem;color:var(--status-attention-fg);font-size:.82rem;">${e.message}</div>`;
  }
}

/* Open selected conversation */
async function openThread(apptId) {
  if (pollTimer) clearInterval(pollTimer);

  activeApptId = apptId;
  lastMsgId = 0;

  document.getElementById('chatMessages').innerHTML =
    '<div style="text-align:center;padding:2rem;color:var(--text-light);font-size:.85rem;">Loading…</div>';

  await loadMessages();

  /* Poll every 4 seconds for new messages */
  pollTimer = setInterval(pollMessages, 4000);
}

/* Load all messages of current thread */
async function loadMessages() {
  if (!activeApptId) return;

  try {
    const data = await chatFetch(`/chat/${activeApptId}`);
    const msgs = data.messages || [];
    const info = data.appointmentInfo || {};

    document.getElementById('parentChatHeader').style.display = 'flex';
    document.getElementById('chatInputArea').style.display = 'block';

    /* Show doctor info in chat header */
    const childName = info.childFirst ? `${info.childFirst} – ` : '';
    document.getElementById('docName').textContent = `${childName}Dr. ${info.pedFirst || ''} ${info.pedLast || ''}`.trim();
    document.getElementById('docSpec').textContent = info.pedSpec || 'Pediatrician';

    const av = document.getElementById('docAvatar');
    if (info.pedPhoto && info.pedPhoto.startsWith('/uploads/')) {
      av.innerHTML = `<img src="${info.pedPhoto}" style="width:100%;height:100%;object-fit:cover;">`;
    } else {
      av.textContent = `${(info.pedFirst || 'D')[0]}${(info.pedLast || 'R')[0]}`.toUpperCase();
    }

    renderMessages(msgs);

    if (msgs.length) lastMsgId = msgs[msgs.length - 1].id;

    loadThreads();
  } catch (e) {
    /* If appointment is not approved yet, lock chat */
    if (e.message.includes('not yet available')) {
      document.getElementById('chatMessages').innerHTML =
        '<div class="locked-notice"><img src="/icons/privacy.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Chat is available once your appointment is approved by the pediatrician.</div>';
      document.getElementById('chatInputArea').style.display = 'none';
      document.getElementById('parentChatHeader').style.display = 'none';
    } else {
      document.getElementById('chatMessages').innerHTML = `<div class="empty-chat">${e.message}</div>`;
    }
  }
}

/* Check if new messages arrived */
async function pollMessages() {
  if (!activeApptId) return;

  try {
    const data = await chatFetch(`/chat/${activeApptId}`);
    const msgs = data.messages || [];

    if (msgs.length && msgs[msgs.length - 1].id !== lastMsgId) {
      renderMessages(msgs);
      lastMsgId = msgs[msgs.length - 1].id;
      loadThreads();
    }
  } catch {}
}

/* Draw messages on screen */
function renderMessages(msgs) {
  const container = document.getElementById('chatMessages');
  const myId = _user.userId || _user.id;

  if (!msgs.length) {
  container.innerHTML = `
    <div class="empty-chat">
      <img src="/icons/chatbubble.png" alt="Chat Bubble Icon" style="width:52px;height:52px;object-fit:contain;display:block;margin-bottom:.8rem;">
      <p style="font-weight:600;">No messages yet</p>
      <p style="font-size:.85rem;">Say hello to get started!</p>
    </div>`;
  return;
}

  container.innerHTML = msgs.map(m => {
    const mine = m.senderId === myId;
    const cls = mine ? 'mine' : 'theirs';
    const timeStr = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const ini = (m.senderName || '?').split(' ').map(w => w[0] || '').join('').substring(0,2).toUpperCase();

    let avInner;
    if (m.senderPhoto && m.senderPhoto.startsWith('/uploads/')) {
      avInner = `<img src="${m.senderPhoto}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">`;
    } else {
      avInner = `<span style="display:flex;width:32px;height:32px;border-radius:50%;background:var(--primary);color:white;font-weight:700;font-size:.7rem;align-items:center;justify-content:center;">${ini}</span>`;
    }

    /* Show attached video if message has one */
    const videoHtml = m.videoPath ? `
      <div class="msg-video-wrap">
        <video src="${m.videoPath}" controls playsinline></video>
        <div class="msg-video-label">📹 ${m.videoName || 'Video'}</div>
      </div>` : '';

    return `
      <div class="msg-row ${cls}">
        <div class="msg-av">${avInner}</div>
        <div class="msg-body">
          <div class="msg-bubble">${m.message ? `<span>${m.message}</span>` : ''}${videoHtml}</div>
          <div class="msg-time">${timeStr}${mine && m.isRead ? ' ✓✓' : ''}</div>
        </div>
      </div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

/* When parent selects a video file */
function handleChatVideo(e) {
  const f = e.target.files[0];
  if (!f) return;

  /* Limit video size */
  if (f.size > 150 * 1024 * 1024) {
    alert('Video must be under 150 MB.');
    return;
  }

  pendingVideoFile = f;
  document.getElementById('videoAttachName').textContent =
    `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
  document.getElementById('videoAttachPreview').style.display = 'flex';
}

/* Remove selected video before sending */
function clearAttach() {
  pendingVideoFile = null;
  document.getElementById('chatVideoInput').value = '';
  document.getElementById('videoAttachPreview').style.display = 'none';
}

/* Upload video first before sending chat message */
async function uploadChatVideo() {
  if (!pendingVideoFile) return null;

  const fd = new FormData();
  fd.append('video', pendingVideoFile);

  const progWrap = document.getElementById('uploadProg');
  const progBar = document.getElementById('uploadProgBar');
  progWrap.style.display = 'block';
  progBar.style.width = '10%';

  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();

    /* Update progress bar while uploading */
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        progBar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
      }
    };

    xhr.onload = () => {
      progWrap.style.display = 'none';
      progBar.style.width = '0%';
      try {
        const r = JSON.parse(xhr.responseText);
        resolve(r.success ? r : null);
      } catch {
        resolve(null);
      }
    };

    xhr.onerror = () => {
      progWrap.style.display = 'none';
      progBar.style.width = '0%';
      resolve(null);
    };

    /* Use the current site origin so the chat upload works on localhost and when deployed. */
    xhr.open('POST', `${window.location.origin}/api/videos/chat`);
    xhr.setRequestHeader('Authorization', `Bearer ${KC.token()}`);
    xhr.send(fd);
  });
}

/* Send text message and/or uploaded video */
async function sendMessage() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();

  if (!text && !pendingVideoFile) return;
  if (!activeApptId) return;

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;

  try {
    let vPath = null;
    let vName = null;
    let vSize = null;

    if (pendingVideoFile) {
      const uploaded = await uploadChatVideo();
      if (!uploaded) {
        throw new Error('Video upload failed.');
      }

      vPath = uploaded.path;
      vName = uploaded.fileName;
      vSize = pendingVideoFile.size;
    }

    await chatFetch(`/chat/${activeApptId}`, {
      method: 'POST',
      body: JSON.stringify({
        message: text || null,
        videoPath: vPath,
        videoName: vName,
        videoSize: vSize
      })
    });

    input.value = '';
    input.style.height = 'auto';
    clearAttach();
    await loadMessages();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

/* Enter sends message, Shift+Enter makes new line */
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

/* Auto-grow textarea while typing */
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 110) + 'px';
}

/* Close profile menu when clicking outside */
document.addEventListener('click', e => {
  if (!e.target.closest('.profile-btn')) {
    const menu = document.getElementById('profileMenu');
    if (menu) menu.style.display = 'none';
  }
});

/* Initial page load */
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  loadThreads();
});

/* Stop polling when leaving the page */
window.addEventListener('beforeunload', () => {
  if (pollTimer) clearInterval(pollTimer);
});
