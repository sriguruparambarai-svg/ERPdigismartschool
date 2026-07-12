// DigiSmart ERP — Parent Data API (Parent Portal 2.0)
// Serves data for exactly ONE child — the one in the parent's signed
// token. A parent can never see any other student's records, and the
// locked fee tables are reachable only through this door.
//
// POST { token, action, ... }
//   attendance      { month: 'YYYY-MM' }  → that month's records
//   fees            {}                    → fee structure + payment history
//   change_password { old_password, new_password }

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function verifyParentToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const payload = Buffer.from(parts[0], 'base64').toString('utf8');
    const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
    if (sig !== parts[1]) return null;
    const d = JSON.parse(payload);
    if (d.role !== 'parent') return null;
    if (Date.now() > d.exp) return null;
    return d; // { sid, stu, role, exp }
  } catch (e) { return null; }
}

function dobMatches(dob, pw) {
  if (!dob) return false;
  const clean = String(dob).split('T')[0];
  const parts = clean.split('-');
  if (parts.length !== 3) return false;
  return pw === (parts[2] + parts[1] + parts[0]) || pw === (parts[0] + parts[1] + parts[2]);
}

async function sb(method, path, bodyObj) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status));
  return data;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!getServiceKey()) {
    return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid request.' });
  }

  // ── Identity: which child does this token belong to? ──
  const session = verifyParentToken(body.token);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  }
  const schoolId = String(session.sid);
  const studentId = String(session.stu);
  const action = body.action;

  try {
    // ══ ATTENDANCE — one month for this child only ══
    if (action === 'attendance') {
      const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : new Date().toISOString().slice(0, 7);
      const rows = await sb('GET', 'student_attendance?student_id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) +
        '&date=gte.' + month + '-01&date=lte.' + month + '-31' +
        '&select=date,status&order=date.asc');
      return res.status(200).json({ ok: true, month: month, records: rows || [] });
    }

    // ══ FEES — this child's class structure + their payment history ══
    if (action === 'fees') {
      const stuRows = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=class&limit=1');
      const cls = stuRows && stuRows[0] ? stuRows[0].class : null;

      let structure = [];
      if (cls) {
        structure = await sb('GET', 'fee_structure?school_id=eq.' + encodeURIComponent(schoolId) +
          '&class=eq.' + encodeURIComponent(cls) + '&select=*') || [];
      }
      const payments = await sb('GET', 'fee_payments?student_id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) +
        '&select=receipt_no,amount_paid,payment_date,payment_mode,fee_head_id,period&order=payment_date.desc') || [];

      const totalFee = structure.reduce((s, r) => s + (parseFloat(r.total_amount) || 0), 0);
      const totalPaid = payments.reduce((s, r) => s + (parseFloat(r.amount_paid) || 0), 0);

      return res.status(200).json({
        ok: true,
        total_fee: totalFee,
        total_paid: totalPaid,
        balance: Math.max(totalFee - totalPaid, 0),
        payments: payments
      });
    }

    // ══ CHANGE PASSWORD ══
    if (action === 'change_password') {
      const oldPw = String(body.old_password || '');
      const newPw = String(body.new_password || '');
      if (newPw.length < 6) {
        return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters.' });
      }

      const rows = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=parent_password_hash,dob&limit=1');
      if (!rows || rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Student record not found.' });
      }
      const s = rows[0];

      let oldOk = false;
      if (s.parent_password_hash) oldOk = s.parent_password_hash === sha256(oldPw);
      else oldOk = dobMatches(s.dob, oldPw);
      if (!oldOk) {
        return res.status(401).json({ ok: false, error: 'Current password is incorrect.' });
      }

      await sb('PATCH', 'students?id=eq.' + encodeURIComponent(studentId), {
        parent_password_hash: sha256(newPw)
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });

  } catch (err) {
    console.error('parent-data error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
};
