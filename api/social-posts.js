// DigiSmart ERP — Social Media Posts API
// The ONLY door for social_posts and social_settings (Row Level Security ON,
// no public policies), and for the public 'social-posts' photo bucket.
//
// Switched on per school by the super admin: schools.has_social = true.
// Who may use it: the owner, and staff with the "Social Media Posts" (social)
// module. Staff with level 'upload' (social:upload) — usually teachers — only
// upload photos; the owner / full-access staff (principal, admin) have the AI
// write the post, edit, approve, post, delete and change settings.
//
// POST { token, action, ... }
//   info      {}                                   → { ok, level, settings, school }
//   photo     { data_url }                         → { ok, url }
//   create    { class_name, note, photos[], checked }  → { ok, row }
//             teacher upload → status 'photos' (no AI); principal upload → AI writes it → 'draft'
//   rewrite   { id, hint? }                        → AI writes / writes again (principal) → { ok, row }
//   list      {}                                   → { ok, rows }
//   edit      { id, caption_en, caption_ta, hashtags }  → { ok, row }
//   approve   { id } | reject { id, note } | posted { id } | gallery_done { id }
//   remove    { id }                               → deletes the post and its photos
//   students  {}                                   → active students for the no-photo list
//   save_settings { no_photo_ids[], footer_line, hashtags, language }
//   cleanup   { cron_secret }                      → photos of finished posts after 90 days

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const BUCKET = 'social-posts';
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 900 * 1024;   // browser shrinks to ~250KB
// Newest model first; the older one is a safety net if the first is unavailable
const AI_MODELS = [process.env.SOCIAL_AI_MODEL || 'claude-sonnet-5-5', 'claude-sonnet-4-5'];
// photos = teacher's upload, not written yet · draft = AI written, principal checking
const STATUSES = ['photos', 'draft', 'approved', 'posted', 'rejected'];

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
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
    return d; // { sid, role, mods, exp }
  } catch (e) { return null; }
}

// 'full' = owner or social full access; 'upload' = add posts only; null = no access
function accessLevel(session) {
  if (!session || session.role === 'parent') return null;
  if (session.role !== 'staff') return 'full';
  const mods = Array.isArray(session.mods) ? session.mods : [];
  for (const m of mods) {
    const p = String(m).split(':');
    if (p[0] === 'social') return p[1] === 'upload' ? 'upload' : 'full';
  }
  return null;
}

async function sb(method, path, bodyObj, extra) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: Object.assign({
      apikey: key, Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json', Prefer: 'return=representation'
    }, extra || {})
  };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) {
    const msg = (data && data.message) || ('Database error ' + r.status + ': ' + text.slice(0, 200));
    if (/social_(posts|settings)|has_social/.test(msg) && /does not exist|not find|schema cache/i.test(msg)) {
      throw new Error('Social Media Posts is not set up yet. Please run the social posts SQL in Supabase once.');
    }
    throw new Error(msg);
  }
  return data;
}

async function storePhoto(buf, path) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
    body: buf
  });
  const raw = await r.text();
  if (!r.ok && /bucket not found/i.test(raw)) throw new Error('The "social-posts" photo folder is missing in Supabase Storage. Please create it (public).');
  return { ok: r.ok, raw };
}
async function deletePhoto(path) {
  const key = getServiceKey();
  try {
    await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path,
      { method: 'DELETE', headers: { apikey: key, Authorization: 'Bearer ' + key } });
  } catch (e) { /* a missing file is not worth failing over */ }
}
function publicUrl(path) { return SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + path; }
function pathFromUrl(url) {
  const marker = '/storage/v1/object/public/' + BUCKET + '/';
  const i = String(url || '').indexOf(marker);
  return i === -1 ? null : String(url).slice(i + marker.length);
}

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function isId(v) { return /^[a-zA-Z0-9-]{1,64}$/.test(String(v || '')); }
function isSchool(v) { return /^[a-zA-Z0-9_-]{2,64}$/.test(String(v || '')); }

