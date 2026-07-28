// DigiSmart ERP — I-Card Photo Upload API
// The ONLY door for uploading I-Card images: the school logo, student
// photos, and staff photos. Verifies the signed session token from login,
// allows only owners and staff with the I-Card module, and locks every
// upload to the token holder's own school folder inside the public
// `icard-photos` storage bucket. Uses the server-side service key —
// the browser never touches storage directly.
//
// POST { token, target: 'logo' | 'students' | 'staff', record_id, image }
//   image = a data URL (data:image/jpeg;base64,... or data:image/png;base64,...)
//   record_id = student/staff row id (not needed for target 'logo')
// Returns { ok: true, url } — the permanent public URL of the image.

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const BUCKET = 'icard-photos';
const MAX_BYTES = 900 * 1024; // photos are resized in the browser first (~30-60 KB)

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

// ── Verify the signed session token issued at login ──
function verifySessionToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const payload = Buffer.from(parts[0], 'base64').toString('utf8');
    const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
    if (sig !== parts[1]) return null;               // seal broken → reject
    const d = JSON.parse(payload);
    if (Date.now() > d.exp) return null;             // expired → reject
    return d;                                        // { sid, role, mods, exp }
  } catch (e) { return null; }
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

  // ── 1. Identity check ──
  const session = verifySessionToken(body.token);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  }
  const isOwner = session.role === 'owner';
  const hasIcard = Array.isArray(session.mods) && session.mods.indexOf('icard') !== -1;
  if (!isOwner && !hasIcard) {
    return res.status(403).json({ ok: false, error: 'You do not have permission for I-Cards.' });
  }
  const schoolId = String(session.sid || '');
  if (!schoolId || !/^[a-zA-Z0-9_-]+$/.test(schoolId)) {
    return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });
  }

  // ── 2. Validate the request shape ──
  const target = String(body.target || '');
  if (['logo', 'students', 'staff'].indexOf(target) === -1) {
    return res.status(400).json({ ok: false, error: 'Invalid target.' });
  }

  const image = String(body.image || '');
  const m = image.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) {
    return res.status(400).json({ ok: false, error: 'Invalid image data.' });
  }
  const mime = 'image/' + m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > MAX_BYTES) {
    return res.status(400).json({ ok: false, error: 'Image too large. Please choose a smaller photo.' });
  }

  // ── 3. Build the storage path — always inside this school's own folder ──
  let path;
  if (target === 'logo') {
    path = schoolId + '/logo.png';
  } else {
    const id = String(body.record_id || '');
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid record id.' });
    }
    path = schoolId + '/' + target + '/' + id + '.jpg';
  }

  // ── 4. Upload to Supabase Storage with the service key ──
  try {
    const up = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + getServiceKey(),
        'Content-Type': mime,
        'x-upsert': 'true'
      },
      body: buf
    });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      return res.status(500).json({ ok: false, error: 'Upload failed. ' + t.slice(0, 120) });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Upload failed. Please try again.' });
  }

  const url = SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + path;
  return res.status(200).json({ ok: true, url: url });
};
