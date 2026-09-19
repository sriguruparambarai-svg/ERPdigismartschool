// DigiSmart ERP — Push Alerts API
// Sends free phone notifications to parents who tapped "Turn on alerts".
// No outside package: the Web Push encryption (RFC 8291) and the VAPID
// signature (RFC 8292) are done with Node's built-in crypto.
//
// POST { action: 'public_key' }                               → key the phone needs
// POST { token (parent), action: 'subscribe', subscription }  → save this phone
// POST { token (parent), action: 'unsubscribe', endpoint }    → forget this phone
// POST { token (parent), action: 'status', endpoint }         → is this phone on?
// POST { token (staff),  action: 'notify_comm', comm_id }     → notice / homework / event / consent
// POST { token (staff),  action: 'notify_results', exam_id }  → results published
// POST { token (staff),  action: 'notify_defaulters', ids }   → homework / class test messages
// POST { token (staff),  action: 'stats' }                    → how many parents are on
// GET  /api/push?job=absent    (Vercel cron, Bearer CRON_SECRET) → today's absent alerts
// GET  /api/push?job=birthday  (Vercel cron, Bearer CRON_SECRET) → today's birthday wishes
//
// Vercel settings needed: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (and the existing
// SUPABASE_SERVICE_KEY, CRON_SECRET).

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const BASE = 'https://erp.digismartschool.com';
const VAPID_SUBJECT = 'mailto:info@digismartschool.com';

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

// ── Tokens (same seal as parent-data.js and fee-data.js) ──
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
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status));
  return data;
}

const enc = encodeURIComponent;

// ══ Web Push crypto ══
function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }

// Encrypts the message so only this parent's phone can read it (aes128gcm)
function encryptPayload(plaintext, p256dhB64u, authB64u) {
  const uaPublic = fromB64u(p256dhB64u);
  const authSecret = fromB64u(authB64u);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).slice(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).slice(0, 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(65, 20);
  return Buffer.concat([header, asPublic, body]);
}

// Signs "this message really comes from DigiSmart" for the phone's push service
function vapidAuthHeader(endpoint) {
  const pub = fromB64u(process.env.VAPID_PUBLIC_KEY);
  const priv = fromB64u(process.env.VAPID_PRIVATE_KEY);
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT }));
  const unsigned = head + '.' + body;
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: b64u(priv), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)) }
  });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + unsigned + '.' + b64u(sig) + ', k=' + b64u(pub);
}

// Sends one alert to one phone. Returns 'ok', 'gone' (phone unsubscribed) or 'fail'.
async function sendOne(sub, message, urgent) {
  try {
    const bodyBuf = encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthHeader(sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: urgent ? 'high' : 'normal'
      },
      body: bodyBuf
    });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'ok' : 'fail';
  } catch (e) { return 'fail'; }
}

// Sends to many phones, a few at a time; removes phones that no longer exist
async function sendToSubs(subs, buildMessage, urgent) {
  let sent = 0, failed = 0;
  const gone = [];
  for (let i = 0; i < subs.length; i += 20) {
    const batch = subs.slice(i, i + 20);
    const results = await Promise.all(batch.map(s => sendOne(s, buildMessage(s), urgent)));
    results.forEach((r, j) => {
      if (r === 'ok') sent++;
      else if (r === 'gone') gone.push(batch[j].id);
      else failed++;
    });
  }
  if (gone.length) {
    try { await sb('DELETE', 'push_subscriptions?id=in.(' + gone.map(enc).join(',') + ')'); } catch (e) {}
  }
  return { sent, failed, removed: gone.length };
}

