// === Extracted from PEDIA\pediatrician-dashboard.html (script block 1) ===
const API = window.location.origin + '/api';
// Uses the current site origin so the same code works on localhost and when deployed.
        const getToken=()=>localStorage.getItem('kc_token');
        const getUser=()=>{try{return JSON.parse(localStorage.getItem('kc_user'));}catch{return null;}};
        function doLogout(){['kc_token','kc_user','kc_childId','kc_assessmentId'].forEach(k=>localStorage.removeItem(k));window.location.href='/login.html';}

const _u = getUser();




if (!getToken() || !_u) {
    window.location.href = '/login.html';
} else if ((_u.role || '').trim().toLowerCase() !== 'pediatrician') {
    
    window.location.href = '/login.html';
}
        if(_u){
            document.getElementById('navWelcome').textContent=`Welcome, Dr. ${_u.firstName}`;
            document.getElementById('pageTitle').textContent=`Welcome, Dr. ${_u.firstName} ${_u.lastName}`;
            if(_u.profileIcon&&_u.profileIcon.startsWith('/uploads/'))
                document.getElementById('navProfilePic').src=_u.profileIcon;
        }

        async function apiFetch(ep,opts={}){
            const res=await fetch(`${API}${ep}`,{...opts,headers:{'Content-Type':'application/json',Authorization:`Bearer ${getToken()}`,...opts.headers}});
            const d=await res.json();
            if(!res.ok)throw new Error(d.error||`Error ${res.status}`);
            return d;
        }

        function fmtDate(d) {
            if (!d) return '—';
            var s = String(d).split('T')[0];
            var p = s.split('-');
            if (p.length !== 3) return s;
            var months = ['January','February','March','April','May','June',
                          'July','August','September','October','November','December'];
            return months[parseInt(p[1],10)-1] + ' ' + parseInt(p[2],10) + ', ' + p[0];
        }
        function fmtTime(t) {
            if (!t) return '—';
            var s = String(t);
            if (s.indexOf('T') !== -1 || s.indexOf('Z') !== -1 || s.length > 8) {
                var d = new Date(s);
                if (!isNaN(d.getTime())) {
                    var h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2,'0');
                    return (h%12||12) + ':' + m + ' ' + (h>=12?'PM':'AM');
                }
            }
            var parts = s.split(':');
            var h = parseInt(parts[0],10), m = String(parts[1]||'00').padStart(2,'0');
            if (isNaN(h)) return s;
            return (h%12||12) + ':' + m + ' ' + (h>=12?'PM':'AM');
        }
                async function loadDashboard(){
            try{
                const data=await apiFetch('/appointments/pedia-notifications');
                const all=(data.notifications||[]).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
                const pending=all.filter(n=>n.status==='pending');
                const approved=all.filter(n=>n.status==='approved');

                document.getElementById('statTotal').textContent=all.length;
                document.getElementById('statPending').textContent=pending.length;
                document.getElementById('statReviewed').textContent=approved.length;
                document.getElementById('statTotalSub').textContent=all.length>0?`${all.length} total`:'No patients yet';

                const pSub=document.getElementById('statPendingSub');
                if(pending.length>0){pSub.innerHTML='Needs attention';pSub.style.color='var(--accent-red)';}
                else{pSub.innerHTML='&#10003; All clear';pSub.style.color='#27ae60';}

                const now=new Date(),in7=new Date(now.getTime()+7*24*60*60*1000);
                document.getElementById('statUpcoming').textContent=approved.filter(n=>{const d=new Date(n.appointmentDate);return d>=now&&d<=in7;}).length;

                try {
                    const aptData = await apiFetch('/appointments/pedia');
                    const appointments = aptData.appointments || [];
                    for (const n of pending) {
                        const apt = appointments.find(a => a.id === n.appointmentId);
                        const childId = apt ? apt.childId : n.childId;
                        if (childId) {
                            try {
                                const hist = await apiFetch(`/assessments/${childId}/history`);
                                const assessments = (hist.assessments || []).filter(a => a.overallScore !== null);
                                if (assessments.length > 0) {
                                    const latest = assessments[0];
                                    n.overallScore = Math.round(latest.overallScore || 0);
                                    n.communicationScore = Math.round(latest.communicationScore || 0);
                                    n.communicationStatus = latest.communicationStatus;
                                    n.socialScore = Math.round(latest.socialScore || 0);
                                    n.socialStatus = latest.socialStatus;
                                    n.cognitiveScore = Math.round(latest.cognitiveScore || 0);
                                    n.cognitiveStatus = latest.cognitiveStatus;
                                    n.motorScore = Math.round(latest.motorScore || 0);
                                    n.motorStatus = latest.motorStatus;
                                }
                            } catch (err) {
                                console.error(err);
                            }
                        }
                    }
                } catch (err) {
                    console.error("Error fetching appointments for history mapping:", err);
                }

                renderPending(pending);
                renderActivity(all);
            }catch(e){
                document.getElementById('pendingList').innerHTML='<div class="empty-state"><span><img src="/icons/smart_notif.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">️</span>Could not load. Is the server running?</div>';
                document.getElementById('activityList').innerHTML='<div class="empty-state"><span><img src="/icons/smart_notif.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">️</span>Could not load activity.</div>';
            }
        }

        function renderPending(pending){
            const el=document.getElementById('pendingList');
            if(pending.length===0){el.innerHTML='<div class="empty-state"><span>✅</span>No pending appointment requests.<br><small style="color:var(--text-light);">Requests from parents will appear here once booked.</small></div>';return;}
            el.innerHTML=pending.map(n=>`
                <div class="apt-card" id="apt-${n.id}">
                    <div class="apt-header">
                        <div>
                            <h4>${n.parentName||'Parent'} — ${n.childName||'Child'}</h4>
                            <p>${fmtDate(n.appointmentDate)} at ${fmtTime(n.appointmentTime)}</p>
                            <p><img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${n.reason||'General checkup'}</p>
                        </div>
                        <span class="badge-pending">Pending</span>
                    </div>
                    ${n.overallScore!=null
                        ?`<div class="scores-row"><strong style="color:var(--primary);"><img src="/icons/analytics.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Assessment Results:</strong><br>
                           Communication: <strong>${n.communicationScore||0}%</strong>${n.communicationStatus?' ('+n.communicationStatus+')':''} &nbsp;·&nbsp;
                           Social: <strong>${n.socialScore||0}%</strong>${n.socialStatus?' ('+n.socialStatus+')':''} &nbsp;·&nbsp;
                           Cognitive: <strong>${n.cognitiveScore||0}%</strong>${n.cognitiveStatus?' ('+n.cognitiveStatus+')':''} &nbsp;·&nbsp;
                           Motor: <strong>${n.motorScore||0}%</strong>${n.motorStatus?' ('+n.motorStatus+')':''}<br>
                           Overall: <strong style="color:var(--primary);font-size:1rem;">${n.overallScore||0}%</strong></div>`
                        :`<p style="color:var(--text-light);font-size:.85rem;font-style:italic;margin:.5rem 0;">No assessment results on file yet.</p>`
                    }
                    <div style="display:flex;gap:.8rem;">
                        <button class="btn-approve" onclick="respond(${n.id},'approved')">Approve</button>
                        <button class="btn-reject"  onclick="respond(${n.id},'declined')">Decline</button>
                    </div>
                </div>`).join('');
        }

        function renderActivity(all){
            const el=document.getElementById('activityList');
            if(all.length===0){el.innerHTML='<div class="empty-state"><span><img src="/icons/analytics.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"></span>No patient activity yet.<br><small style="color:var(--text-light);">Activity appears here once parents book appointments.</small></div>';return;}
            const iconMap={pending:'•',approved:'&#10003;',declined:'&#10007;'};
            const labelMap={pending:'Appointment Requested',approved:'Appointment Approved',declined:'Appointment Declined'};
            el.innerHTML=all.slice(0,6).map(n=>`
                <div class="activity-item">
                    <div>
                        <p class="activity-title">${labelMap[n.status]||'Activity'}: ${n.childName||'Child'}</p>
                        <p class="activity-time">Parent: ${n.parentName||'—'} · ${fmt(n.createdAt)}</p>
                    </div>
                    <span class="activity-icon">${iconMap[n.status]||'<img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">'}</span>
                </div>`).join('');
        }

        async function respond(id,status){
            const card=document.getElementById(`apt-${id}`);
            if(card){card.style.opacity='.5';card.style.pointerEvents='none';}
            try{
                await apiFetch(`/appointments/pedia-notifications/${id}`,{method:'PUT',body:JSON.stringify({status})});
                loadDashboard();
            }catch(e){
                alert('Error: '+e.message);
                if(card){card.style.opacity='1';card.style.pointerEvents='auto';}
            }
        }

        function fmt(ts){
            if(!ts)return'—';
            const d=new Date(ts),diff=Date.now()-d.getTime(),mins=Math.floor(diff/60000);
            if(mins<1)return'just now';
            if(mins<60)return`${mins}m ago`;
            const hrs=Math.floor(mins/60);
            if(hrs<24)return`${hrs}h ago`;
            const days=Math.floor(hrs/24);
            if(days===1)return'1 day ago';
            if(days<7)return`${days} days ago`;
            return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
        }

        function toggleProfileMenu(){const m=document.getElementById('profileMenu');m.style.display=m.style.display==='none'?'block':'none';}

        function escapeHtml(value){
            return String(value ?? '')
                .replace(/&/g,'&amp;')
                .replace(/</g,'&lt;')
                .replace(/>/g,'&gt;')
                .replace(/"/g,'&quot;')
                .replace(/'/g,'&#39;');
        }

        function formatDateTime(value){
            if(!value) return '—';
            const d = new Date(value);
            if (isNaN(d.getTime())) return String(value);
            return d.toLocaleString('en-US',{
                month:'short',
                day:'numeric',
                year:'numeric',
                hour:'numeric',
                minute:'2-digit'
            });
        }

        // Keep dashboard notifications consistent with the other pediatrician pages.
        function notificationDestination(n){
            const title = String(n?.title || '').toLowerCase();
            const msg = String(n?.message || '').toLowerCase();

            if (title.includes('appointment') || msg.includes('appointment')) return '/pedia/pediatrician-appointments.html';
            if (title.includes('question') || msg.includes('question')) return '/pedia/pedia-questions.html';
            if (title.includes('chat') || msg.includes('message')) return '/pedia/pedia-chat.html';
            return '/pedia/pediatrician-dashboard.html';
        }

        async function loadNotificationCount(){
            try{
                const data = await apiFetch('/notifications/count');
                const badge = document.getElementById('notifCount');
                if(!badge) return;
                const unread = data.unread || 0;
                badge.textContent = unread;
                badge.style.display = unread > 0 ? 'flex' : 'none';
            }catch{
                const badge = document.getElementById('notifCount');
                if(badge){
                    badge.textContent = '0';
                    badge.style.display = 'none';
                }
            }
        }

        async function markNotificationRead(id){
            try{
                await apiFetch(`/notifications/${id}/read`, { method:'PUT' });
                await loadNotificationCount();
            }catch{}
        }

        async function deleteNotification(id){
            if(!confirm('Remove this notification?')) return;
            try{
                await apiFetch(`/notifications/${id}`, { method:'DELETE' });
                await openNotifications();
                await loadNotificationCount();
            }catch(err){
                alert('Could not remove notification: ' + err.message);
            }
        }

        async function clearAllNotifications(){
            if(!confirm('Clear all notifications?')) return;
            try{
                await apiFetch('/notifications/clear-all', { method:'DELETE' });
                await openNotifications();
                await loadNotificationCount();
            }catch(err){
                alert('Could not clear notifications: ' + err.message);
            }
        }

        async function markAllNotificationsRead(){
            try{
                await apiFetch('/notifications/read-all', { method:'PUT' });
                await openNotifications();
                await loadNotificationCount();
            }catch(err){
                alert('Could not mark notifications as read: ' + err.message);
            }
        }

        async function goToNotificationTarget(id, target){
            await markNotificationRead(id);
            window.location.href = target;
        }

        async function openNotifications(){
            const modal = document.getElementById('notificationsModal');
            const list = document.getElementById('notifList');
            if(!modal || !list) return;

            modal.style.display='flex';
            list.innerHTML='<p style="text-align:center;color:var(--text-light);padding:1rem;">Loading...</p>';

            try{
                const data = await apiFetch('/notifications');
                const notifications = Array.isArray(data.notifications) ? data.notifications : [];

                if(!notifications.length){
                    list.innerHTML='<p style="text-align:center;color:var(--text-light);padding:1.5rem;">No notifications yet.</p>';
                    return;
                }

                notifications.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
                const hasUnread = notifications.some(n => !n.isRead);

                const tools = `
                    <div style="display:flex;justify-content:flex-end;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--border);background:white;position:sticky;top:0;z-index:1;">
                        ${hasUnread ? '<button onclick="markAllNotificationsRead()" style="border:1px solid var(--border);background:white;color:var(--primary);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Mark all read</button>' : ''}
                        <button onclick="clearAllNotifications()" style="border:1px solid #e6b0b0;background:white;color:#c0392b;padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Clear all</button>
                    </div>`;

                const items = notifications.map(n => {
                    const dest = notificationDestination(n);
                    const unreadStyle = n.isRead ? '' : 'background:#f0f7f0;border-left:3px solid var(--primary);';
                    const clickAction = dest
                        ? `goToNotificationTarget(${n.id}, '${dest}')`
                        : `markNotificationRead(${n.id})`;

                    return `
                        <div class="notification-item" style="display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:1rem;border-bottom:1px solid var(--border);${unreadStyle}">
                            <div onclick="${clickAction}" style="flex:1;cursor:pointer;min-width:0;">
                                <p style="font-weight:${n.isRead ? '400' : '700'};font-size:.9rem;margin:0 0 .2rem;color:var(--text-dark);">${escapeHtml(n.title || '')}</p>
                                <p style="font-size:.82rem;color:#555;margin:0 0 .25rem;line-height:1.45;">${escapeHtml(n.message || '')}</p>
                                <p style="font-size:.75rem;color:#aaa;margin:0;">${formatDateTime(n.createdAt)}</p>
                                ${dest ? '<p style="font-size:.72rem;color:var(--primary);margin:.35rem 0 0;">Open related page →</p>' : ''}
                            </div>
                            <button onclick="event.stopPropagation();deleteNotification(${n.id})" title="Remove notification" style="border:none;background:none;color:#c0392b;cursor:pointer;font-size:1rem;line-height:1;padding:.15rem .25rem;">&#215;</button>
                        </div>`;
                }).join('');

                list.innerHTML = tools + items;
            }catch{
                list.innerHTML='<p style="text-align:center;color:var(--text-light);padding:1rem;">Could not load notifications.</p>';
            }
        }

        let pediaApptChart, pediaReviewChart;

        function initPediaCharts() {
            pediaApptChart = new Chart(document.getElementById('pediaApptChart'), {
                type: 'doughnut',
                data: { labels: ['Pending', 'Approved', 'Completed'], datasets: [{ data: [0,0,0], backgroundColor: ['#F4D89F','#6B8E6F','#8BA98D'] }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
            });
            // Both bars are ASSESSMENT counts over the same set of patients.
            // This chart previously plotted reviewedAssessments against
            // pendingAppointments — assessments and appointments are different
            // units, and putting them on one axis invited reading them as
            // parts of a single whole. They are not.
            pediaReviewChart = new Chart(document.getElementById('pediaReviewChart'), {
                type: 'bar',
                data: { labels: ['Reviewed', 'Not yet reviewed'], datasets: [{ data: [0,0], backgroundColor: ['#8BA98D','#F4D89F'] }] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    indexAxis: 'y',
                    scales: { x: { beginAtZero: true, title: { display: true, text: 'Completed assessments' } } }
                }
            });
        }

        function updatePediaCharts(summary) {
            if (pediaApptChart) {
                pediaApptChart.data.datasets[0].data = [summary.pendingAppointments || 0, summary.approvedAppointments || 0, summary.completedAppointments || 0];
                pediaApptChart.update();
            }
            if (pediaReviewChart) {
                pediaReviewChart.data.datasets[0].data = [summary.reviewedAssessments || 0, summary.unreviewedAssessments || 0];
                pediaReviewChart.update();
            }
        }

        async function loadPediaAnalytics() {
            try {
                const data = await apiFetch('/admin/analytics/pediatrician');
                console.log('[Pedia Analytics] Response:', data);
                updatePediaCharts(data.summaryTotals || {});
            } catch (err) {
                console.error('[Pedia Analytics] Error:', err);
            }
        }

        function closeNotifications(){
            document.getElementById('notificationsModal').style.display='none';
        }

        document.addEventListener('click',e=>{if(!e.target.closest('.profile-btn'))document.getElementById('profileMenu').style.display='none';});
        document.addEventListener('DOMContentLoaded',()=>{initPediaCharts();loadDashboard();loadPediaAnalytics();loadNotificationCount();setInterval(()=>{loadDashboard();loadPediaAnalytics();loadNotificationCount();},5000);});
