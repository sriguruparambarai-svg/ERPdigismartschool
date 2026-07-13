// DigiSmart ERP — Sidebar Component
// Call renderSidebar('admission') to highlight the correct nav item

async function renderSidebar(activePage) {
  // ── PAGE GUARD (Staff Logins feature) ──
  // If a staff member opens a page they don't have permission for
  // (even by typing the URL directly), send them back to Dashboard.
  if (typeof hasModuleAccess === 'function' && !hasModuleAccess(activePage)) {
    window.location.href = 'dashboard.html';
    return;
  }

  const nav = [
    { group: 'Overview', items: [
      { id: 'dashboard', icon: '🏠', label: 'Dashboard', href: 'dashboard.html' },
    ]},
    { group: 'Attendance', items: [
      { id: 'face', icon: '📷', label: 'Face Recognition', href: 'face-attendance.html' },
      { id: 'student-att', icon: '✅', label: 'Student Attendance', href: 'student-attendance.html' },
    ]},
    { group: 'Academic', items: [
      { id: 'admission', icon: '📝', label: 'Admission', href: 'admission.html' },
      { id: 'exam', icon: '📄', label: 'Exam Management', href: 'exam.html' },
      { id: 'icard', icon: '🪪', label: 'I-Card & Timetable', href: 'icard.html' },
      { id: 'certificates', icon: '📜', label: 'Certificates', href: 'certificates.html' },
    ]},
    { group: 'Finance', items: [
      { id: 'fee', icon: '💰', label: 'Fee Management', href: 'fee.html' },
      { id: 'billing', icon: '🧾', label: 'Billing & Accounts', href: 'billing.html' },
    ]},
    { group: 'Staff & HR', items: [
      { id: 'hrm', icon: '👥', label: 'HRM & Salary', href: 'hrm.html' },
      { id: 'frontoffice', icon: '🏢', label: 'Front Office', href: 'frontoffice.html' },
    ]},
    { group: 'Transport', items: [
      { id: 'transport', icon: '🚌', label: 'Transport & GPS', href: 'transport.html' },
    ]},
    { group: 'Communication', items: [
      { id: 'communication', icon: '📣', label: 'Parent Communication', href: 'communication.html' },
    ]},
  ];

  // Feature-flagged: 5-Year Scheme only shows for schools with has_scheme = true
  try {
    const { data } = await supabase.from('schools').select('has_scheme').eq('school_id', SCHOOL_ID).single();
    if (data && data.has_scheme) {
      nav.find(g => g.group === 'Finance').items.push({ id:'scheme', icon:'🎓', label:'5-Year Scheme', href:'scheme.html' });
    }
  } catch(e) { /* fails silently — menu just won't show if flag can't be checked */ }

  // ── Owner-only: Staff Logins management page ──
  if (typeof USER_ROLE === 'undefined' || USER_ROLE !== 'staff') {
    nav.push({ group: 'Settings', items: [
      { id: 'staff-logins', icon: '🔐', label: 'Staff Logins', href: 'staff-logins.html' },
    ]});
  }

  // ── Filter menu by permissions (owner sees everything, staff sees ticked modules) ──
  const visibleNav = nav
    .map(group => ({
      group: group.group,
      items: group.items.filter(item => typeof hasModuleAccess !== 'function' || hasModuleAccess(item.id))
    }))
    .filter(group => group.items.length > 0);

  let html = `
    <div class="sidebar-brand">
      <div class="brand-logo">DS</div>
      <div class="brand-text">
        <div class="name">DigiSmart ERP</div>
        <div class="tagline">School Management</div>
      </div>
    </div>
    <div style="margin:0 14px 12px">
      <a href="javascript:void(0)" onclick="erpLogout()" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:7px 10px;border:1px solid rgba(255,255,255,.2);border-radius:8px;color:#E8C99A;font-size:12px;font-weight:600;text-decoration:none">
        🚪 Logout
      </a>
    </div>
  `;

  // Small badge showing who is logged in (staff only)
  if (typeof USER_ROLE !== 'undefined' && USER_ROLE === 'staff' && typeof STAFF_NAME !== 'undefined' && STAFF_NAME) {
    html += `<div style="margin:0 14px 10px;padding:8px 10px;background:rgba(255,255,255,.08);border-radius:8px;font-size:11px;color:#E8C99A">
      👤 ${STAFF_NAME} <span style="opacity:.7">· Staff</span>
    </div>`;
  }

  visibleNav.forEach(group => {
    html += `<div class="nav-group"><div class="nav-group-label">${group.group}</div>`;
    group.items.forEach(item => {
      const isActive = item.id === activePage;
      html += `<a href="${item.href}" class="nav-item ${isActive ? 'active' : ''}">
        <span class="icon">${item.icon}</span>${item.label}
      </a>`;
    });
    html += `</div>`;
  });

  document.getElementById('sidebar').innerHTML = html;
}

// ── Logout: clears the session and returns to the login page ──
async function erpLogout() {
  try {
    if (typeof supabase !== 'undefined' && supabase.auth) {
      await supabase.auth.signOut();
    }
  } catch (e) { /* ignore — clearing session below is what matters */ }
  sessionStorage.clear();
  window.location.href = '../index.html';
}
