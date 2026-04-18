// DigiSmart ERP — Supabase Configuration
// This file connects the app to your Supabase database

const SUPABASE_URL = 'https://pzxosqukijwpjdlfdfst.supabase.co';
const SUPABASE_KEY = 'sb_publishable_AeMrzyinAl4n2AifhC-j3A_wRh_nda3';

// For now, one school ID. When we add multi-school login, this will come from the logged-in school.
const SCHOOL_ID = sessionStorage.getItem('digismart_school_id') || 'ark-global-001';

// Initialize Supabase client
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Helper: Show toast notification ──
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
    animation: slideIn 0.2s ease;
    max-width: 320px;
  `;
  toast.textContent = message;

  const style = document.createElement('style');
  style.textContent = '@keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }';
  document.head.appendChild(style);

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ── Helper: Format date DD/MM/YYYY ──
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── Helper: Get initials from name ──
function getInitials(name) {
  if (!name) return '?';
  return name.trim().split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

// ── Helper: Generate Admission Number ──
// Format: YYYY-XXXX  e.g. 2025-0042
async function generateAdmissionNo() {
  const year = new Date().getFullYear();
  const { data, error } = await supabase
    .from('students')
    .select('admission_no')
    .eq('school_id', SCHOOL_ID)
    .like('admission_no', `${year}-%`)
    .order('admission_no', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) {
    return `${year}-0001`;
  }
  const last = parseInt(data[0].admission_no.split('-')[1]) || 0;
  return `${year}-${String(last + 1).padStart(4, '0')}`;
}

// ── Helper: Confirm dialog ──
function confirmAction(message) {
  return window.confirm(message);
}
