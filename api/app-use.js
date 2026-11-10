// DigiSmart ERP — Parent app use: who opened the app, and when (Nov 2026)
// Needs step-parent-seen.sql run once in Supabase.
//
// POST { token, action, ... }
//   Parent:
//     opened     {}               → notes that this child's parent opened the app now
//   Office (owner, or staff with Parent Communication, Fees or Defaulters):
//     list       {}               → every active child with first / last opening
//     last_seen  { ids[] }        → { student_id: last_at } for those children (fee page)
//
// Only the time of opening is kept. Nothing about what the parent did in the app.
const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

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

function isParent(s) {
  return !!(s && s.role === 'parent' && s.stu && s.sid);
}

function canView(s) {
  if (!s || !s.sid || s.role === 'parent') return false;
  if (s.role !== 'staff') return true;
  const mods = Array.isArray(s.mods) ? s.mods : [];
  return mods.some(m => ['communication', 'fee', 'defaulters'].indexOf(String(m).split(':')[0]) !== -1);
}

async function sb(method, path, bodyObj, prefer) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation'
    }
  };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data, raw: text };
}

const enc = encodeURIComponent;
const isUuid = s => /^[0-9a-f-]{36}$/i.test(String(s || ''));

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }

  const session = verifyToken(body.token);
  if (!session) return res.status(401).json({ ok: false, error: 'Please log in again.' });
  const schoolId = String(session.sid);
  const action = body.action;

  try {
    // ══ PARENT: the app was opened ══
    if (action === 'opened') {
      if (!isParent(session)) return res.status(403).json({ ok: false, error: 'Parents only.' });
      // Only the columns sent here change on a repeat visit, so first_at stays the first time.
      const r = await sb('POST', 'parent_app_seen?on_conflict=school_id,student_id',
        [{ school_id: schoolId, student_id: String(session.stu), last_at: new Date().toISOString() }],
        'resolution=merge-duplicates,return=minimal');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not note the visit: ' + r.raw });
      return res.status(200).json({ ok: true });
    }

    if (!canView(session)) return res.status(403).json({ ok: false, error: 'You do not have access to this page.' });

    // ══ OFFICE: every child, with when the parent last opened the app ══
    if (action === 'list') {
      const stu = await sb('GET', 'students?school_id=eq.' + enc(schoolId)
        + '&status=eq.active&select=id,full_name,class,section,mobile&order=class.asc,full_name.asc&limit=5000');
      if (!stu.ok) return res.status(500).json({ ok: false, error: 'Could not load students: ' + stu.raw });
      const seen = await sb('GET', 'parent_app_seen?school_id=eq.' + enc(schoolId)
        + '&select=student_id,first_at,last_at&limit=5000');
      if (!seen.ok) return res.status(500).json({ ok: false, error: 'Could not load app use. Has step-parent-seen.sql been run? ' + seen.raw });
      const map = {};
      (seen.data || []).forEach(x => { map[String(x.student_id)] = x; });
      const rows = (stu.data || []).map(s => {
        const v = map[String(s.id)] || {};
        return { id: s.id, name: s.full_name, class: s.class, section: s.section, mobile: s.mobile || '',
          first_at: v.first_at || null, last_at: v.last_at || null };
      });
      return res.status(200).json({ ok: true, rows });
    }

    // ══ OFFICE: last opening for a few children (fee reminders) ══
    if (action === 'last_seen') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(isUuid).slice(0, 3000);
      const out = {};
      for (let i = 0; i < ids.length; i += 150) {
        const part = ids.slice(i, i + 150);
        const r = await sb('GET', 'parent_app_seen?school_id=eq.' + enc(schoolId)
          + '&student_id=in.(' + part.join(',') + ')&select=student_id,last_at');
        if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load app use: ' + r.raw });
        (r.data || []).forEach(x => { out[String(x.student_id)] = x.last_at; });
      }
      return res.status(200).json({ ok: true, seen: out });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + (e.message || e) });
  }
};
