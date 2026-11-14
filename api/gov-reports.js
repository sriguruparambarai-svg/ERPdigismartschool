// DigiSmart ERP — Government reports (Nov 2026)
// The data behind pages/gov-reports.html: every active child's details (for EMIS /
// UDISE+ entry, RTE 25% and class & gender strength) and the staff list (for EMIS staff
// entry and inspections). The page makes the tables and the Excel files.
// Students: owner or staff with Admission. Staff: owner or staff with HRM & Salary.
// Bank details are never sent.
//
// POST { token, action: 'students' } → { ok, school, students }
// POST { token, action: 'staff' }    → { ok, school, staff }

const crypto = require('crypto');
const { sb, enc, getServiceKey } = require('./_push');

function verifyToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const payload = Buffer.from(parts[0], 'base64').toString('utf8');
    const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
    if (sig !== parts[1]) return null;
    const d = JSON.parse(payload);
    if (Date.now() > d.exp) return null;
    return d;
  } catch (e) { return null; }
}
async function getAll(path) {
  let out = [];
  for (let off = 0; off < 100000; off += 1000) {
    const rows = await sb('GET', path + '&limit=1000&offset=' + off) || [];
    out = out.concat(rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const STUDENT_COLS = ['id', 'admission_no', 'roll_no', 'emis_id', 'full_name', 'full_name_tamil', 'dob', 'gender', 'blood_group', 'aadhar',
  'religion', 'caste', 'mother_tongue', 'father_name', 'mother_name', 'father_occupation', 'mobile', 'whatsapp', 'email', 'address',
  'city', 'district', 'pincode', 'class', 'section', 'academic_year', 'admission_date', 'prev_school', 'tc_number', 'is_rte', 'status'];
const STAFF_COLS = ['id', 'employee_id', 'name', 'dob', 'gender', 'mobile', 'email', 'aadhar', 'qualification', 'address', 'role',
  'department', 'date_of_joining', 'employment_type', 'status'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
  const s = verifyToken(body.token);
  if (!s || !s.sid) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  const mods = Array.isArray(s.mods) ? s.mods : [];
  const sid = enc(String(s.sid));
  const action = String(body.action || '');
  const school = (await sb('GET', 'schools?school_id=eq.' + sid + '&select=name&limit=1').catch(() => []) || [])[0] || {};

  try {
    if (action === 'students') {
      if (!(s.role === 'owner' || mods.indexOf('admission') !== -1)) return res.status(403).json({ ok: false, error: 'You need Admission access for student reports.' });
      // Read every column, then keep only the report columns (some schools' databases lack a few)
      const rows = await getAll('students?school_id=eq.' + sid + '&status=eq.active&select=*&order=class.asc,section.asc,full_name.asc');
      const students = rows.map(r => { const o = {}; STUDENT_COLS.forEach(c => { o[c] = r[c] == null ? '' : r[c]; }); return o; });
      return res.status(200).json({ ok: true, school: school.name || '', students });
    }
    if (action === 'staff') {
      if (!(s.role === 'owner' || mods.indexOf('hrm') !== -1)) return res.status(403).json({ ok: false, error: 'You need HRM access for the staff report.' });
      const rows = await getAll('staff?school_id=eq.' + sid + '&select=*&order=name.asc');
      const staff = rows.filter(r => (r.status || 'active') === 'active').map(r => { const o = {}; STAFF_COLS.forEach(c => { o[c] = r[c] == null ? '' : r[c]; }); return o; });
      return res.status(200).json({ ok: true, school: school.name || '', staff });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
