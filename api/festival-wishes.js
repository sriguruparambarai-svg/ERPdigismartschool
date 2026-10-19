// DigiSmart ERP — Festival Wishes API (part of Social Media Posts)
// Festival greeting posters: a festival picture + school logo + school name + wishes,
// optionally with the correspondent's photo. The poster itself is drawn in the browser
// (js/festival-wishes.js) — no server cost. This door only does three things:
//
//   1. art      { festival, variant }  → { ok, url }
//      The AI festival picture (Goddess Saraswathi, Pongal pot, Deepavali lamps …).
//      Made ONCE by OpenAI and saved in the public 'social-posts' bucket under
//      festival-art/ — every school shares the same pictures, so each one is paid for
//      only once. Only fixed pictures from the list below can be made (no free text),
//      and at most 4 versions per festival, so the cost can never run away.
//   2. person   { data_url, name, role } → { ok, person }   save the correspondent's photo once
//      person_get {}                      → { ok, person }   (null when none saved)
//      person_remove {}                   → { ok }
//   3. post     { data_url, title, caption_en, caption_ta, hashtags } → { ok, row }
//      Saves the finished poster as an approved post, so it appears in "Ready to Post"
//      (Facebook / Instagram / WhatsApp / Parent Gallery all work from there).
//
// Same rules as Social Media Posts: the school must have has_social switched on, and only
// the owner / full-access staff (principal, admin) may use it.
// Env: SUPABASE_SERVICE_KEY (already set) · OPENAI_API_KEY (needed for the AI pictures only)

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const BUCKET = 'social-posts';
const ART_FOLDER = 'festival-art';
const MAX_VARIANTS = 4;
const MAX_POSTER_BYTES = 900 * 1024;
const MAX_PERSON_BYTES = 600 * 1024;
const OPENAI_MODEL = process.env.FESTIVAL_IMAGE_MODEL || 'gpt-image-2';

// The look shared by every festival picture. Portrait, so it fits the poster's arch.
const ART_STYLE = 'A beautiful, auspicious Indian festival artwork for a school greeting poster, '
  + 'in the style of a fine traditional Indian painting with rich warm colours, soft glowing light and delicate gold accents. '
  + 'Tall vertical composition with the main subject centred and fully inside the frame, gentle soft background. '
  + 'Graceful, respectful and suitable for children and families. '
  + 'No text, no letters, no numbers, no words, no signature, no watermark, no border, no frame. Picture: ';

