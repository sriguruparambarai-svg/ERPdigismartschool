// DigiSmart ERP — Parent Gallery API
// Holds the rules for school photo albums: at most 10 photos an album,
// photos only (no video), stored small, and deleted after one year.
//
// POST { token, action, ... }
//   photo   { data_url }                        → store one photo, return its link
//   create  { title, event_date, target_class, photos[] }
//   list    {}                                  → this school's albums
//   remove  { id }                              → delete an album and its photos
//   cleanup { cron_secret }                     → delete albums past expiry

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const BUCKET = 'gallery';

const MAX_PHOTOS = 10;              // the cap that keeps storage affordable
const MAX_PHOTO_BYTES = 700 * 1024; // a shrunk photo should be ~200KB

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

function verifySessionToken(token) {
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

function mayUse(session) {
  if (!session) return false;
  if (session.role !== 'staff') return true;
  const mods = Array.isArray(session.mods) ? session.mods : [];
  return mods.some(m => String(m).split(':')[0] === 'communication');
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
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'true'
    },
    body: buf
  });
  return { ok: r.ok, raw: await r.text() };
}

async function deletePhoto(path) {
  const key = getServiceKey();
  try {
    await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: 'Bearer ' + key }
    });
  } catch (e) { /* a missing file is not worth failing the delete over */ }
}

function publicUrl(path) {
  return SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + path;
}

// Pull the stored path back out of a link, so delete knows what to remove.
function pathFromUrl(url) {
  const marker = '/storage/v1/object/public/' + BUCKET + '/';
  const i = String(url || '').indexOf(marker);
  return i === -1 ? null : String(url).slice(i + marker.length);
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
    return res.status(400).json({ ok: false, error: 'Bad request body.' });
  }

  const action = String(body.action || '');

  // ── Nightly tidy-up: remove albums past their year ──
  if (action === 'cleanup') {
    const secret = process.env.CRON_SECRET || '';
    if (!secret || String(body.cron_secret || '') !== secret) {
      return res.status(401).json({ ok: false, error: 'Not allowed.' });
    }
    const today = new Date().toISOString().split('T')[0];
    const old = await sb('GET', 'gallery_albums?expires_on=lt.' + today + '&select=id,photos&limit=200');
    if (!old.ok) return res.status(500).json({ ok: false, error: 'Could not read albums.' });

    let removed = 0;
    for (const a of (old.data || [])) {
      for (const url of (a.photos || [])) {
        const p = pathFromUrl(url);
        if (p) await deletePhoto(p);
      }
      await sb('DELETE', 'gallery_albums?id=eq.' + a.id);
      removed++;
    }
    return res.status(200).json({ ok: true, removed: removed });
  }

  const session = verifySessionToken(body.token);
  if (!mayUse(session)) {
    return res.status(401).json({ ok: false, error: 'Please log in again.' });
  }

  const schoolId = String(body.school_id || '').trim();
  if (!schoolId) return res.status(400).json({ ok: false, error: 'School missing.' });

  try {
    // ── One photo at a time, already shrunk by the browser ──
    if (action === 'photo') {
      const dataUrl = String(body.data_url || '');
      const m = dataUrl.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
      if (!m) return res.status(400).json({ ok: false, error: 'Only photos can be uploaded, not videos or other files.' });

      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_PHOTO_BYTES) {
        return res.status(400).json({ ok: false, error: 'That photo is too large. It should be shrunk before uploading.' });
      }

      const path = schoolId + '/' + new Date().toISOString().slice(0, 7) + '/'
                 + crypto.randomUUID() + '.jpg';
      const up = await storePhoto(buf, path);
      if (!up.ok) return res.status(500).json({ ok: false, error: 'Could not store the photo: ' + up.raw });

      return res.status(200).json({ ok: true, url: publicUrl(path) });
    }

    // ── Create the album once its photos are up ──
    if (action === 'create') {
      const title = String(body.title || '').trim();
      const eventDate = String(body.event_date || '').trim();
      const targetClass = String(body.target_class || 'all').trim();
      const photos = Array.isArray(body.photos) ? body.photos : [];

      if (!title) return res.status(400).json({ ok: false, error: 'Please give the album a name.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return res.status(400).json({ ok: false, error: 'Please pick the event date.' });
      if (photos.length === 0) return res.status(400).json({ ok: false, error: 'Please add at least one photo.' });
      if (photos.length > MAX_PHOTOS) return res.status(400).json({ ok: false, error: 'An album can hold at most ' + MAX_PHOTOS + ' photos.' });
      for (const u of photos) {
        if (!pathFromUrl(u)) return res.status(400).json({ ok: false, error: 'One of the photos is not a stored photo.' });
      }

      const ins = await sb('POST', 'gallery_albums', [{
        school_code: schoolId,
        title: title,
        event_date: eventDate,
        target_class: targetClass,
        photos: photos,
        created_by: (session && session.role === 'staff') ? 'Staff' : 'Admin'
      }]);
      if (!ins.ok) return res.status(500).json({ ok: false, error: 'Could not save the album: ' + ins.raw });

      return res.status(200).json({ ok: true, album: (ins.data || [])[0] });
    }

    if (action === 'list') {
      const r = await sb('GET',
        'gallery_albums?school_code=eq.' + encodeURIComponent(schoolId)
        + '&select=*&order=event_date.desc&limit=200');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load albums.' });
      return res.status(200).json({ ok: true, rows: r.data || [] });
    }

    if (action === 'remove') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ ok: false, error: 'Album missing.' });

      const got = await sb('GET',
        'gallery_albums?id=eq.' + encodeURIComponent(id)
        + '&school_code=eq.' + encodeURIComponent(schoolId) + '&select=id,photos');
      if (!got.ok || !got.data || got.data.length === 0) {
        return res.status(400).json({ ok: false, error: 'That album was not found.' });
      }
      for (const url of (got.data[0].photos || [])) {
        const p = pathFromUrl(url);
        if (p) await deletePhoto(p);
      }
      const del = await sb('DELETE',
        'gallery_albums?id=eq.' + encodeURIComponent(id)
        + '&school_code=eq.' + encodeURIComponent(schoolId));
      if (!del.ok) return res.status(500).json({ ok: false, error: 'Could not delete the album.' });

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + (e.message || e) });
  }
};
