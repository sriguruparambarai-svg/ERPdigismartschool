// DigiSmart ERP — Leave Requests API
// Parents apply for leave for their child (the one in their login).
// The office / principal approves or rejects. Certificate photos live in a
// PRIVATE bucket and are only shown through short-lived links.
// At month end, photos from decided requests are deleted (records are kept).
//
// POST { token, action, ... }
//   Parent:
//     apply       { from_date, to_date, reason, note, photo }  photo = shrunk data URL (optional)
//     my_list     {}                                           → this child's requests
//   Office (admin, or staff with the "leave" permission):
//     list        { status }        status = pending | approved | rejected | all
//     decide      { id, decision, reply }   decision = approved | rejected
//   Both:
//     photo_link  { id }            → a 10-minute private link to the photo
//   Nightly job:
//     cleanup     { cron_secret }   → delete photos of decided requests

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const BUCKET = 'leave-photos';

const MAX_PHOTO_BYTES = 700 * 1024; // a shrunk photo should be ~200KB
const MAX_DAYS = 31;                // one request can cover at most a month
const REASONS = ['Sick', 'Family function', 'Travel', 'Other'];

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

// Office only: admins always; staff need the "leave" permission.
function isOffice(s) {
  if (!s || s.role === 'parent') return false;
  if (s.role !== 'staff') return true;
  const mods = Array.isArray(s.mods) ? s.mods : [];
  return mods.some(m => String(m).split(':')[0] === 'leave');
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
  return { ok: r.ok, status: r.status, data, raw: text };
}

async function storePhoto(buf, path) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
    body: buf
  });
  return { ok: r.ok, raw: await r.text() };
}

async function deletePhoto(path) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  return r.ok || r.status === 404; // already gone is fine
}

async function signedLink(path) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/sign/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 600 })
  });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  const rel = d && (d.signedURL || d.signedUrl);
  if (!r.ok || !rel) throw new Error('Could not open the photo: ' + text);
  return SUPABASE_URL + '/storage/v1' + (rel.startsWith('/') ? rel : '/' + rel);
}

function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
}