// Each festival has 1–2 subjects; versions take turns between them.
const FESTIVALS = {
  saraswathi: [
    'Goddess Saraswathi in a white silk saree with a gold border, seated gracefully on a large white lotus, playing the veena with a gentle smile, a white swan beside her, palm-leaf books and a japa mala, a soft golden halo behind her head, a calm lotus pond below.',
    'An Ayudha Pooja and Saraswathi Pooja arrangement in a Tamil home: books, notebooks, a veena and simple tools neatly placed on a low wooden plank, decorated with sandal paste and kumkum dots, jasmine and marigold garlands, banana leaves, a lit brass kuthuvilakku lamp, fruits, puffed rice and sugarcane.'
  ],
  vijayadasami: [
    'A small child\'s hand guided to write the first letter in a brass plate of rice grains during Vidyarambham, with a lit brass lamp, flowers, a palm-leaf book and a soft glowing image of a white lotus in the background. Show only hands, no faces.',
    'Goddess Saraswathi in a white silk saree seated on a white lotus playing the veena, a white swan beside her, books and a brass lamp, golden light.'
  ],
  deepavali: [
    'Many glowing clay diyas arranged on a colourful rangoli kolam on a Tamil house doorstep at night, marigold garlands, gentle sparklers and soft golden fireworks in the dark blue sky.',
    'A brass plate of Deepavali sweets and a row of lit clay lamps, with soft colourful fireworks glowing in the night sky behind.'
  ],
  pongal: [
    'A clay Pongal pot overflowing with sweet rice, cooking on a small firewood stove in a Tamil village courtyard, with sugarcane stalks, turmeric plants, banana leaves and a white kolam, the morning sun rising in the sky.',
    'Mattu Pongal: decorated cattle with painted horns, bells and flower garlands standing in a green Tamil village, with sugarcane and a Pongal pot nearby, bright morning sunlight.'
  ],
  tamil_new_year: [
    'A Tamil New Year kani arrangement: a brass plate with mango, banana, jackfruit, coconut, betel leaves, neem flowers, gold coins, a small mirror and jasmine flowers, beside a lit brass kuthuvilakku lamp and a kolam.'
  ],
  new_year: [
    'Elegant golden fireworks bursting over a calm night sky above a peaceful Indian town, with festive lights and soft sparkles.'
  ],
  vinayagar: [
    'Lord Vinayagar (Ganesha) seated peacefully on a lotus throne, with a plate of modakam and kozhukattai, arugampul grass, red hibiscus flowers and a small mouse at his feet, temple lamps glowing.'
  ],
  krishna: [
    'Little Krishna as a cute child sitting happily with a pot of butter, a peacock feather in his hair, a flute beside him, tiny footprints painted on the floor, flowers and lamps.'
  ],
  karthigai: [
    'Rows of glowing agal vilakku clay lamps on the steps and kolam of a Tamil house at dusk, with a sacred hill and a great flame on its top in the distance.'
  ],
  christmas: [
    'A glowing Christmas star over a decorated Christmas tree with soft lights, a small church with warm lit windows, gifts and gentle falling sparkles at night.'
  ],
  ramzan: [
    'A crescent moon and evening stars over beautiful mosque domes and minarets, glowing hanging lanterns, a plate of dates, peaceful purple and gold sky.'
  ],
  bakrid: [
    'Beautiful mosque domes and minarets at sunset, glowing hanging lanterns, a crescent moon, peaceful golden sky.'
  ],
  independence: [
    'The Indian national tricolour flag waving proudly on a flagpole against a bright blue sky, with marigold flowers, tricolour balloons and Indian school children in uniform saluting seen from behind.'
  ],
  republic: [
    'The Indian national tricolour flag waving on a tall flagpole in front of a grand Indian monument, bright blue sky, tricolour flowers and balloons.'
  ],
  teachers: [
    'A warm Indian classroom scene with a clean blackboard, a pile of books, a globe, a pencil, an apple and a pot of flowers on the teacher\'s table, soft morning light. The blackboard is blank.'
  ],
  childrens: [
    'Happy Indian school children in colourful clothes playing together in a green school ground with balloons, kites and flowers, bright cheerful day, children seen from a distance.'
  ],
  general: [
    'A festive auspicious arrangement: a lit brass kuthuvilakku lamp, marigold and jasmine garlands, mango leaves toran, a colourful kolam and soft golden light.'
  ]
};

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
    return d;
  } catch (e) { return null; }
}
// Same as Social Media Posts: 'full' = owner / principal / admin
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
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status + ': ' + text.slice(0, 200)));
  return data;
}
async function storeFile(buf, path, type) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': type, 'x-upsert': 'true', 'Cache-Control': 'max-age=60' },
    body: buf
  });
  const raw = await r.text();
  if (!r.ok && /bucket not found/i.test(raw)) throw new Error('The "social-posts" photo folder is missing in Supabase Storage. Please create it (public).');
  if (!r.ok) throw new Error('Could not save the file: ' + raw.slice(0, 200));
}
async function deleteFile(path) {
  const key = getServiceKey();
  try {
    await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path,
      { method: 'DELETE', headers: { apikey: key, Authorization: 'Bearer ' + key } });
  } catch (e) { /* nothing to delete is fine */ }
}
function publicUrl(path) { return SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + path; }
async function exists(path) {
  try { const r = await fetch(publicUrl(path) + '?t=' + Date.now(), { method: 'HEAD' }); return r.ok; }
  catch (e) { return false; }
}
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function isSchool(v) { return /^[a-zA-Z0-9_-]{2,64}$/.test(String(v || '')); }