// ── AI: look at the photos and write the post ──
async function writeCaption(post, school, settings, hint) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('AI key not configured (ANTHROPIC_API_KEY in Vercel).');

  const lang = settings.language || 'both';
  const content = [];
  (post.photos || []).forEach(u => content.push({ type: 'image', source: { type: 'url', url: u } }));
  content.push({ type: 'text', text:
    'You write social media posts (Instagram and Facebook) for a school in Tamil Nadu, India.\n'
    + 'School: ' + (school.name || 'our school') + (school.city ? ', ' + school.city : '') + '\n'
    + 'Class in the photos: ' + (post.class_name || 'whole school') + '\n'
    + (post.note ? 'What the teacher says happened: ' + post.note + '\n' : '')
    + (hint ? 'Change requested by the principal: ' + hint + '\n' : '')
    + '\nLook at the photos and write ONE post about what the children are doing and learning.\n'
    + 'Rules:\n'
    + '- Warm, proud and simple. 2 to 4 short sentences. Parents in a small town are the readers.\n'
    + '- Only describe what is really visible or what the teacher said. Never invent events, prizes or numbers.\n'
    + '- Never name or identify any child, never mention a child\'s looks, and never guess names from badges or books.\n'
    + '- No religious, political or medical claims. No promises about results or marks.\n'
    + '- One or two fitting emojis at most.\n'
    + '- If a photo is a poster, flyer or banner full of text, give its main message in your own short words — do not copy all of its text, lists or phone numbers.\n'
    + (lang === 'en' ? '- caption_ta must be an empty string.\n'
       : '- caption_ta: the same message in natural, simple written Tamil (not word-for-word, not too formal). Keep class names like "Class 3" or "UKG" as they are.\n')
    + '- hashtags: 5 to 8, no spaces inside a tag, include one tag made from the school name'
    + (school.city ? ' and #' + String(school.city).replace(/[^A-Za-z]/g, '') : '') + '.\n'
    + '- title: 3 to 6 words naming the activity, for the school\'s own list.\n'
    + '- warning: if a photo shows something that should NOT be posted (a child crying or hurt, a child undressed, an ID card / Aadhaar / phone number / marks sheet readable, an accident, or nothing school-related), say which photo number and why in one sentence. Otherwise an empty string.\n'
    + '\nReply with ONLY this JSON, no other text:\n'
    + '{"title":"","caption_en":"","caption_ta":"","hashtags":["#..."],"warning":""}'
  });

  let lastErr = '';
  for (const model of AI_MODELS) {
    // Tamil needs many more AI "tokens" than English, so allow a long reply,
    // and try once more if the reply still comes back cut off or untidy.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: 'user', content }] })
      });
      const raw = await r.text();
      if (!r.ok) {
        lastErr = 'AI error ' + r.status + ': ' + raw.slice(0, 200);
        if (r.status === 404 || /model/i.test(raw)) break;      // try the next model
        throw new Error(lastErr);
      }
      let data; try { data = JSON.parse(raw); } catch (e) { throw new Error('AI reply could not be read.'); }
      const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      const m = text.match(/\{[\s\S]*\}/);
      let out = null;
      if (m) { try { out = JSON.parse(m[0]); } catch (e) { out = null; } }
      if (!out) {
        lastErr = data.stop_reason === 'max_tokens'
          ? 'The AI\'s reply was too long and got cut off. Please press "Write again" (or add a short note).'
          : 'AI did not return a post' + (text ? ' (it said: "' + text.replace(/\s+/g, ' ').slice(0, 160) + '")' : '') + '. Please press "Write again".';
        continue;                                                   // one more try
      }
      const tags = (Array.isArray(out.hashtags) ? out.hashtags : String(out.hashtags || '').split(/\s+/))
        .map(t => String(t).trim().replace(/\s+/g, ''))
        .filter(Boolean).map(t => t.startsWith('#') ? t : '#' + t).slice(0, 10);
      return {
        title: str(out.title, 80),
        caption_en: str(out.caption_en, 1500),
        caption_ta: lang === 'en' ? '' : str(out.caption_ta, 2000),
        hashtags: tags.join(' '),
        ai_warning: str(out.warning, 300)
      };
    }
    if (lastErr && !/^AI error/.test(lastErr)) throw new Error(lastErr);
  }
  throw new Error(lastErr || 'AI is not available right now.');
}

async function getSettings(sid) {
  const rows = (await sb('GET', 'social_settings?school_id=eq.' + encodeURIComponent(sid) + '&select=*&limit=1')) || [];
  const s = rows[0] || {};
  return {
    no_photo_ids: Array.isArray(s.no_photo_ids) ? s.no_photo_ids : [],
    footer_line: s.footer_line != null ? s.footer_line : '📢 Admissions open! Tap the link in our bio to enquire.',
    hashtags: s.hashtags || '',
    language: s.language || 'both',
    logo_corner: ['off', 'br', 'bl', 'tr', 'tl'].indexOf(s.logo_corner) !== -1 ? s.logo_corner : 'br'
  };
}

