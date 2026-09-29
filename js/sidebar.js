// DigiSmart ERP — Sidebar Component

// ── Top of the sidebar: this school's name (saved at login) and logo ──
function sbSchoolName() {
  var n = '';
  try { n = sessionStorage.getItem('school_name') || ''; } catch (e) {}
  return (n && n !== 'undefined' && n !== 'null') ? n : 'DigiSmart ERP';
}
function sbTagline() {
  var staff = (typeof STAFF_NAME !== 'undefined' && STAFF_NAME) ? STAFF_NAME : '';
  return staff ? 'Staff: ' + staff : 'DigiSmart ERP';
}
function sbInitials(name) {
  // a short capital first word is the school's own short name: "A.R.K. Global…" / "ARK Global…" -> ARK
  var first = String(name || '').trim().split(/\s+/)[0].replace(/\./g, '');
  if (/^[A-Z]{2,4}$/.test(first)) return first;
  return String(name || 'DS').replace(/[^A-Za-z\s]/g, ' ').trim().split(/\s+/)
    .filter(function (w) { return w.length > 0; }).slice(0, 2)
    .map(function (w) { return w[0]; }).join('').toUpperCase() || 'DS';
}
function sbEsc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
// The school logo saved in I-Card settings, if there is one
async function sbLoadLogo() {
  try {
    if (typeof supabase === 'undefined' || typeof SCHOOL_ID === 'undefined') return;
    var r = await supabase.from('icard_settings').select('logo_url').eq('school_id', SCHOOL_ID).limit(1);
    var url = r && r.data && r.data[0] && r.data[0].logo_url;
    var box = document.getElementById('brand-logo');
    if (url && box && /^(https:|data:image\/)/.test(url)) {
      box.innerHTML = '<img src="' + sbEsc(url) + '" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:inherit;background:#fff">';
    }
  } catch (e) {}
}
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
      { id: 'face', icon: '🧑‍🏫', label: 'Staff Attendance', href: 'face-attendance.html' },
      { id: 'student-att', icon: '✅', label: 'Student Attendance', href: 'student-attendance.html' },
    ]},
    { group: 'Academic', items: [
      { id: 'admission', icon: '📝', label: 'Admission', href: 'admission.html' },
      { id: 'exam', icon: '📄', label: 'Exam Management', href: 'exam.html' },
      { id: 'exam', icon: '📝', label: 'TN Term Card', href: 'tn-term-card.html' },
      { id: 'icard', icon: '🪪', label: 'I-Card & Timetable', href: 'icard.html' },
      { id: 'certificates', icon: '📜', label: 'Certificates', href: 'certificates.html' },
      { id: 'defaulters', icon: '📋', label: 'HW & Test Defaulters', href: 'defaulters.html' },
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
      { id: 'communication', icon: '🎯', label: 'Foundation Questions', href: 'foundation-questions.html' },
      { id: 'communication', icon: '📸', label: 'School Gallery', href: 'gallery.html' },
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
      <div class="brand-logo" id="brand-logo">${sbEsc(sbInitials(sbSchoolName()))}</div>
      <div class="brand-text">
        <div class="name" style="line-height:1.3">${sbEsc(sbSchoolName())}</div>
        <div class="tagline">${sbEsc(sbTagline())}</div>
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
  sbLoadLogo();

  // Build the mobile menu button + overlay (phones only)
  mountMobileMenu();
}

// ══ MOBILE MENU ══
// On phones the sidebar slides off screen. This adds the ☰ button
// to the top bar and a dark overlay behind the open menu, then
// wires up open / close. On desktop both stay hidden by CSS,
// so nothing about the laptop view changes.
function mountMobileMenu() {
  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // 1. Dark overlay behind the drawer (create once)
  var overlay = document.getElementById('sidebar-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'sidebar-overlay';
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', closeSidebar);
  }

  // 2. The ☰ button, placed at the start of the top bar (create once)
  var bar = document.querySelector('.topbar-left');
  if (bar && !document.getElementById('mobile-menu-btn')) {
    var btn = document.createElement('button');
    btn.id = 'mobile-menu-btn';
    btn.className = 'mobile-menu-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open menu');
    btn.innerHTML = '\u2630';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleSidebar();
    });
    bar.insertBefore(btn, bar.firstChild);
  }

  // 3. Tapping any menu link closes the drawer before navigating
  sidebar.addEventListener('click', function (e) {
    if (e.target.closest('.nav-item')) closeSidebar();
  });
}

function openSidebar() {
  var s = document.getElementById('sidebar');
  var o = document.getElementById('sidebar-overlay');
  if (s) s.classList.add('open');
  if (o) o.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeSidebar() {
  var s = document.getElementById('sidebar');
  var o = document.getElementById('sidebar-overlay');
  if (s) s.classList.remove('open');
  if (o) o.classList.remove('show');
  document.body.style.overflow = '';
}

function toggleSidebar() {
  var s = document.getElementById('sidebar');
  if (s && s.classList.contains('open')) closeSidebar();
  else openSidebar();
}

// Back button on Android should close the menu, not leave the page
window.addEventListener('resize', function () {
  if (window.innerWidth > 768) closeSidebar();
});

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
