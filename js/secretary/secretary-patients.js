// === Extracted from SECRETARY\secretary-patients.html (script block 1) ===
requireAuth();

        const currentUser = KC.user();
        if (!currentUser) {
            window.location.href = '/login.html';
        } else if (currentUser.role !== 'secretary') {
            const roleMap = {
                admin: '/admin/admin-dashboard.html',
                pediatrician: '/pedia/pediatrician-dashboard.html',
                parent: '/parent/dashboard.html'
            };
            window.location.href = roleMap[currentUser.role] || '/login.html';
        }

        let patients = [];

        function shortDate(value) {
            if (!value) return '-';
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return '-';
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        function shortDateTime(dateValue, timeValue) {
            return dateValue ? `${shortDate(dateValue)} at ${fmtTime(timeValue || '')}` : '-';
        }

        function calcAge(dob) {
            if (!dob) return '-';
            const birth = new Date(dob);
            if (Number.isNaN(birth.getTime())) return '-';
            const now = new Date();
            let years = now.getFullYear() - birth.getFullYear();
            let months = now.getMonth() - birth.getMonth();
            if (months < 0) {
                years -= 1;
                months += 12;
            }
            if (years <= 0) return `${months} mo`;
            return `${years} yr${years === 1 ? '' : 's'}${months ? ` ${months} mo` : ''}`;
        }

        function statusLabel(status) {
            if (!status) return 'Unknown';
            return String(status).charAt(0).toUpperCase() + String(status).slice(1);
        }

        function searchableText(patient) {
            return [
                patient.childName,
                patient.parentName,
                patient.parentEmail,
                patient.parentPhoneNumber,
                patient.latestAppointmentStatus,
                patient.reason
            ].join(' ').toLowerCase();
        }

        function filteredPatients() {
            const query = document.getElementById('searchInput').value.trim().toLowerCase();
            const status = document.getElementById('statusFilter').value;
            return patients
                .filter((patient) => !status || patient.latestAppointmentStatus === status)
                .filter((patient) => !query || searchableText(patient).includes(query))
                .sort((a, b) => String(a.childName || '').localeCompare(String(b.childName || '')));
        }

        function syncSummary(list) {
            document.getElementById('patientCount').textContent = patients.length;
            document.getElementById('approvedCount').textContent = patients.filter((patient) =>
                ['approved', 'completed'].includes(patient.latestAppointmentStatus)
            ).length;
            document.getElementById('pendingCount').textContent = patients.filter((patient) =>
                patient.latestAppointmentStatus === 'pending'
            ).length;
            document.getElementById('tableMeta').textContent = `${list.length} shown`;
        }

        function renderPatients() {
            const list = filteredPatients();
            const body = document.getElementById('patientsBody');
            syncSummary(list);

            if (!list.length) {
                body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><strong>No patients found</strong><span>Try another search or status filter.</span></div></td></tr>`;
                return;
            }

            body.innerHTML = list.map((patient) => {
                const status = patient.latestAppointmentStatus || patient.status || 'pending';
                const lastVisit = patient.lastVisitDate
                    ? shortDateTime(patient.lastVisitDate, patient.lastVisitTime)
                    : 'No completed visit';

                return `
                    <tr>
                        <td>
                            <p class="primary-line">${escapeHtml(patient.childName || 'Unknown Child')}</p>
                            <p class="sub-line">${escapeHtml(calcAge(patient.childDateOfBirth))} - ${escapeHtml(patient.childGender || 'Gender not set')}</p>
                        </td>
                        <td>
                            <p class="primary-line">${escapeHtml(patient.parentName || 'Unknown Parent')}</p>
                            <p class="sub-line">${escapeHtml(patient.parentEmail || 'No email')}</p>
                            <p class="sub-line">${escapeHtml(patient.parentPhoneNumber || 'No phone on file')}</p>
                        </td>
                        <td>
                            <p class="primary-line">${escapeHtml(lastVisit)}</p>
                        </td>
                        <td>
                            <p class="primary-line">${shortDateTime(patient.latestAppointmentDate, patient.latestAppointmentTime)}</p>
                            <span class="status-chip status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
                        </td>
                        <td>
                            <p class="primary-line">${Number(patient.appointmentCount || 0)}</p>
                            <p class="sub-line">Appointment record${Number(patient.appointmentCount || 0) === 1 ? '' : 's'}</p>
                        </td>
                        <td>
                            <button class="action-btn secondary" onclick="window.location.href='/secretary/secretary-appointments.html'">
                                <img src="/icons/appointment.png" alt="" aria-hidden="true"> Appointments
                            </button>
                        </td>
                    </tr>`;
            }).join('');
        }

        function clearFilters() {
            document.getElementById('searchInput').value = '';
            document.getElementById('statusFilter').value = '';
            renderPatients();
        }

        async function loadProfile() {
            try {
                const data = await apiFetch('/secretary/me');
                const sec = data.secretary;
                document.getElementById('profileMenuName').textContent = `${sec.firstName || ''} ${sec.lastName || ''}`.trim() || 'Clinic Assistant/Secretary';

                const banner = document.getElementById('onBehalfBanner');
                if (sec.linkedPediatrician) {
                    const ped = sec.linkedPediatrician;
                    document.getElementById('pedNameBanner').textContent =
                        `Dr. ${ped.firstName || ''} ${ped.lastName || ''}`.trim() + (ped.clinicName ? ` - ${ped.clinicName}` : '');
                    banner.style.display = 'flex';
                } else {
                    banner.style.cssText = 'display:flex;border-color:#f4d89f;background:#f8e5b5;color:#3d4738;';
                    banner.innerHTML = '<img src="/icons/smart_notif.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> This secretary account is not linked to a pediatrician.';
                }
            } catch (err) {
                document.getElementById('onBehalfBanner').style.display = 'flex';
                document.getElementById('onBehalfBanner').textContent = err.message;
            }
        }

        async function loadPatients() {
            try {
                document.getElementById('tableMeta').textContent = 'Loading...';
                const data = await apiFetch('/secretary/patients');
                patients = Array.isArray(data.patients) ? data.patients : [];
                renderPatients();
            } catch (err) {
                document.getElementById('patientsBody').innerHTML =
                    `<tr><td colspan="6"><div class="empty-state"><strong>Could not load patients</strong><span>${escapeHtml(err.message)}</span></div></td></tr>`;
                document.getElementById('tableMeta').textContent = 'Unavailable';
            }
        }

        document.querySelectorAll('a.logout').forEach((link) => {
            link.addEventListener('click', (event) => {
                event.preventDefault();
                logout();
            });
        });

        document.addEventListener('click', (event) => {
            if (!event.target.closest('.profile-btn') && !event.target.closest('#profileMenu')) {
                document.getElementById('profileMenu').style.display = 'none';
            }
        });

        (async () => {
            await loadProfile();
            await loadPatients();
            loadNotificationCount();
        })();
