// DigiSmart ERP — Sidebar Component
// Call renderSidebar('admission') to highlight the correct nav item

async function renderSidebar(activePage) {
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
    const { data } = await supabase.from('schools').select('has_scheme').eq('id', SCHOOL_ID).single();
    if (data && data.has_scheme) {
      nav.find(g => g.group === 'Finance').items.push({ id:'scheme', icon:'🎓', label:'5-Year Scheme', href:'scheme.html' });
    }
  } catch(e) { /* fails silently — menu just won't show if flag can't be checked */ }

  let html = `
    <div class="sidebar-brand">
      <div class="brand-logo">DS</div>
      <div class="brand-text">
        <div class="name">DigiSmart ERP</div>
        <div class="tagline">School Management</div>
      </div>
    </div>
  `;

  nav.forEach(group => {
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