// Ask OpenAI for one picture. Tries JPEG first (smaller file); falls back to PNG.
async function drawArt(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('AI pictures are not set up yet for ERP (OPENAI_API_KEY missing in Vercel). You can still use "Our own picture".');
  const tries = [
    { output_format: 'jpeg', output_compression: 88 },
    {}
  ];
  let lastErr = '';
  for (const extra of tries) {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(Object.assign({ model: OPENAI_MODEL, prompt, n: 1, size: '1024x1536', quality: 'medium' }, extra))
    });
    const raw = await r.text();
    let d = null; try { d = JSON.parse(raw); } catch (e) {}
    if (r.ok && d && d.data && d.data[0] && d.data[0].b64_json) {
      return { buf: Buffer.from(d.data[0].b64_json, 'base64'), jpeg: !!extra.output_format };
    }
    const msg = (d && d.error && d.error.message) || raw.slice(0, 200);
    lastErr = 'Picture maker error ' + r.status + ': ' + msg;
    if (/output_format|output_compression|unknown parameter/i.test(msg)) continue;   // older model: plain PNG
    if (/safety|moderation|rejected/i.test(msg)) throw new Error('The picture maker could not draw this one. Please press "Another picture" or use "Our own picture".');
    throw new Error(lastErr);
  }
  throw new Error(lastErr || 'The picture maker is not available right now.');
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
    const session = verifySessionToken(body.token);
    if (!session) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
    if (accessLevel(session) !== 'full') return res.status(403).json({ ok: false, error: 'Only the principal / admin can make festival posters.' });
    const sid = String(session.sid || '');
    if (!isSchool(sid)) return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });

    const sch = ((await sb('GET', 'schools?school_id=eq.' + enc(sid) + '&select=school_id,has_social&limit=1')) || [])[0];
    if (!sch || sch.has_social !== true) {
      return res.status(403).json({ ok: false, error: 'Social Media Posts is not switched on for this school. Please contact DigiSmart.' });
    }
    const by = str(body.by, 60) || 'Office';
    const personBase = sid + '/festival/person';

    // ── 1. The shared AI festival picture ──
    if (action === 'art') {
      const key = String(body.festival || '');
      const subjects = FESTIVALS[key];
      if (!subjects) return res.status(400).json({ ok: false, error: 'Unknown festival.' });
      const v = Math.min(MAX_VARIANTS, Math.max(1, parseInt(body.variant, 10) || 1));
      for (const ext of ['jpg', 'png']) {
        const p = ART_FOLDER + '/' + key + '-v' + v + '.' + ext;
        if (await exists(p)) return res.status(200).json({ ok: true, url: publicUrl(p), variant: v, max: MAX_VARIANTS, made: false });
      }
      const prompt = ART_STYLE + subjects[(v - 1) % subjects.length];
      const out = await drawArt(prompt);
      const p = ART_FOLDER + '/' + key + '-v' + v + '.' + (out.jpeg ? 'jpg' : 'png');
      await storeFile(out.buf, p, out.jpeg ? 'image/jpeg' : 'image/png');
      return res.status(200).json({ ok: true, url: publicUrl(p), variant: v, max: MAX_VARIANTS, made: true });
    }

    // ── 2. The correspondent's photo, saved once for every festival ──
    if (action === 'person_get') {
      if (!(await exists(personBase + '.jpg'))) return res.status(200).json({ ok: true, person: null });
      let info = {};
      try { const r = await fetch(publicUrl(personBase + '.json') + '?t=' + Date.now()); if (r.ok) info = await r.json(); } catch (e) {}
      return res.status(200).json({ ok: true, person: { url: publicUrl(personBase + '.jpg') + '?v=' + (info.v || 1), name: str(info.name, 60), role: str(info.role, 60) } });
    }
    if (action === 'person') {
      const v = Date.now();
      if (body.data_url) {
        const m = String(body.data_url).match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
        if (!m) return res.status(400).json({ ok: false, error: 'Only photos can be uploaded.' });
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > MAX_PERSON_BYTES) return res.status(400).json({ ok: false, error: 'That photo is too large.' });
        await storeFile(buf, personBase + '.jpg', 'image/jpeg');
      } else if (!(await exists(personBase + '.jpg'))) {
        return res.status(400).json({ ok: false, error: 'Please choose a photo first.' });
      }
      const info = { name: str(body.name, 60), role: str(body.role, 60), v };
      await storeFile(Buffer.from(JSON.stringify(info)), personBase + '.json', 'application/json');
      return res.status(200).json({ ok: true, person: { url: publicUrl(personBase + '.jpg') + '?v=' + v, name: info.name, role: info.role } });
    }
    if (action === 'person_remove') {
      await deleteFile(personBase + '.jpg');
      await deleteFile(personBase + '.json');
      return res.status(200).json({ ok: true });
    }

    // ── 3. Finished poster → "Ready to Post" ──
    if (action === 'post') {
      const m = String(body.data_url || '').match(/^data:image\/(jpeg|jpg);base64,(.+)$/);
      if (!m) return res.status(400).json({ ok: false, error: 'The poster picture is missing.' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_POSTER_BYTES) return res.status(400).json({ ok: false, error: 'The poster is too large.' });
      const path = sid + '/' + new Date().toISOString().slice(0, 7) + '/' + crypto.randomUUID() + '.jpg';
      await storeFile(buf, path, 'image/jpeg');
      const now = new Date().toISOString();
      const tags = str(body.hashtags, 400).split(/\s+/).filter(Boolean)
        .map(t => t.startsWith('#') ? t : '#' + t).slice(0, 10).join(' ');
      const row = {
        school_id: sid, class_name: 'Festival Wishes', note: '', photos: [publicUrl(path)],
        title: str(body.title, 80) || 'Festival wishes',
        caption_en: str(body.caption_en, 1500), caption_ta: str(body.caption_ta, 2000), hashtags: tags,
        status: 'approved', created_by: by, checked_by: by, approved_by: by, approved_at: now
      };
      const saved = ((await sb('POST', 'social_posts', row)) || [])[0];
      return res.status(200).json({ ok: true, row: saved });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
};
