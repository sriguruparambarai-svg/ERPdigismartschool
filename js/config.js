// DigiSmart ERP — Supabase Configuration
var SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
var SUPABASE_KEY = 'sb_publishable_7RgXFcDeOipMGoFuPI7XBQ_r_aJpZdL';

// School ID from login session — fallback to ARK2024
var SCHOOL_ID = sessionStorage.getItem('digismart_school_id') || 'ARK2024';
var SCHOOL_CODE = sessionStorage.getItem('digismart_school_code') || 'ARK2024';

// ── Role-based access (Staff Logins feature) ──
// 'owner' = full access (default, keeps all existing logins working exactly as before)
// 'staff' = only the modules ticked by the school owner
var USER_ROLE = sessionStorage.getItem('digismart_role') || 'owner';
var STAFF_NAME = sessionStorage.getItem('digismart_staff_name') || '';
var ALLOWED_MODULES = [];
try {
  ALLOWED_MODULES = JSON.parse(sessionStorage.getItem('digismart_modules') || '[]');
  if (!Array.isArray(ALLOWED_MODULES)) ALLOWED_MODULES = [];
} catch (e) { ALLOWED_MODULES = []; }

// Can the current user open this module? Owner → always yes.
// Staff → only ticked modules (Dashboard always allowed as the landing page).
function hasModuleAccess(moduleId) {
  if (USER_ROLE !== 'staff') return true;
  if (moduleId === 'dashboard') return true;
  // 'Fee Collection Only' permission also opens the Fee page
  if (moduleId === 'fee' && ALLOWED_MODULES.indexOf('fee-collect') !== -1) return true;
  return ALLOWED_MODULES.indexOf(moduleId) !== -1;
}

// True when staff can collect fees but must NOT see totals, reports or settings
function isFeeCollectionOnly() {
  if (USER_ROLE !== 'staff') return false;
  if (ALLOWED_MODULES.indexOf('fee') !== -1) return false; // Full access wins
  return ALLOWED_MODULES.indexOf('fee-collect') !== -1;
}

// Initialize Supabase client
var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Supabase Keepalive ──
async function pingSupabase() {
  try { await supabase.from('schools').select('id').limit(1); } catch(e) {}
}
pingSupabase();
setInterval(pingSupabase, 4 * 60 * 1000);

// ── Query with timeout helper ──
async function queryWithTimeout(queryPromise, timeoutMs = 10000) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Query timed out — please wait 30 seconds and try again.')), timeoutMs)
  );
  return Promise.race([queryPromise, timeout]);
}

// ── Show toast notification ──
function showToast(message, type = 'success') {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px;
    background: ${type === 'success' ? '#2D7A3A' : type === 'error' ? '#A32D2D' : '#185FA5'};
    color: white; padding: 12px 20px; border-radius: 8px;
    font-size: 13px; font-weight: 500; z-index: 9999;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: slideIn 0.2s ease; max-width: 340px;
  `;
  toast.textContent = message;
  const style = document.createElement('style');
  style.textContent = '@keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }';
  document.head.appendChild(style);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Format date DD/MM/YYYY ──
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── Get initials from name ──
function getInitials(name) {
  if (!name) return '?';
  return name.trim().split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

// ── Generate Admission Number ──
async function generateAdmissionNo() {
  const year = new Date().getFullYear();
  const { data, error } = await supabase
    .from('students').select('admission_no')
    .eq('school_id', SCHOOL_ID)
    .like('admission_no', `${year}-%`)
    .order('admission_no', { ascending: false }).limit(1);
  if (error || !data || data.length === 0) return `${year}-0001`;
  const last = parseInt(data[0].admission_no.split('-')[1]) || 0;
  return `${year}-${String(last + 1).padStart(4, '0')}`;
}

// ── Confirm dialog ──
function confirmAction(message) { return window.confirm(message); }

// ── Loading overlay ──
function showLoading(msg = 'Saving...') {
  let el = document.getElementById('global-loader');
  if (!el) {
    el = document.createElement('div');
    el.id = 'global-loader';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9998;display:flex;align-items:center;justify-content:center';
    el.innerHTML = `<div style="background:#fff;border-radius:12px;padding:20px 28px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,.15)">
      <div style="width:20px;height:20px;border:3px solid #E8E0D5;border-top-color:#6B1A1A;border-radius:50%;animation:spin .7s linear infinite"></div>
      <span style="font-size:14px;font-weight:600;color:#6B1A1A" id="loader-msg">${msg}</span>
    </div>`;
    const style = document.createElement('style');
    style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
    document.body.appendChild(el);
  } else {
    document.getElementById('loader-msg').textContent = msg;
    el.style.display = 'flex';
  }
}
function hideLoading() {
  const el = document.getElementById('global-loader');
  if (el) el.style.display = 'none';
}

// ── Academic Year & Lists ──
var ACADEMIC_YEAR = '2026-27';
var ALL_CLASSES = ['LKG','UKG','Class 1','Class 2','Class 3','Class 4','Class 5','Class 6','Class 7','Class 8','Class 9','Class 10','Class 11','Class 12'];
var ALL_SUBJECTS = ['Tamil','English','Mathematics','Science','Social Science','Computer Science','Hindi','Drawing','Physical Education','Other'];
