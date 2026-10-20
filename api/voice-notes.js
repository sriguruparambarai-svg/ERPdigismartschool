// DigiSmart ERP — Voice Messages to parents
// The school office records (or picks) a short voice message and sends it to
// parents of one class, a few classes, or the whole school. Parents hear it in
// the parent app and get a phone alert.
//
// Who may send: the school owner/admin login always; a staff login only if the
// school has ticked "Voice Messages" for that staff member. Each school decides.
//
// How long parents can hear it (the school picks, the server holds the limit):
//   homework  → at most 2 days
//   anything else (exam, instructions, wishes, general) → at most 15 days
// After that the recording and the message are deleted by the nightly job.
//
// POST { token, school_id, action, ... }
//   audio   { data_url }                                   → store one recording, return its link
//   create  { title, kind, days, classes[], audio_url, duration_sec, sender_name }
//   list    {}                                             → this school's messages
//   remove  { id }                                         → delete a message and its recording
//   cleanup { cron_secret }                                → delete messages past their days

const crypto = require('crypto');
const { sendToSubs, logOnce, pushReady } = require('./_push');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const BASE = 'https://erp.digismartschool.com';
const BUCKET = 'voice-notes';

const MAX_AUDIO_BYTES = 3 * 1024 * 1024;   // ~10 minutes of phone-quality voice; keeps uploads quick
const KINDS = {
  homework:     { label: 'Homework',          maxDays: 2 },
  exam:         { label: 'Exam',              maxDays: 15 },
  instructions: { label: 'Instructions',      maxDays: 15 },
  wishes:       { label: 'Wishes',            maxDays: 15 },
  general:      { label: 'General',           maxDays: 15 }
};
const ALL_CLASSES = ['LKG','UKG','Class 1','Class 2','Class 3','Class 4','Class 5','Class 6',
  'Class 7','Class 8','Class 9','Class 10','Class 11','Class 12'];

// The kinds of recording phones make, and the file name each is saved under
const AUDIO_TYPES = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/opus': 'ogg',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'video/webm': 'webm', 'video/mp4': 'm4a'   // some phones label voice-only recordings as video
};

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

// The school decides who sends: owner/admin always, staff only with the "Voice Messages" tick
function mayUse(session) {
  if (!session) return false;
  if (session.role === 'parent') return false;
  if (session.role !== 'staff') return true;
  const mods = Array.isArray(session.mods) ? session.mods : [];
  return mods.some(m => String(m).split(':')[0] === 'voice');
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

async function storeAudio(buf, path, contentType) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body: buf
  });
  return { ok: r.ok, raw: await r.text() };
}

async function deleteAudio(path) {
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

function pathFromUrl(url) {
  const marker = '/storage/v1/object/public/' + BUCKET + '/';
  const i = String(url || '').indexOf(marker);
  return i === -1 ? null : String(url).slice(i + marker.length);
}

// The school's own id as the parent app knows it. The office page may name the
// school by its id or its short code — accepted only if it is this login's school.
async function resolveSchool(session, given) {
  const sid = String((session && session.sid) || '');
  if (!sid || !given) return null;
  const r = await sb('GET', 'schools?or=(school_id.eq.' + encodeURIComponent(sid)
    + ',school_code.eq.' + encodeURIComponent(sid) + ')&select=school_id,school_code&limit=1');
  const s = r.ok && r.data && r.data[0];
  if (!s) return given === sid ? sid : null;
  const ok = given === sid || given === String(s.school_id || '') || given === String(s.school_code || '');
  return ok ? String(s.school_id || sid) : null;
}

// India's date today, plus some days, as YYYY-MM-DD
function istDate(plusDays) {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 + (plusDays || 0) * 86400000);
  return d.toISOString().slice(0, 10);
}

