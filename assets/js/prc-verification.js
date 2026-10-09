// assets/js/prc-verification.js

document.addEventListener('DOMContentLoaded', function() {
    // ── Listing / Filtering Logic ──
    let verifications = [];
    let currentFilter = 'all';
    let activeModalRequestId = 0;

    const $ = (id) => document.getElementById(id);
    const tableBody = $('prcTableBody');
    const cardView = $('prcCardView');
    const filterTabs = $('prcFilterTabs');
    const toastContainer = $('prcToastContainer');
    const modal = $('prcVerificationModal');
    const modalBody = $('prcModalBody');

    function formatDate(dateStr) {
        if (!dateStr) return '—';
        try {
            return new Date(dateStr).toLocaleDateString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric'
            });
        } catch { return dateStr; }
    }

    function esc(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function statusBadge(status) {
        const map = {
            pending: { cls: 'prc-badge--pending', label: 'Pending' },
            verified: { cls: 'prc-badge--approved', label: 'Approved' },
            approved: { cls: 'prc-badge--approved', label: 'Approved' },
            rejected: { cls: 'prc-badge--rejected', label: 'Rejected' }
        };
        const s = map[status] || map.pending;
        return `<span class="prc-badge ${s.cls}">${s.label}</span>`;
    }

    function capitalize(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function showToast(message, type) {
        type = type || 'success';
        const toast = document.createElement('div');
        toast.className = `prc-toast prc-toast--${type}`;
        toast.innerHTML = `
            <span>${esc(message)}</span>
            <button class="prc-toast-close" onclick="this.parentElement.remove()">&times;</button>
        `;
        toastContainer.appendChild(toast);
        setTimeout(() => {
            if (toast.parentElement) {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(40px)';
                toast.style.transition = 'all 0.3s ease';
                setTimeout(() => toast.remove(), 300);
            }
        }, 4000);
    }

    function setText(id, val) {
        const el = $(id);
        if (el) el.textContent = val;
    }

    async function fetchVerifications(statusFilter) {
        let url = '/prc/verifications';
        if (statusFilter && statusFilter !== 'all') {
            url += '?status=' + encodeURIComponent(statusFilter);
        }
        const data = await apiFetch(url);
        return data.users || [];
    }

    function mapBackendUser(u) {
        return {
            _id: u._id,
            fullName: 'Dr. ' + capitalize(u.firstName) + ' ' + capitalize(u.lastName),
            email: u.email,
            prcNumber: u.prcLicenseNumber || '—',
            specialization: u.specialization || '—',
            regDate: u.prcSubmittedAt || u.createdAt || null,
            status: u.prcVerificationStatus || 'pending',
        };
    }

    function render() {
        const filtered = currentFilter === 'all'
            ? verifications
            : verifications.filter(v => v.status === currentFilter);
        renderTable(filtered);
        renderCards(filtered);
        updateStats();
    }

    function renderTable(items) {
        if (!tableBody) return;
        if (items.length === 0) {
            tableBody.innerHTML = `
                <tr><td colspan="7" class="prc-empty-row">
                    <div style="padding:2rem;">
                        <p style="font-size:1.2rem;margin-bottom:0.5rem;">No verification requests found</p>
                        <p style="color:var(--text-light);">${currentFilter === 'all' ? 'No pediatricians have submitted PRC verification requests yet.' : 'No ' + currentFilter + ' verifications at this time.'}</p>
                    </div>
                </td></tr>`;
            return;
        }
        tableBody.innerHTML = items.map(p => `
            <tr>
                <td><span class="prc-table-name">${esc(p.fullName)}</span></td>
                <td>${esc(p.email)}</td>
                <td>${esc(p.prcNumber)}</td>
                <td>${esc(p.specialization)}</td>
                <td>${formatDate(p.regDate)}</td>
                <td>${statusBadge(p.status)}</td>
                <td>
                    <button class="prc-view-btn" data-id="${esc(p._id)}" onclick="openPrcVerification('${esc(p._id)}')">
                        View Documents
                    </button>
                </td>
            </tr>
        `).join('');
    }

    function renderCards(items) {
        if (!cardView) return;
        if (items.length === 0) {
            cardView.innerHTML = `
                <div class="prc-empty">
                    <span class="prc-empty__icon"></span>
                    <p class="prc-empty-message">No verification requests found</p>
                    <p style="color:var(--text-light);">${currentFilter === 'all' ? 'No pediatricians have submitted PRC verification requests yet.' : 'No ' + currentFilter + ' verifications at this time.'}</p>
                </div>`;
            return;
        }
        cardView.innerHTML = items.map(p => `
            <div class="prc-card prc-card--${p.status}">
                <div class="prc-card__header">
                    <div>
                        <p class="prc-card__name">${esc(p.fullName)}</p>
                        <p class="prc-card__email">${esc(p.email)}</p>
                    </div>
                    ${statusBadge(p.status)}
                </div>
                <div class="prc-card__details">
                    <div class="prc-card__detail-item">
                        <span class="prc-card__detail-label">PRC No.</span>
                        <span class="prc-card__detail-value">${esc(p.prcNumber)}</span>
                    </div>
                    <div class="prc-card__detail-item">
                        <span class="prc-card__detail-label">Specialization</span>
                        <span class="prc-card__detail-value">${esc(p.specialization)}</span>
                    </div>
                    <div class="prc-card__detail-item">
                        <span class="prc-card__detail-label">Registered</span>
                        <span class="prc-card__detail-value">${formatDate(p.regDate)}</span>
                    </div>
                </div>
                <div>
                    <button class="prc-view-btn" data-id="${esc(p._id)}" onclick="openPrcVerification('${esc(p._id)}')">
                        View Documents
                    </button>
                </div>
            </div>
        `).join('');
    }

    function updateStats() {
        setText('statPending', verifications.filter(v => v.status === 'pending').length);
        setText('statApproved', verifications.filter(v => v.status === 'verified' || v.status === 'approved').length);
        setText('statRejected', verifications.filter(v => v.status === 'rejected').length);
    }

    function initFilters() {
        if (!filterTabs) return;
        filterTabs.addEventListener('click', (e) => {
            const tab = e.target.closest('.prc-filter-tab');
            if (!tab) return;
            const status = tab.getAttribute('data-status');
            if (status === currentFilter) return;
            currentFilter = status;
            filterTabs.querySelectorAll('.prc-filter-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            render();
        });
    }

    // ── Modal Logic ──

    function withDocumentToken(url) {
        const token = typeof KC !== 'undefined' && KC.token ? KC.token() : '';
        if (!token || !url || !url.startsWith('/api/prc/document/')) return url;
        if (/[?&]token=/.test(url)) return url;
        return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }

    function normalizeDocumentUrl(rawUrl, pedia) {
        if (!rawUrl) return '';

        const clean = String(rawUrl).trim().replace(/\\/g, '/');
        if (!clean) return '';
        if (/^https?:\/\//i.test(clean)) return clean;
        if (clean.startsWith('/api/prc/document/')) return withDocumentToken(clean);
        if (clean.startsWith('/uploads/')) return clean;
        if (clean.startsWith('uploads/')) return '/' + clean;
        if (clean.startsWith('/')) return clean;

        return withDocumentToken((pedia && pedia.prcDocumentUrl) || ('/api/prc/document/' + pedia._id));
    }

    function buildPrcDocumentCandidates(pedia) {
        const hasDocumentSignal = Boolean(
            pedia && (
                pedia.hasPrcDocument ||
                pedia.prcDocumentStaticUrl ||
                pedia.prcIdDocumentPath ||
                pedia.idDocumentPath ||
                pedia.documentPath ||
                pedia.prcDocumentPath
            )
        );

        if (!hasDocumentSignal) {
            console.log('[PRC] No document signal returned for pediatrician:', pedia?._id);
            return [];
        }

        const rawCandidates = [
            { label: 'static-url', value: pedia.prcDocumentStaticUrl },
            { label: 'secure-endpoint', value: pedia.prcDocumentUrl || ('/api/prc/document/' + pedia._id) },
            { label: 'prcIdDocumentPath', value: pedia.prcIdDocumentPath },
            { label: 'idDocumentPath', value: pedia.idDocumentPath },
            { label: 'legacy-documentPath', value: pedia.documentPath || pedia.prcDocumentPath },
        ];

        const seen = new Set();
        const candidates = [];
        rawCandidates.forEach((candidate) => {
            const url = normalizeDocumentUrl(candidate.value, pedia);
            if (!url || seen.has(url)) return;
            seen.add(url);
            candidates.push({ label: candidate.label, url });
        });

        console.log('[PRC] Document URL candidates:', {
            pediatricianId: pedia?._id,
            hasPrcDocument: pedia?.hasPrcDocument,
            existsOnDisk: pedia?.prcDocumentExistsOnDisk,
            source: pedia?.prcDocumentSource,
            candidates,
        });

        return candidates;
    }

    function showDocumentPlaceholder(preview, title, detail) {
        if (!preview) return;
        preview.innerHTML = `
            <div class="prc-doc-placeholder">
                ${esc(title)}
                ${detail ? `<br><span style="font-size:0.75rem;opacity:0.7;">${esc(detail)}</span>` : ''}
            </div>
        `;
    }

    function wirePrcDocumentPreview(candidates, pedia) {
        const preview = $('prcDocumentPreview');
        const img = $('prcDocumentImage');
        const actions = $('prcDocumentActions');
        const viewBtn = $('prcDocumentViewBtn');
        const downloadLink = $('prcDocumentDownloadLink');
        const hasUploadedDocument = Boolean(
            pedia?.hasPrcDocument ||
            pedia?.prcDocumentStaticUrl ||
            pedia?.prcIdDocumentPath ||
            pedia?.idDocumentPath ||
            pedia?.documentPath ||
            pedia?.prcDocumentPath
        );

        if (!hasUploadedDocument && candidates.length === 0) {
            if (actions) actions.style.display = 'none';
            showDocumentPlaceholder(preview, 'Document Missing', 'No PRC ID file was uploaded for this account.');
            return;
        }

        if (!img || candidates.length === 0) {
            if (actions) actions.style.display = 'none';
            showDocumentPlaceholder(preview, 'Document could not be loaded', 'The API did not return a usable document URL.');
            return;
        }

        let currentIndex = 0;

        function setActionUrl(url) {
            if (viewBtn) {
                viewBtn.onclick = function() { window.open(url, '_blank'); };
            }
            if (downloadLink) {
                downloadLink.href = url;
            }
        }

        function tryCandidate() {
            const candidate = candidates[currentIndex];
            if (!candidate) {
                if (actions) actions.style.display = 'none';
                showDocumentPlaceholder(preview, 'Document could not be loaded', 'A document record exists, but every returned URL failed.');
                console.error('[PRC] All document candidates failed:', {
                    pediatricianId: pedia?._id,
                    candidates,
                });
                return;
            }

            console.log('[PRC] Loading document candidate:', {
                pediatricianId: pedia?._id,
                label: candidate.label,
                url: candidate.url,
            });
            setActionUrl(candidate.url);
            img.src = candidate.url;
        }

        img.onload = function() {
            console.log('[PRC] Document image loaded:', {
                pediatricianId: pedia?._id,
                candidate: candidates[currentIndex],
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
            });
        };

        img.onerror = function() {
            console.warn('[PRC] Document image candidate failed:', {
                pediatricianId: pedia?._id,
                candidate: candidates[currentIndex],
            });
            currentIndex += 1;
            tryCandidate();
        };

        tryCandidate();
    }

    window.openPrcVerification = async function(pediatricianId) {
        if (!modal) {
            console.error('Modal element not found');
            return;
        }

        const requestId = ++activeModalRequestId;
        console.log('[PRC] Opening verification modal for pediatrician ID:', pediatricianId, 'request:', requestId);

        if (modalBody) {
            modalBody.innerHTML = '<div class="text-center p-4"><div class="spinner-border text-primary" role="status"></div><p>Loading pediatrician details...</p></div>';
        }

        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        try {
            const url = `/admin/pediatricians/${pediatricianId}/prc-details`;
            console.log('[PRC] Fetching from:', url);

            const data = await apiFetch(url);
            console.log('[PRC] API response:', data);

            if (requestId !== activeModalRequestId) {
                console.log('[PRC] Ignoring stale modal response:', {
                    pediatricianId,
                    requestId,
                    activeModalRequestId,
                });
                return;
            }

            if (data.success && data.pediatrician) {
                console.log('[PRC] Pediatrician data received:', data.pediatrician);
                renderModalContent(data.pediatrician);
            } else {
                throw new Error(data.message || 'Pediatrician data not found');
            }

        } catch (error) {
            if (requestId !== activeModalRequestId) return;
            console.error('[PRC] Error loading PRC verification data:', error);
            if (modalBody) {
                modalBody.innerHTML = `
                    <div class="alert alert-danger">
                        <strong>Error loading data:</strong> ${error.message}
                    </div>
                `;
            }
        }
    };

    function renderModalContent(pedia) {
        const val = (v) => (v && v !== '' && v !== null && v !== undefined) ? v : '—';

        let prcImageSrc = '';
        if (pedia.prcIdDocumentPath) {
            console.log('[PRC] Document path from backend:', pedia.prcIdDocumentPath);
            if (pedia.prcIdDocumentPath.startsWith('http')) {
                prcImageSrc = pedia.prcIdDocumentPath;
            } else if (pedia.prcIdDocumentPath.startsWith('/')) {
                prcImageSrc = pedia.prcIdDocumentPath;
            } else if (pedia.prcIdDocumentPath.startsWith('uploads/')) {
                prcImageSrc = '/' + pedia.prcIdDocumentPath;
            } else {
                // Filename only — use the secure document serving endpoint
                // Pass token as query param since <img>/<a> tags can't set Authorization headers
                const token = typeof KC !== 'undefined' && KC.token ? KC.token() : '';
                prcImageSrc = '/api/prc/document/' + pedia._id + '?token=' + encodeURIComponent(token);
            }
            console.log('[PRC] Resolved image URL:', prcImageSrc);
        }

        const documentCandidates = buildPrcDocumentCandidates(pedia);
        const hasUploadedDocument = Boolean(
            pedia?.hasPrcDocument ||
            pedia?.prcDocumentStaticUrl ||
            pedia?.prcIdDocumentPath ||
            pedia?.idDocumentPath ||
            pedia?.documentPath ||
            pedia?.prcDocumentPath
        );

        const accountBadge = pedia.accountStatus === 'verified' ? 'approved' : pedia.accountStatus === 'rejected' ? 'rejected' : 'pending';

        const html = `
            <div class="row">
                <div class="col-md-6 mb-4">
                    <h5 class="prc-modal-section-title">Profile Information</h5>
                    <div class="prc-info-grid">
                        <div class="prc-info-item">
                            <span class="prc-info-label">Full Name</span>
                            <span class="prc-info-value">${val(pedia.fullName)}</span>
                        </div>
                        <div class="prc-info-item">
                            <span class="prc-info-label">Email</span>
                            <span class="prc-info-value">${val(pedia.email)}</span>
                        </div>
                        <div class="prc-info-item">
                            <span class="prc-info-label">Phone</span>
                            <span class="prc-info-value">${val(pedia.phone)}</span>
                        </div>
                        <div class="prc-info-item">
                            <span class="prc-info-label">Clinic</span>
                            <span class="prc-info-value">${val(pedia.clinicName)}</span>
                        </div>
                        <div class="prc-info-item">
                            <span class="prc-info-label">Clinic Address</span>
                            <span class="prc-info-value">${val(pedia.clinicAddress)}</span>
                        </div>
                    </div>
                </div>
                <div class="col-md-6 mb-4">
                    <h5 class="prc-modal-section-title">License Details</h5>
                    <div class="prc-info-grid">
                        <div class="prc-info-item">
                            <span class="prc-info-label">PRC License No.</span>
                            <span class="prc-info-value">${val(pedia.prcLicenseNumber)}</span>
                        </div>
                        <div class="prc-info-item">
                            <span class="prc-info-label">License Expiry</span>
                            <span class="prc-info-value">${val(pedia.licenseExpiry)}</span>
                        </div>
                        <div class="prc-info-item">
                            <span class="prc-info-label">Specialization</span>
                            <span class="prc-info-value">${val(pedia.specialization)}</span>
                        </div>
                        <div class="prc-info-item">
                            <span class="prc-info-label">Account Status</span>
                            <span class="prc-info-value"><span class="prc-badge prc-badge--${accountBadge}">${val(pedia.accountStatus)}</span></span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="mt-3">
                <h5 class="prc-modal-section-title">Uploaded Documents</h5>
                <div class="prc-document-card">
                    <h4 class="prc-document-title">PRC ID Card</h4>
                    <div class="prc-document-preview" id="prcDocumentPreview">
                        ${hasUploadedDocument ? `
                            <img id="prcDocumentImage" alt="PRC ID" class="img-fluid rounded border" style="max-height: 300px; width: auto; object-fit: contain;">
                        ` : `
                            <div class="prc-doc-placeholder">Document Missing<br><span style="font-size:0.75rem;opacity:0.7;">No PRC ID file was uploaded for this account.</span></div>
                        `}
                    </div>
                    ${hasUploadedDocument ? `
                        <div class="prc-document-actions" id="prcDocumentActions" style="margin-top:0.75rem;">
                            <button type="button" class="prc-btn prc-btn--small prc-btn--outline" id="prcDocumentViewBtn">
                                <i class="fas fa-eye"></i> View
                            </button>
                            <a href="#" download class="prc-btn prc-btn--small prc-btn--outline" id="prcDocumentDownloadLink">
                                <i class="fas fa-download"></i> Download
                            </a>
                        </div>
                    ` : ''}
                </div>
            </div>

            <div class="prc-action-buttons" style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border);">
                <button type="button" class="prc-btn prc-btn--cancel" data-bs-dismiss="modal">Close</button>
                <div style="display:flex;gap:0.5rem;">
                    <button class="prc-btn prc-btn--reject" onclick="handlePrcAction('${pedia._id}', 'rejected')">Reject</button>
                    <button class="prc-btn prc-btn--approve" onclick="handlePrcAction('${pedia._id}', 'verified')">Approve</button>
                </div>
            </div>
        `;

        if (modalBody) {
            modalBody.innerHTML = html;
            wirePrcDocumentPreview(documentCandidates, pedia);
        }
    }

    window.handlePrcAction = async function(id, action) {
        if (!confirm(`Are you sure you want to ${action} this pediatrician?`)) return;

        try {
            console.log('[PRC] Sending action:', action, 'for ID:', id);
            const result = await apiFetch('/admin/pediatricians/prc-verify', {
                method: 'POST',
                body: JSON.stringify({ id, action })
            });
            console.log('[PRC] Action response:', result);
            if (result.success) {
                alert(`Pediatrician ${action} successfully!`);
                bootstrap.Modal.getInstance(document.getElementById('prcVerificationModal')).hide();
                location.reload();
            } else {
                alert('Error: ' + result.message);
            }
        } catch (e) {
            console.error('[PRC] Action error:', e);
            alert('An error occurred while updating status: ' + e.message);
        }
    };

    // ── URL params handling ──
    function handleUrlParams() {
        const params = new URLSearchParams(window.location.search);
        const pediaId = params.get('pediatricianId');
        if (pediaId) {
            setTimeout(function() {
                if (verifications.some(function(v) { return v._id === pediaId; })) {
                    openPrcVerification(pediaId);
                }
            }, 800);
        }
    }

    // ── Load data ──
    async function loadData() {
        if (tableBody) {
            tableBody.innerHTML = '<tr><td colspan="7"><div class="prc-loading-row"><div class="prc-loading-spinner"></div><span>Loading verification requests...</span></div></td></tr>';
        }
        if (cardView) {
            cardView.innerHTML = '<div class="prc-empty"><div class="prc-loading-spinner" style="margin:0 auto 1rem;"></div><p>Loading verification requests...</p></div>';
        }
        try {
            var raw = await fetchVerifications(currentFilter === 'all' ? null : currentFilter);
            verifications = raw.map(mapBackendUser);
        } catch (err) {
            verifications = [];
            showToast('Failed to load verification data: ' + (err.message || ''), 'error');
        }
        render();
        handleUrlParams();
    }

    // ── Init ──
    initFilters();
    loadData();
});