function dayCount(from, to) {
  return Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Bad request body.' });
  }
  const action = String(body.action || '');

  try {
    // ── Month-end tidy-up: photos of decided requests only ──
    if (action === 'cleanup') {
      const secret = process.env.CRON_SECRET || '';
      if (!secret || String(body.cron_secret || '') !== secret) {
        return res.status(401).json({ ok: false, error: 'Not allowed.' });
      }
      const old = await sb('GET', 'leave_requests?photo_path=not.is.null&status=neq.pending&select=id,photo_path&limit=500');
      if (!old.ok) return res.status(500).json({ ok: false, error: 'Could not read leave requests: ' + old.raw });
      let removed = 0, failed = 0;
      for (const row of (old.data || [])) {
        if (await deletePhoto(row.photo_path)) {
          await sb('PATCH', 'leave_requests?id=eq.' + row.id, { photo_path: null });
          removed++;
        } else {
          failed++; // keep the path so next month tries again
        }
      }
      return res.status(200).json({ ok: true, photos_removed: removed, photos_failed: failed });
    }

    const session = verifyToken(body.token);
    if (!session || !session.sid) {
      return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
    }
    const schoolId = String(session.sid);

    // ══ PARENT: apply for leave ══
    if (action === 'apply') {
      if (!isParent(session)) return res.status(403).json({ ok: false, error: 'Only parents can apply for leave.' });
      const studentId = String(session.stu);

      const from = String(body.from_date || '').trim();
      const to = String(body.to_date || from).trim();
      const reason = String(body.reason || '').trim();
      const note = String(body.note || '').trim().slice(0, 500);

      if (!validDate(from) || !validDate(to)) return res.status(400).json({ ok: false, error: 'Please pick the leave dates.' });
      if (to < from) return res.status(400).json({ ok: false, error: 'The "to" date cannot be before the "from" date.' });
      if (dayCount(from, to) > MAX_DAYS) return res.status(400).json({ ok: false, error: 'One request can cover at most ' + MAX_DAYS + ' days.' });
      if (!REASONS.includes(reason)) return res.status(400).json({ ok: false, error: 'Please choose a reason.' });
      if (reason === 'Other' && !note) return res.status(400).json({ ok: false, error: 'Please write a short note explaining the reason.' });

      // No second request over the same days (unless the earlier one was rejected)
      const clash = await sb('GET', 'leave_requests?student_id=eq.' + encodeURIComponent(studentId)
        + '&status=in.(pending,approved)&from_date=lte.' + to + '&to_date=gte.' + from + '&select=id&limit=1');
      if (!clash.ok) return res.status(500).json({ ok: false, error: 'Could not check earlier requests: ' + clash.raw });
      if (clash.data && clash.data.length) {
        return res.status(400).json({ ok: false, error: 'You have already applied for leave on some of these days.' });
      }

      let photoPath = null;
      if (body.photo) {
        const m = String(body.photo).match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
        if (!m) return res.status(400).json({ ok: false, error: 'Only photos can be attached.' });
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > MAX_PHOTO_BYTES) return res.status(400).json({ ok: false, error: 'That photo is too large. Please try again.' });
        photoPath = schoolId + '/' + new Date().toISOString().slice(0, 7) + '/' + crypto.randomUUID() + '.jpg';
        const up = await storePhoto(buf, photoPath);
        if (!up.ok) return res.status(500).json({ ok: false, error: 'Could not store the photo: ' + up.raw });
      }

      const ins = await sb('POST', 'leave_requests', [{
        school_code: schoolId, student_id: studentId,
        from_date: from, to_date: to, reason: reason, note: note || null, photo_path: photoPath
      }]);
      if (!ins.ok) {
        if (photoPath) await deletePhoto(photoPath);
        return res.status(500).json({ ok: false, error: 'Could not save the request: ' + ins.raw });
      }
      const row = (ins.data || [])[0] || {};
      row.has_photo = !!row.photo_path; delete row.photo_path;
      return res.status(200).json({ ok: true, request: row });
    }

    // ══ PARENT: this child's requests ══
    if (action === 'my_list') {
      if (!isParent(session)) return res.status(403).json({ ok: false, error: 'Parents only.' });
      const r = await sb('GET', 'leave_requests?student_id=eq.' + encodeURIComponent(String(session.stu))
        + '&school_code=eq.' + encodeURIComponent(schoolId) + '&select=*&order=from_date.desc&limit=50');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load leave requests: ' + r.raw });
      const rows = (r.data || []).map(x => { x.has_photo = !!x.photo_path; delete x.photo_path; return x; });
      return res.status(200).json({ ok: true, rows: rows });
    }

    // ══ OFFICE: list requests with student names ══
    if (action === 'list') {
      if (!isOffice(session)) return res.status(403).json({ ok: false, error: 'You do not have permission for leave requests.' });
      const status = String(body.status || 'pending');
      let q = 'leave_requests?school_code=eq.' + encodeURIComponent(schoolId);
      if (['pending', 'approved', 'rejected'].includes(status)) q += '&status=eq.' + status;
      q += '&select=*&order=' + (status === 'pending' ? 'created_at.asc' : 'from_date.desc') + '&limit=300';
      const r = await sb('GET', q);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load leave requests: ' + r.raw });
      const rows = r.data || [];

      const ids = [...new Set(rows.map(x => x.student_id))];
      const names = {};
      for (let i = 0; i < ids.length; i += 100) {
        const part = ids.slice(i, i + 100).map(encodeURIComponent).join(',');
        const s = await sb('GET', 'students?id=in.(' + part + ')&select=id,full_name,class,section,admission_no');
        if (s.ok) for (const st of (s.data || [])) names[String(st.id)] = st;
      }
      for (const x of rows) {
        const st = names[String(x.student_id)] || {};
        x.student_name = st.full_name || 'Unknown student';
        x.class_text = (st.class || '') + (st.section ? ' ' + st.section : '');
        x.admission_no = st.admission_no || '';
        x.days = dayCount(x.from_date, x.to_date);
        x.has_photo = !!x.photo_path; delete x.photo_path;
      }
      return res.status(200).json({ ok: true, rows: rows });
    }

    // ══ OFFICE: approve or reject ══
    if (action === 'decide') {
      if (!isOffice(session)) return res.status(403).json({ ok: false, error: 'You do not have permission for leave requests.' });
      const id = String(body.id || '');
      const decision = String(body.decision || '');
      if (!id) return res.status(400).json({ ok: false, error: 'Request missing.' });
      if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ ok: false, error: 'Please choose Approve or Reject.' });

      const upd = await sb('PATCH',
        'leave_requests?id=eq.' + encodeURIComponent(id)
        + '&school_code=eq.' + encodeURIComponent(schoolId) + '&status=eq.pending',
        {
          status: decision,
          office_reply: String(body.reply || '').trim().slice(0, 300) || null,
          decided_by: String(session.name || session.email || (session.role === 'staff' ? 'Staff' : 'Admin')),
          decided_at: new Date().toISOString()
        });
      if (!upd.ok) return res.status(500).json({ ok: false, error: 'Could not save the decision: ' + upd.raw });
      if (!upd.data || upd.data.length === 0) {
        return res.status(400).json({ ok: false, error: 'This request was not found or was already decided.' });
      }
      const row = upd.data[0];
      row.has_photo = !!row.photo_path; delete row.photo_path;
      return res.status(200).json({ ok: true, request: row });
    }

    // ══ BOTH: private photo link ══
    if (action === 'photo_link') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ ok: false, error: 'Request missing.' });
      let q = 'leave_requests?id=eq.' + encodeURIComponent(id) + '&school_code=eq.' + encodeURIComponent(schoolId);
      if (isParent(session)) q += '&student_id=eq.' + encodeURIComponent(String(session.stu));
      else if (!isOffice(session)) return res.status(403).json({ ok: false, error: 'You do not have permission for leave requests.' });
      const r = await sb('GET', q + '&select=photo_path&limit=1');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load the request: ' + r.raw });
      const p = r.data && r.data[0] && r.data[0].photo_path;
      if (!p) return res.status(400).json({ ok: false, error: 'No photo on this request (photos are removed at month end).' });
      return res.status(200).json({ ok: true, url: await signedLink(p) });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + (e.message || e) });
  }
};
