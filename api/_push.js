// DigiSmart ERP — shared phone-alert sender (Web Push). Same encryption as api/push.js.
// Files starting with "_" are not public API endpoints on Vercel.
const crypto = require('crypto');
const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const VAPID_SUBJECT = 'mailto:info@digismartschool.com';
function getServiceKey() { return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''; }
async function sb(method, path, bodyObj, prefer) {
  const key = getServiceKey();
  const opts = { method, headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: prefer || 'return=representation' } };
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


// Phones of parents of the given students
async function subsForStudents(studentIds) {
  const ids = [...new Set((studentIds || []).map(String))];
  let subs = [];
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80).map(enc).join(',');
    subs = subs.concat(await sb('GET', 'push_subscriptions?student_id=in.(' + part + ')&select=id,school_id,student_id,endpoint,p256dh,auth') || []);
  }
  return subs;
}
function pushReady() { return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY); }

module.exports = { sb, enc, getServiceKey, sendToSubs, logOnce, subsForStudents, pushReady };