// Records that an alert went out, so it is never sent twice.
// Returns false if it was already logged.
async function logOnce(schoolId, kind, ref) {
  try {
    const rows = await sb('POST', 'push_log?on_conflict=school_id,kind,ref',
      [{ school_id: schoolId, kind, ref }], 'return=representation,resolution=ignore-duplicates');
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

function parentUrl(schoolId) {
  return BASE + '/parent/index.html?school=' + enc(schoolId);
}
function short(t, n) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Phones of parents whose child is in the given class ('all' = whole school)
async function subsForClass(schoolId, cls, section) {
  const subs = await sb('GET', 'push_subscriptions?school_id=eq.' + enc(schoolId) + '&select=id,student_id,endpoint,p256dh,auth') || [];
  if (!subs.length) return [];
  if (!cls || cls === 'all') return subs;
  let q = 'students?school_id=eq.' + enc(schoolId) + '&status=eq.active&select=id';
  const classes = Array.isArray(cls) ? cls : [cls];
  q += '&class=in.(' + classes.map(c => '"' + String(c).replace(/"/g, '') + '"').join(',') + ')';
  if (section) q += '&section=eq.' + enc(section);
  const stu = await sb('GET', q) || [];
  const ids = new Set(stu.map(s => String(s.id)));
  return subs.filter(s => ids.has(String(s.student_id)));
}

// ══ Birthday wishes (cron, morning) ══
// Every active child whose date of birth falls on today gets one wish: a row
// saved for the parent dashboard to show, and a notification on the parents'
// phones. The same guard as the absent alert stops it going twice, so a manual
// re-run during the day is safe.
function firstName(full) {
  const n = String(full || '').trim().split(/\s+/)[0];
  return n || 'your child';
}

async function runBirthdayJob() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const today = ist.toISOString().slice(0, 10);
  const md = today.slice(5);                       // MM-DD

  // The database cannot filter on month and day alone, so the day's children
  // are picked out here. At a few hundred students this costs nothing.
  const stu = await sb('GET', 'students?status=eq.active&dob=not.is.null&select=id,school_id,full_name,class,dob') || [];
  const born = stu.filter(s => String(s.dob || '').slice(5, 10) === md);
  if (!born.length) return { date: today, birthdays: 0, sent: 0 };

  const ids = born.map(s => String(s.id));
  let subs = [];
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80).map(enc).join(',');
    subs = subs.concat(await sb('GET', 'push_subscriptions?student_id=in.(' + part + ')&select=id,student_id,endpoint,p256dh,auth') || []);
  }

  let sent = 0, skipped = 0, saved = 0;
  for (const s of born) {
    const fresh = await logOnce(s.school_id, 'birthday', today + ':' + s.id);
    if (!fresh) { skipped++; continue; }

    const name = firstName(s.full_name);
    const msg = 'Happy birthday, ' + name + '! Wishing you a very happy year ahead. With love, from everyone at school.';

    // The row is what the parent dashboard shows, so it is saved even for
    // parents who have not turned notifications on.
    try {
      await sb('POST', 'birthday_wishes?on_conflict=student_id,wish_date',
        [{ school_id: s.school_id, student_id: s.id, student_name: s.full_name,
           student_class: s.class || null, wish_date: today, message: msg }],
        'return=minimal,resolution=ignore-duplicates');
      saved++;
    } catch (e) { /* a saved wish already there is fine */ }

    const mine = subs.filter(x => String(x.student_id) === String(s.id));
    if (!mine.length) continue;
    const out = await sendToSubs(mine, () => ({
      title: '🎂 Happy birthday ' + name + '!',
      body: msg,
      tag: 'bday-' + s.id + '-' + today,
      url: parentUrl(s.school_id)
    }), false);
    sent += out.sent;
  }
  return { date: today, birthdays: born.length, saved, sent, already_sent: skipped };
}

// ══ Absent alerts (cron) ══
async function runAbsentJob() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const today = ist.toISOString().slice(0, 10);
  const nice = ist.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });

  const absents = await sb('GET', 'student_attendance?date=eq.' + today + '&status=eq.absent&select=school_id,student_id,student_name') || [];
  if (!absents.length) return { date: today, absents: 0, sent: 0 };

  const ids = [...new Set(absents.map(a => String(a.student_id)))];
  let subs = [];
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80).map(enc).join(',');
    subs = subs.concat(await sb('GET', 'push_subscriptions?student_id=in.(' + part + ')&select=id,school_id,student_id,endpoint,p256dh,auth') || []);
  }

  let sent = 0, skipped = 0;
  for (const a of absents) {
    const mine = subs.filter(s => String(s.student_id) === String(a.student_id));
    if (!mine.length) continue;
    // Only once per child per day, even though the job runs twice
    const fresh = await logOnce(a.school_id, 'absent', today + ':' + a.student_id);
    if (!fresh) { skipped++; continue; }
    const name = a.student_name || 'Your child';
    const out = await sendToSubs(mine, () => ({
      title: '🔴 Absent today',
      body: name + ' was marked absent today (' + nice + '). If this is a mistake, please contact the school.',
      tag: 'absent-' + a.student_id + '-' + today,
      url: parentUrl(a.school_id)
    }), true);
    sent += out.sent;
  }
  return { date: today, absents: absents.length, sent, already_sent: skipped };
}