function short(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Phone alerts to parents of the chosen classes (or everyone)
async function alertParents(schoolId, note) {
  if (!pushReady()) return { sent: 0, failed: 0, skipped: 'no phone alerts set up' };
  if (!(await logOnce(schoolId, 'voice', String(note.id)))) return { sent: 0, failed: 0, skipped: 'already sent' };

  const subsRes = await sb('GET', 'push_subscriptions?school_id=eq.' + encodeURIComponent(schoolId)
    + '&select=id,student_id,endpoint,p256dh,auth');
  let subs = (subsRes.ok && subsRes.data) || [];
  if (!subs.length) return { sent: 0, failed: 0 };

  const classes = Array.isArray(note.target_classes) ? note.target_classes : ['all'];
  const stuRes = await sb('GET', 'students?school_id=eq.' + encodeURIComponent(schoolId)
    + '&status=eq.active&select=id,full_name,class');
  const students = (stuRes.ok && stuRes.data) || [];
  const names = {};
  const wanted = new Set();
  students.forEach(s => {
    const first = String(s.full_name || '').trim().split(/\s+/)[0];
    if (first) names[String(s.id)] = first;
    if (classes.indexOf('all') !== -1 || classes.indexOf(String(s.class || '')) !== -1) wanted.add(String(s.id));
  });
  subs = subs.filter(s => wanted.has(String(s.student_id)));

  return await sendToSubs(subs, s => {
    const who = names[String(s.student_id)];
    return {
      title: '🎙 Voice message from school' + (who ? ' · ' + who : ''),
      body: short(note.title, 140) + ' — tap to listen',
      tag: 'voice-' + note.id + '-' + s.student_id,
      url: BASE + '/parent/dashboard.html?child=' + encodeURIComponent(s.student_id)
    };
  }, false);
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

  // ── Nightly tidy-up: remove messages whose days are over ──
  if (action === 'cleanup') {
    const secret = process.env.CRON_SECRET || '';
    if (!secret || String(body.cron_secret || '') !== secret) {
      return res.status(401).json({ ok: false, error: 'Not allowed.' });
    }
    const today = istDate(0);
    const old = await sb('GET', 'voice_notes?expires_on=lt.' + today + '&select=id,audio_url&limit=300');
    if (!old.ok) return res.status(500).json({ ok: false, error: 'Could not read voice messages: ' + old.raw });

    let removed = 0;
    for (const n of (old.data || [])) {
      const p = pathFromUrl(n.audio_url);
      if (p) await deleteAudio(p);
      await sb('DELETE', 'voice_notes?id=eq.' + n.id);
      removed++;
    }
    return res.status(200).json({ ok: true, removed: removed });
  }

  const session = verifySessionToken(body.token);
  if (!mayUse(session)) {
    return res.status(401).json({ ok: false, error: 'This login is not allowed to send voice messages. Please log in again, or ask the school admin to tick "Voice Messages" for you.' });
  }

  const given = String(body.school_id || '').trim();
  if (!given) return res.status(400).json({ ok: false, error: 'School missing.' });
  const schoolId = await resolveSchool(session, given);
  if (!schoolId) {
    return res.status(403).json({ ok: false, error: 'This login cannot send for another school.' });
  }

  try {
    // ── One recording, straight from the phone/computer microphone or a picked file ──
    if (action === 'audio') {
      const dataUrl = String(body.data_url || '');
      const m = dataUrl.match(/^data:((?:audio|video)\/[\w.+-]+)[^,]*?;base64,(.+)$/);
      if (!m) return res.status(400).json({ ok: false, error: 'Only voice recordings can be sent.' });
      const type = m[1].toLowerCase();
      const ext = AUDIO_TYPES[type];
      if (!ext) return res.status(400).json({ ok: false, error: 'This kind of audio file (' + type + ') is not supported. Please record it here instead.' });

      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_AUDIO_BYTES) {
        return res.status(400).json({ ok: false, error: 'The recording is too long. Please keep it under about 10 minutes (3 MB).' });
      }

      const path = schoolId + '/' + istDate(0).slice(0, 7) + '/' + crypto.randomUUID() + '.' + ext;
      const contentType = ext === 'm4a' ? 'audio/mp4' : (type.indexOf('video/') === 0 ? type.replace('video/', 'audio/') : type);
      const up = await storeAudio(buf, path, contentType);
      if (!up.ok) return res.status(500).json({ ok: false, error: 'Could not store the recording: ' + up.raw });

      return res.status(200).json({ ok: true, url: publicUrl(path) });
    }

    // ── Save the message and alert the parents ──
    if (action === 'create') {
      const title = String(body.title || '').trim().slice(0, 200);
      const kind = KINDS[body.kind] ? String(body.kind) : 'general';
      const maxDays = KINDS[kind].maxDays;
      let days = parseInt(body.days, 10);
      if (!(days >= 1)) days = 1;
      if (days > maxDays) {
        return res.status(400).json({ ok: false, error: KINDS[kind].label + ' messages can stay for at most ' + maxDays + ' day(s).' });
      }
      let classes = Array.isArray(body.classes) ? body.classes.map(c => String(c)) : [];
      if (classes.indexOf('all') !== -1) classes = ['all'];
      classes = classes.filter(c => c === 'all' || ALL_CLASSES.indexOf(c) !== -1);
      const audioUrl = String(body.audio_url || '');
      const p = pathFromUrl(audioUrl);
      const duration = Math.max(0, Math.min(900, parseInt(body.duration_sec, 10) || 0));
      const sender = String(body.sender_name || '').trim().slice(0, 80) || 'School Office';

      if (!title) return res.status(400).json({ ok: false, error: 'Please give the message a short title, so parents know what it is about.' });
      if (classes.length === 0) return res.status(400).json({ ok: false, error: 'Please choose who should hear it.' });
      if (!p || p.indexOf(schoolId + '/') !== 0) return res.status(400).json({ ok: false, error: 'Please record the message first.' });

      // Day 1 = today, so "2 days" means today and tomorrow
      const expires = istDate(days - 1);
      const ins = await sb('POST', 'voice_notes', [{
        school_id: schoolId,
        title: title,
        kind: kind,
        target_classes: classes,
        audio_url: audioUrl,
        duration_sec: duration,
        sender_name: sender,
        expires_on: expires
      }]);
      if (!ins.ok) return res.status(500).json({ ok: false, error: 'Could not save the message: ' + ins.raw });
      const note = (ins.data || [])[0] || {};

      let alerts;
      try { alerts = await alertParents(schoolId, note); }
      catch (e) { alerts = { sent: 0, failed: 0, error: String(e.message || e).slice(0, 200) }; }

      return res.status(200).json({ ok: true, note: note, alerts: alerts });
    }

    if (action === 'list') {
      const r = await sb('GET',
        'voice_notes?school_id=eq.' + encodeURIComponent(schoolId)
        + '&select=*&order=created_at.desc&limit=200');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load voice messages: ' + r.raw });
      return res.status(200).json({ ok: true, rows: r.data || [], today: istDate(0) });
    }

    if (action === 'remove') {
      const id = String(body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ ok: false, error: 'Message missing.' });

      const got = await sb('GET',
        'voice_notes?id=eq.' + id + '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=id,audio_url');
      if (!got.ok || !got.data || got.data.length === 0) {
        return res.status(400).json({ ok: false, error: 'That message was not found.' });
      }
      const p = pathFromUrl(got.data[0].audio_url);
      if (p) await deleteAudio(p);
      const del = await sb('DELETE',
        'voice_notes?id=eq.' + id + '&school_id=eq.' + encodeURIComponent(schoolId));
      if (!del.ok) return res.status(500).json({ ok: false, error: 'Could not delete the message.' });

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + (e.message || e) });
  }
};