// The school logo saved in I-Card settings (a public link in this school's own folder)
async function schoolLogo(sid) {
  try {
    const r = (await sb('GET', 'icard_settings?school_id=eq.' + encodeURIComponent(sid) + '&select=logo_url&limit=1')) || [];
    const u = r[0] && r[0].logo_url;
    const ok = SUPABASE_URL + '/storage/v1/object/public/icard-photos/' + sid + '/';
    return (u && String(u).indexOf(ok) === 0) ? u : '';
  } catch (e) { return ''; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
  const action = String(body.action || '');
  const enc = encodeURIComponent;

  try {
    // ── Nightly tidy-up (optional): free storage from finished posts after 90 days ──
    if (action === 'cleanup') {
      const secret = process.env.CRON_SECRET || '';
      if (!secret || String(body.cron_secret || '') !== secret) return res.status(401).json({ ok: false, error: 'Not allowed.' });
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      const old = (await sb('GET', 'social_posts?created_at=lt.' + enc(cutoff)
        + '&status=in.(posted,rejected)&photos_removed=is.false&select=id,photos&limit=200')) || [];
      for (const p of old) {
        for (const u of (p.photos || [])) { const k = pathFromUrl(u); if (k) await deletePhoto(k); }
        await sb('PATCH', 'social_posts?id=eq.' + enc(p.id), { photos_removed: true });
      }
      return res.status(200).json({ ok: true, cleaned: old.length });
    }

    const session = verifySessionToken(body.token);
    if (!session) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
    const level = accessLevel(session);
    if (!level) return res.status(403).json({ ok: false, error: 'You do not have permission for Social Media Posts.' });
    const sid = String(session.sid || '');
    if (!isSchool(sid)) return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });
    const mine = 'school_id=eq.' + enc(sid);
    const by = str(body.by, 60) || (session.role === 'staff' ? 'Staff' : 'Office');

    // ── The on/off switch (set by the DigiSmart super admin) ──
    const sch = ((await sb('GET', 'schools?school_id=eq.' + enc(sid) + '&select=*&limit=1')) || [])[0];
    if (!sch || sch.has_social !== true) {
      return res.status(403).json({ ok: false, error: 'Social Media Posts is not switched on for this school. Please contact DigiSmart.' });
    }
    const school = { name: sch.name || '', city: sch.city || '' };
    const needFull = () => level === 'full' ? null
      : res.status(403).json({ ok: false, error: 'Only the principal / admin can do this.' });

    if (action === 'info') {
      return res.status(200).json({ ok: true, level, settings: await getSettings(sid), school, logo_url: await schoolLogo(sid) });
    }

    if (action === 'photo') {
      const m = String(body.data_url || '').match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
      if (!m) return res.status(400).json({ ok: false, error: 'Only photos can be uploaded.' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_PHOTO_BYTES) return res.status(400).json({ ok: false, error: 'That photo is too large.' });
      const path = sid + '/' + new Date().toISOString().slice(0, 7) + '/' + crypto.randomUUID() + '.jpg';
      const up = await storePhoto(buf, path);
      if (!up.ok) return res.status(500).json({ ok: false, error: 'Could not store the photo: ' + up.raw.slice(0, 200) });
      return res.status(200).json({ ok: true, url: publicUrl(path) });
    }

    if (action === 'create') {
      const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS + 1) : [];
      if (!photos.length) return res.status(400).json({ ok: false, error: 'Please add at least one photo.' });
      if (photos.length > MAX_PHOTOS) return res.status(400).json({ ok: false, error: 'A post can have at most ' + MAX_PHOTOS + ' photos.' });
      for (const u of photos) {
        const p = pathFromUrl(u);
        if (!p || !p.startsWith(sid + '/')) return res.status(400).json({ ok: false, error: 'One of the photos is not from this school.' });
      }
      if (body.checked !== true) return res.status(400).json({ ok: false, error: 'Please tick that you checked the "No photos" children are not in these photos.' });

      const row = {
        school_id: sid, class_name: str(body.class_name, 40) || 'Whole school',
        note: str(body.note, 300), photos, status: 'photos', created_by: by, checked_by: by,
        title: str(body.note, 60) || str(body.class_name, 40) || 'School activity'
      };
      // Teachers only hand over photos. The principal's own uploads are written straight away.
      let aiErr = '';
      if (level === 'full') {
        try { Object.assign(row, await writeCaption(row, school, await getSettings(sid)), { status: 'draft' }); }
        catch (e) { aiErr = e.message; }
      }
      const saved = ((await sb('POST', 'social_posts', row)) || [])[0];
      return res.status(200).json({ ok: true, row: saved, ai_error: aiErr });
    }

    if (action === 'list') {
      const rows = (await sb('GET', 'social_posts?' + mine + '&select=*&order=created_at.desc&limit=300')) || [];
      return res.status(200).json({ ok: true, rows, level });
    }

    // ── Everything below works on one post of this school ──
    if (['rewrite', 'edit', 'approve', 'reject', 'posted', 'gallery_done', 'remove'].indexOf(action) !== -1) {
      if (!isId(body.id)) return res.status(400).json({ ok: false, error: 'Invalid post.' });
      const post = ((await sb('GET', 'social_posts?id=eq.' + enc(body.id) + '&' + mine + '&select=*&limit=1')) || [])[0];
      if (!post) return res.status(404).json({ ok: false, error: 'Post not found.' });
      const one = 'social_posts?id=eq.' + enc(post.id) + '&' + mine;
      const now = new Date().toISOString();
      const patchAndReturn = async (patch) => {
        patch.updated_at = now;
        const saved = ((await sb('PATCH', one, patch)) || [])[0];
        return res.status(200).json({ ok: true, row: saved || null });
      };

      if (action === 'rewrite') {
        if (needFull()) return;
        if (post.status === 'posted') return res.status(400).json({ ok: false, error: 'This post is already posted.' });
        const ai = await writeCaption(post, school, await getSettings(sid), str(body.hint, 300));
        const st = (post.status === 'rejected' || post.status === 'photos') ? 'draft' : post.status;
        return patchAndReturn(Object.assign(ai, { status: st }));
      }
      if (action === 'edit') {
        if (needFull()) return;
        return patchAndReturn({
          caption_en: str(body.caption_en, 1500), caption_ta: str(body.caption_ta, 2000),
          hashtags: str(body.hashtags, 400)
        });
      }
      if (action === 'approve') {
        if (needFull()) return;
        if (!post.caption_en && !post.caption_ta) return res.status(400).json({ ok: false, error: 'The caption is empty. Press "Write again" or type one first.' });
        return patchAndReturn({ status: 'approved', approved_by: by, approved_at: now, reject_note: null });
      }
      if (action === 'reject') {
        if (needFull()) return;
        return patchAndReturn({ status: 'rejected', reject_note: str(body.note, 300), approved_by: by });
      }
      if (action === 'posted') {
        if (needFull()) return;
        if (post.status !== 'approved' && post.status !== 'posted') return res.status(400).json({ ok: false, error: 'Approve the post first.' });
        return patchAndReturn({ status: 'posted', posted_at: now });
      }
      if (action === 'gallery_done') {
        return patchAndReturn({ sent_gallery: true });
      }
      if (action === 'remove') {
        // A teacher may take back an upload only until the principal has used it
        if (level !== 'full' && post.status !== 'photos') return res.status(403).json({ ok: false, error: 'Only the principal / admin can delete this.' });
        for (const u of (post.photos || [])) { const k = pathFromUrl(u); if (k) await deletePhoto(k); }
        await sb('DELETE', one);
        return res.status(200).json({ ok: true });
      }
    }

    if (action === 'students') {
      const rows = (await sb('GET', 'students?' + mine + '&status=eq.active&select=id,full_name,class,section&order=class.asc,full_name.asc&limit=3000')) || [];
      return res.status(200).json({ ok: true, rows });
    }

    if (action === 'save_settings') {
      if (needFull()) return;
      const ids = (Array.isArray(body.no_photo_ids) ? body.no_photo_ids : []).filter(isId).slice(0, 3000);
      const lang = ['both', 'en'].indexOf(body.language) !== -1 ? body.language : 'both';
      const row = {
        school_id: sid, no_photo_ids: ids, footer_line: str(body.footer_line, 300),
        hashtags: str(body.hashtags, 300), language: lang, updated_at: new Date().toISOString()
      };
      if (['off', 'br', 'bl', 'tr', 'tl'].indexOf(body.logo_corner) !== -1) row.logo_corner = body.logo_corner;
      await sb('POST', 'social_settings?on_conflict=school_id', row, { Prefer: 'resolution=merge-duplicates,return=representation' });
      return res.status(200).json({ ok: true, settings: await getSettings(sid) });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
};