module.exports = async (req, res) => {
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  // ── Cron ──
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET || '';
    const auth = req.headers.authorization || '';
    const q = req.query || {};
    if (!secret || (auth !== 'Bearer ' + secret && q.cron_secret !== secret)) {
      return res.status(401).json({ ok: false, error: 'Not allowed' });
    }
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return res.status(500).json({ ok: false, error: 'VAPID keys not set in Vercel.' });
    }
    // The cron calls plain /api/push; ?job=absent also works for a manual run
    if (q.job && q.job !== 'absent' && q.job !== 'birthday') return res.status(400).json({ ok: false, error: 'Unknown job' });

    // A birthday is wished on every day of the year, Sundays and holidays too.
    if (q.job === 'birthday') {
      try { return res.status(200).json(Object.assign({ ok: true }, await runBirthdayJob())); }
      catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
    }

    const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
    if (ist.getUTCDay() === 0) return res.status(200).json({ ok: true, skipped: 'Sunday' });
    try { return res.status(200).json(Object.assign({ ok: true }, await runAbsentJob())); }
    catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }

  const action = body.action;

  if (action === 'public_key') {
    if (!process.env.VAPID_PUBLIC_KEY) return res.status(200).json({ ok: false, error: 'Alerts are not set up yet.' });
    return res.status(200).json({ ok: true, key: process.env.VAPID_PUBLIC_KEY });
  }

  const session = verifyToken(body.token);
  if (!session || !session.sid) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  const schoolId = String(session.sid);

  try {
    // ══ Parent actions ══
    if (['subscribe', 'unsubscribe', 'status'].indexOf(action) !== -1) {
      if (session.role !== 'parent' || !session.stu) return res.status(403).json({ ok: false, error: 'Parents only.' });
      const studentId = String(session.stu);

      if (action === 'subscribe') {
        const s = body.subscription || {};
        const keys = s.keys || {};
        if (!/^https:\/\//.test(s.endpoint || '') || !keys.p256dh || !keys.auth) {
          return res.status(400).json({ ok: false, error: 'Invalid subscription.' });
        }
        await sb('POST', 'push_subscriptions?on_conflict=endpoint,student_id', [{
          school_id: schoolId, student_id: studentId, endpoint: s.endpoint,
          p256dh: keys.p256dh, auth: keys.auth, updated_at: new Date().toISOString()
        }], 'return=minimal,resolution=merge-duplicates');
        return res.status(200).json({ ok: true });
      }

      const endpoint = String(body.endpoint || '');
      if (!endpoint) return res.status(200).json({ ok: true, on: false });
      const path = 'push_subscriptions?student_id=eq.' + enc(studentId) + '&endpoint=eq.' + enc(endpoint);

      if (action === 'unsubscribe') {
        await sb('DELETE', path, null, 'return=minimal');
        return res.status(200).json({ ok: true });
      }
      const rows = await sb('GET', path + '&select=id') || [];
      return res.status(200).json({ ok: true, on: rows.length > 0 });
    }

    // ══ Staff actions ══
    if (session.role === 'parent') return res.status(403).json({ ok: false, error: 'Staff only.' });
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return res.status(200).json({ ok: false, error: 'Alerts are not set up yet.' });
    }

    if (action === 'stats') {
      const subs = await sb('GET', 'push_subscriptions?school_id=eq.' + enc(schoolId) + '&select=student_id') || [];
      return res.status(200).json({ ok: true, students_on: new Set(subs.map(s => String(s.student_id))).size });
    }

    if (action === 'notify_comm') {
      // The message text is read from the saved record, never taken from the browser
      const rows = await sb('GET', 'communications?id=eq.' + enc(body.comm_id) + '&school_id=eq.' + enc(schoolId) + '&select=*&limit=1') || [];
      const c = rows[0];
      if (!c) return res.status(404).json({ ok: false, error: 'Not found.' });
      if (!(await logOnce(schoolId, 'comm', String(c.id)))) return res.status(200).json({ ok: true, already_sent: true });

      const icons = { homework: '📚 Homework', event: '🗓 School event', consent_form: '📋 Consent form needed' };
      const heading = icons[c.type] || (c.priority === 'urgent' || c.priority === 'important' ? '📢 Important notice' : '📢 New notice');
      const subs = await subsForClass(schoolId, c.target_class, c.target_section);
      const out = await sendToSubs(subs, () => ({
        title: heading + ': ' + short(c.title, 60),
        body: short(c.message, 140),
        tag: 'comm-' + c.id,
        url: parentUrl(schoolId)
      }), c.priority === 'urgent');
      return res.status(200).json(Object.assign({ ok: true }, out));
    }

    // Homework / class test messages: each goes only to that one child's parent
    if (action === 'notify_defaulters') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(Boolean).slice(0, 500);
      if (!ids.length) return res.status(400).json({ ok: false, error: 'Nothing to notify.' });
      let rows = [];
      for (let i = 0; i < ids.length; i += 80) {
        const part = ids.slice(i, i + 80).map(enc).join(',');
        rows = rows.concat(await sb('GET', 'defaulter_entries?school_id=eq.' + enc(schoolId)
          + '&status=eq.sent&id=in.(' + part + ')&select=id,kind,student_id,subject,message') || []);
      }
      if (!rows.length) return res.status(200).json({ ok: true, sent: 0 });

      const stuIds = [...new Set(rows.map(r => String(r.student_id)))];
      let subs = [];
      for (let i = 0; i < stuIds.length; i += 80) {
        const part = stuIds.slice(i, i + 80).map(enc).join(',');
        subs = subs.concat(await sb('GET', 'push_subscriptions?school_id=eq.' + enc(schoolId)
          + '&student_id=in.(' + part + ')&select=id,student_id,endpoint,p256dh,auth') || []);
      }

      const heads = { homework: '📚 Homework not written', test_not_written: '📝 Class test', test_absent: '📝 Absent for class test', test_low_marks: '📝 Class test marks' };
      let sent = 0, noPhone = 0;
      for (const d of rows) {
        const mine = subs.filter(s => String(s.student_id) === String(d.student_id));
        if (!mine.length) { noPhone++; continue; }
        if (!(await logOnce(schoolId, 'defaulter', String(d.id)))) continue;
        const out = await sendToSubs(mine, () => ({
          title: (heads[d.kind] || '📝 Message from school') + ' · ' + short(d.subject, 30),
          body: short(d.message, 160),
          tag: 'defaulter-' + d.id,
          url: parentUrl(schoolId)
        }), false);
        sent += out.sent;
      }
      return res.status(200).json({ ok: true, sent: sent, no_alerts_on: noPhone });
    }

    if (action === 'notify_results') {
      const rows = await sb('GET', 'exams?id=eq.' + enc(body.exam_id) + '&school_id=eq.' + enc(schoolId) + '&select=id,name,classes,published_to_parents&limit=1') || [];
      const ex = rows[0];
      if (!ex) return res.status(404).json({ ok: false, error: 'Not found.' });
      if (!ex.published_to_parents) return res.status(200).json({ ok: false, error: 'Exam is not published.' });
      if (!(await logOnce(schoolId, 'results', String(ex.id)))) return res.status(200).json({ ok: true, already_sent: true });

      const classes = Array.isArray(ex.classes) && ex.classes.length ? ex.classes : 'all';
      const subs = await subsForClass(schoolId, classes, null);
      const out = await sendToSubs(subs, () => ({
        title: '📝 Results published',
        body: short(ex.name, 60) + ' results are ready. Tap to view marks.',
        tag: 'results-' + ex.id,
        url: parentUrl(schoolId)
      }), false);
      return res.status(200).json(Object.assign({ ok: true }, out));
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

