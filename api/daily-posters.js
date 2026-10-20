// DigiSmart ERP — Daily Posters API (part of Social Media Posts)
// Weekly "message" posters like the ones schools buy from social media agencies:
// teacher stories, school memories, parenting tips, exam tips, values, admission open —
// with the correspondent / principal in the picture, the school logo and name, and
// Tamil / English text laid on top cleanly in the browser (the AI never writes Tamil letters).
//
// Step 1 (this file now): the school's Daily Posters settings.
//   settings_get  {}            → { ok, settings }
//   settings_save { settings }  → { ok, settings }
// Settings are a small file in the 'social-posts' bucket: <school>/daily/settings.json
// (no new database table needed). The correspondent's photo is the SAME photo saved in
// Festival Wishes (/api/festival-wishes person / person_get), so the school saves it once.
//
// Step 2 (poster maker):
//   write   { theme }            → { ok, theme, text }  AI writes a new message (Tamil / English as the school chose)
//                                   theme: auto | teachers | memories | parenting | exam | values | admission
//   picture { theme, variant }   → { ok, url, style }   the poster picture (no letters in it)
//            placed  = a shared picture per theme, made once for ALL schools (at most 4 per theme)
//            painted = this school's correspondent painted in, made per school (at most 8 new a week)
//   post    { data_url, title, caption_en, caption_ta, hashtags } → finished poster into "Ready to Post"
// The browser (js/daily-posters.js) puts the words, logo, name and (placed) photo on top.
// Env: ANTHROPIC_API_KEY (message writing) · OPENAI_API_KEY (pictures)
//
// Same rules as Social Media Posts: has_social must be on, and only the owner / full-access
// staff (principal, admin) may use it.
// Env: SUPABASE_SERVICE_KEY (already set)

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const BUCKET = 'social-posts';

// What a school can choose. Anything else falls back to the default.
const CHOICES = {
  style: ['painted', 'placed'],       // painted = AI paints the person into the scene · placed = real photo on a shared background
  language: ['both', 'ta', 'en'],     // both = Tamil + one English line
  gender: ['sir', 'madam'],           // who is in the saved photo (so the AI draws the right person)
  per_week: [3]                       // fixed at 3 for now (decided Oct 2026)
};
const DEFAULTS = { enabled: false, style: 'placed', language: 'both', gender: 'sir', per_week: 3, from_line: '' };

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
async function sb(method, path) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method, headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status));
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
  if (!r.ok) throw new Error('Could not save the settings: ' + raw.slice(0, 200));
}
function publicUrl(path) { return SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + path; }
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function isSchool(v) { return /^[a-zA-Z0-9_-]{2,64}$/.test(String(v || '')); }
function settingsPath(sid) { return sid + '/daily/settings.json'; }

// Keep only known choices, so nothing odd is ever saved
function clean(s) {
  s = s || {};
  const out = Object.assign({}, DEFAULTS);
  out.enabled = s.enabled === true;
  for (const k of ['style', 'language', 'gender']) if (CHOICES[k].indexOf(s[k]) !== -1) out[k] = s[k];
  out.from_line = str(s.from_line, 70);
  return out;
}
async function readSettings(sid) {
  try {
    const r = await fetch(publicUrl(settingsPath(sid)) + '?t=' + Date.now());
    if (!r.ok) return Object.assign({}, DEFAULTS);
    return clean(await r.json());
  } catch (e) { return Object.assign({}, DEFAULTS); }
}

// ════════════ Step 2: the poster maker ════════════
const OPENAI_MODEL = process.env.DAILY_IMAGE_MODEL || process.env.FESTIVAL_IMAGE_MODEL || 'gpt-image-2';
const IMAGE_QUALITY = process.env.DAILY_IMAGE_QUALITY || 'medium';
const TEXT_MODEL = process.env.DAILY_TEXT_MODEL || 'claude-sonnet-4-5';
const ART_FOLDER = 'daily-art';
const MAX_VARIANTS = 4;          // picture versions per theme
const PAINTED_PER_WEEK = 8;      // new painted pictures per school per week (3 posters + remakes)
const MAX_POSTER_BYTES = 900 * 1024;

// The themes. Each has what the message is about and 2 picture scenes (versions take turns).
const THEMES = {
  teachers: {
    name: "Teachers' love",
    brief: 'the quiet, loving work of teachers — how a good teacher becomes a child\'s safe place, patience, care, small moments in class',
    scenes: [
      'A warm, sunlit Indian primary school classroom: small wooden desks, a blank green chalkboard, a teacher\'s table with neat books, a small potted plant and a steel tumbler, soft morning light through tall windows.',
      'An Indian kindergarten classroom corner with colourful charts (no readable words), a small reading mat, picture books and soft toys, warm gentle light.'
    ]
  },
  memories: {
    name: 'School memories',
    brief: 'gentle nostalgia for the school days of parents who grew up in the 1980s and 1990s in Tamil Nadu — simple joys, old notebooks, friends, the school bell — and what today\'s children can learn from it',
    scenes: [
      'An old wooden school desk with stacks of worn notebooks tied with string, a brown-paper covered textbook, pencils, an old tin geometry box and a fountain pen, warm golden nostalgic light, a blank blackboard softly blurred behind.',
      'An old Tamil Nadu village school verandah with a brass school bell hanging from a pillar, a cycle parked under a neem tree, warm evening light, nostalgic mood.'
    ]
  },
  parenting: {
    name: 'Parenting tips',
    brief: 'one simple, practical tip for parents of school children — reading together, screen time, praise, sleep, talking with the child, healthy food — warm and never preachy',
    scenes: [
      'A warm Indian home in the evening: a parent and a small child reading a picture book together at a low table, seen from behind, a glowing lamp, cosy and loving.',
      'An Indian family dining table with a simple healthy home meal, a child\'s school bag and water bottle nearby, soft warm morning light.'
    ]
  },
  exam: {
    name: 'Exam tips',
    brief: 'one calm, encouraging study or exam tip for children and parents — regular revision, sleep, no fear, writing practice, confidence',
    scenes: [
      'A neat study table by a window with open textbooks, a notebook, pencils, a small clock, a water bottle and a glowing desk lamp, calm focused morning light.',
      'Indian school children writing in an exam hall seen from behind, calm and confident, soft daylight through windows.'
    ]
  },
  values: {
    name: 'Values & assembly',
    brief: 'one good value children learn at school — honesty, courage, kindness, discipline, saying sorry, respecting elders — like a thought from the morning assembly',
    scenes: [
      'An Indian school morning assembly in a school ground: rows of children in neat uniforms seen from behind, a flag pole, bright golden morning sunlight.',
      'Two Indian school children in uniform sharing lunch under a big tree in a school ground, seen from a distance, warm happy light.'
    ]
  },
  admission: {
    name: 'Admission open',
    brief: 'a warm invitation to parents to join the school for the new academic year — care, learning, safety and growth — without any fees, dates or phone numbers',
    scenes: [
      'A bright, welcoming Indian school entrance with an open gate, flower pots and marigold decorations, small children with school bags walking in, seen from behind, sunny morning.',
      'A cheerful Indian school corridor with colourful classroom doors and children\'s paintings (no readable words), bright clean and welcoming.'
    ]
  }
};
const THEME_KEYS = Object.keys(THEMES);
function admissionSeason() { const m = new Date(Date.now() + 5.5 * 3600000).getUTCMonth() + 1; return m === 12 || m <= 5; }

// Shared look for every picture: no letters, calm left side for the words
const LOOK = 'A beautiful, warm, realistic, high-quality photograph-style picture for an Indian school\'s social media poster. '
  + 'Soft natural light, rich but gentle colours, emotional and respectful, suitable for children and families. '
  + 'Tall vertical composition. Keep the LEFT HALF of the picture calm, softly blurred and slightly darker with no important details and no faces, '
  + 'because words will be placed there later. ';
const NO_TEXT = ' Absolutely no text, letters, numbers, words, logos, signatures or watermarks anywhere in the picture.';

function personLine(gender) {
  return gender === 'madam'
    ? 'Include the woman from the reference photo: keep her face, features, skin tone, hairstyle, bindi and glasses (if any) exactly the same so she is clearly recognisable. '
      + 'Show her as a graceful half-body portrait on the RIGHT side of the picture, wearing an elegant cotton or silk saree, neat hair, a warm kind smile, like a respected school leader, '
    : 'Include the man from the reference photo: keep his face, features, skin tone, hairstyle, moustache and glasses (if any) exactly the same so he is clearly recognisable. '
      + 'Show him as a dignified half-body portrait on the RIGHT side of the picture, wearing a neat formal shirt, a warm kind smile, like a respected school leader, ';
}
function scenePrompt(theme, variant, painted, gender) {
  const t = THEMES[theme];
  const scene = t.scenes[(variant - 1) % t.scenes.length];
  return LOOK + 'Scene: ' + scene + ' '
    + (painted
      ? personLine(gender) + 'lit by the same light as the scene and blended in naturally, not cut out. '
      : 'Keep the lower right corner calm too, because a round photo will be placed there. ')
    + NO_TEXT;
}

function weekKey() {
  const d = new Date(Date.now() + 5.5 * 3600000);
  const day = (d.getUTCDay() + 6) % 7;                // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);               // the Monday of this week
}
async function readJson(path, fallback) {
  try { const r = await fetch(publicUrl(path) + '?t=' + Date.now()); if (r.ok) return await r.json(); } catch (e) {}
  return fallback;
}
async function exists(path) {
  try { const r = await fetch(publicUrl(path) + '?t=' + Date.now(), { method: 'HEAD' }); return r.ok; }
  catch (e) { return false; }
}
async function sbInsert(table, row) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status));
  return data;
}

// Ask OpenAI for one picture (with the reference photo when painting the person in)
async function makePicture(prompt, personBuf) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('AI pictures are not set up yet for ERP (OPENAI_API_KEY missing in Vercel).');
  let opts = { output_format: 'jpeg', output_compression: 86 };
  if (personBuf) opts.input_fidelity = 'high';
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    if (personBuf) {
      const fd = new FormData();
      fd.append('model', OPENAI_MODEL); fd.append('prompt', prompt); fd.append('n', '1');
      fd.append('size', '1024x1536'); fd.append('quality', IMAGE_QUALITY);
      Object.entries(opts).forEach(([k, v]) => fd.append(k, String(v)));
      fd.append('image[]', new Blob([personBuf], { type: 'image/jpeg' }), 'person.jpg');
      r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: fd });
    } else {
      r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(Object.assign({ model: OPENAI_MODEL, prompt, n: 1, size: '1024x1536', quality: IMAGE_QUALITY }, opts))
      });
    }
    const raw = await r.text();
    let d = null; try { d = JSON.parse(raw); } catch (e) {}
    if (r.ok && d && d.data && d.data[0] && d.data[0].b64_json) return { buf: Buffer.from(d.data[0].b64_json, 'base64'), jpeg: opts.output_format === 'jpeg' };
    const msg = (d && d.error && d.error.message) || raw.slice(0, 200);
    const bad = Object.keys(opts).find(k => msg.indexOf(k) !== -1);
    if (bad) { opts = Object.assign({}, opts); delete opts[bad]; continue; }
    if (/safety|moderation|rejected/i.test(msg)) throw new Error('The picture maker could not draw this one. Please press "Another picture".');
    throw new Error('Picture maker error ' + r.status + ': ' + msg);
  }
  throw new Error('The picture maker is not available right now.');
}

// The picture for one poster. Saved and reused, so the same choice never costs twice.
async function posterPicture(sid, settings, theme, variant) {
  if (settings.style === 'painted') {
    const base = sid + '/festival/person';
    if (!(await exists(base + '.jpg'))) throw new Error('Please save the correspondent / principal photo first.');
    const info = await readJson(base + '.json', {});
    const h = crypto.createHash('sha256').update(['d1', theme, settings.gender, info.v || 1].join('|')).digest('hex').slice(0, 12);
    const path = sid + '/daily/ai-' + theme + '-' + h + '-v' + variant + '.jpg';
    if (await exists(path)) return { url: publicUrl(path), made: false };
    // weekly limit, so the cost can never run away
    const usePath = sid + '/daily/usage.json';
    const use = await readJson(usePath, {});
    const wk = weekKey();
    const count = use.week === wk ? (use.count || 0) : 0;
    if (count >= PAINTED_PER_WEEK) throw new Error('This week\'s limit of ' + PAINTED_PER_WEEK + ' new AI pictures is used up. Please pick from the pictures already made, or try again next Monday.');
    const pr = await fetch(publicUrl(base + '.jpg') + '?t=' + Date.now());
    if (!pr.ok) throw new Error('Could not read the saved photo. Please save it again.');
    const out = await makePicture(scenePrompt(theme, variant, true, settings.gender), Buffer.from(await pr.arrayBuffer()));
    await storeFile(out.buf, path, out.jpeg ? 'image/jpeg' : 'image/png');
    await storeFile(Buffer.from(JSON.stringify({ week: wk, count: count + 1 })), usePath, 'application/json');
    return { url: publicUrl(path), made: true };
  }
  // placed: shared by every school
  const path = ART_FOLDER + '/' + theme + '-v' + variant + '.jpg';
  if (await exists(path)) return { url: publicUrl(path), made: false };
  const out = await makePicture(scenePrompt(theme, variant, false), null);
  await storeFile(out.buf, path, out.jpeg ? 'image/jpeg' : 'image/png');
  return { url: publicUrl(path), made: true };
}

// The theme to use next: the one used longest ago (admission only in admission season)
function nextTheme(history) {
  const allowed = THEME_KEYS.filter(k => k !== 'admission' || admissionSeason());
  const last = {};
  (history.items || []).forEach((it, i) => { if (last[it.theme] === undefined) last[it.theme] = i; });
  allowed.sort((a, b) => (last[b] === undefined ? 1e9 : last[b]) - (last[a] === undefined ? 1e9 : last[a]));
  return allowed[0];
}

// AI writes the words. Only the school name and fixed choices go in — no free text from the page.
async function writeMessage(schoolName, theme, language, history) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('AI writing is not set up (ANTHROPIC_API_KEY missing in Vercel).');
  const recent = (history.items || []).slice(0, 30).map(it => '- ' + it.title).join('\n') || '(none yet)';
  const want = language === 'en'
    ? '"title_en": a short heading (3–7 words), "body_en": 2–3 short lines (each under 12 words)'
    : language === 'ta'
      ? '"title_ta": a short Tamil heading (2–6 words), "body_ta": 2–4 short Tamil lines (each under 9 words)'
      : '"title_ta": a short Tamil heading (2–6 words), "body_ta": 2–4 short Tamil lines (each under 9 words), "line_en": ONE short English line (under 12 words) that sums it up';
  const prompt = 'You write daily social media posters for an Indian school in Tamil Nadu, "' + schoolName + '". '
    + 'Parents follow the school page. The posters are warm, emotional and positive, like the best Tamil school posts that parents love to share.\n\n'
    + 'Today\'s theme: ' + THEMES[theme].name + ' — ' + THEMES[theme].brief + '.\n\n'
    + 'Rules:\n'
    + '- Write something NEW and original. Do not copy lines from any other page, film, song or poem.\n'
    + '- Tamil must be natural spoken-style Tamil that a Tamil Nadu parent uses, correctly spelled, not a word-for-word translation. A few common English words (Teacher, School, Notebook, Exam) are fine inside Tamil, as people speak.\n'
    + '- Simple words. No difficult literary Tamil. No hashtags, emojis, phone numbers, fees or dates on the poster.\n'
    + '- Never name or criticise another school. Nothing about religion, caste or politics.\n'
    + '- Do not repeat these recent headings:\n' + recent + '\n\n'
    + 'Reply with JSON only, no other text, with: ' + want
    + ', plus "caption_en": a 2–3 sentence English caption for Facebook/Instagram, "caption_ta": the same caption in natural Tamil, '
    + '"hashtags": 4–6 hashtags separated by spaces, and "title": a short English label for this poster (under 8 words).';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: TEXT_MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
  });
  const raw = await r.text();
  if (!r.ok) throw new Error('AI could not write the message right now (' + r.status + '). Please try again.');
  let reply = '';
  try { reply = (JSON.parse(raw).content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim(); } catch (e) {}
  let t = null;
  try { const a = reply.indexOf('{'), b = reply.lastIndexOf('}'); t = JSON.parse(reply.slice(a, b + 1)); } catch (e) {}
  if (!t) throw new Error('AI wrote something unreadable. Please press "New message".');
  const lines = (v, n, m) => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => str(x, m)).filter(Boolean).slice(0, n);
  return {
    title_ta: str(t.title_ta, 80), body_ta: lines(t.body_ta, 4, 90), line_en: str(t.line_en, 120),
    title_en: str(t.title_en, 80), body_en: lines(t.body_en, 3, 120),
    caption_en: str(t.caption_en, 1200), caption_ta: str(t.caption_ta, 1600),
    hashtags: str(t.hashtags, 300), title: str(t.title, 80) || THEMES[theme].name
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
  const action = String(body.action || '');

  try {
    const session = verifySessionToken(body.token);
    if (!session) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
    if (accessLevel(session) !== 'full') return res.status(403).json({ ok: false, error: 'Only the principal / admin can use Daily Posters.' });
    const sid = String(session.sid || '');
    if (!isSchool(sid)) return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });

    const sch = ((await sb('GET', 'schools?school_id=eq.' + encodeURIComponent(sid) + '&select=school_id,has_social&limit=1')) || [])[0];
    if (!sch || sch.has_social !== true) {
      return res.status(403).json({ ok: false, error: 'Social Media Posts is not switched on for this school. Please contact DigiSmart.' });
    }

    if (action === 'settings_get') {
      return res.status(200).json({ ok: true, settings: await readSettings(sid) });
    }
    if (action === 'settings_save') {
      const s = clean(body.settings);
      await storeFile(Buffer.from(JSON.stringify(s)), settingsPath(sid), 'application/json');
      return res.status(200).json({ ok: true, settings: s });
    }
    // ── Step 2: write a new message ──
    if (action === 'write') {
      const settings = await readSettings(sid);
      const histPath = sid + '/daily/history.json';
      const history = await readJson(histPath, { items: [] });
      let theme = String(body.theme || 'auto');
      if (!THEMES[theme]) theme = nextTheme(history);
      const name = ((await sb('GET', 'schools?school_id=eq.' + encodeURIComponent(sid) + '&select=name&limit=1')) || [])[0];
      const text = await writeMessage(str(name && name.name, 80) || 'our school', theme, settings.language, history);
      const items = [{ theme, title: text.title_ta || text.title_en || text.title, at: new Date().toISOString() }].concat(history.items || []).slice(0, 60);
      await storeFile(Buffer.from(JSON.stringify({ items })), histPath, 'application/json');
      return res.status(200).json({ ok: true, theme, theme_name: THEMES[theme].name, language: settings.language, text });
    }

    // ── Step 2: the poster picture ──
    if (action === 'picture') {
      const theme = String(body.theme || '');
      if (!THEMES[theme]) return res.status(400).json({ ok: false, error: 'Unknown theme.' });
      const v = Math.min(MAX_VARIANTS, Math.max(1, parseInt(body.variant, 10) || 1));
      const settings = await readSettings(sid);
      const r = await posterPicture(sid, settings, theme, v);
      return res.status(200).json({ ok: true, url: r.url, made: r.made, style: settings.style, variant: v, max: MAX_VARIANTS });
    }

    // ── Step 2: finished poster → "Ready to Post" ──
    if (action === 'post') {
      const m = String(body.data_url || '').match(/^data:image\/(jpeg|jpg);base64,(.+)$/);
      if (!m) return res.status(400).json({ ok: false, error: 'The poster picture is missing.' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_POSTER_BYTES) return res.status(400).json({ ok: false, error: 'The poster is too large.' });
      const path = sid + '/' + new Date().toISOString().slice(0, 7) + '/' + crypto.randomUUID() + '.jpg';
      await storeFile(buf, path, 'image/jpeg');
      const by = str(body.by, 60) || 'Office';
      const now = new Date().toISOString();
      const tags = str(body.hashtags, 400).split(/\s+/).filter(Boolean).map(t => t.startsWith('#') ? t : '#' + t).slice(0, 10).join(' ');
      const row = {
        school_id: sid, class_name: 'Daily Posters', note: '', photos: [publicUrl(path)],
        title: str(body.title, 80) || 'Daily poster',
        caption_en: str(body.caption_en, 1500), caption_ta: str(body.caption_ta, 2000), hashtags: tags,
        status: 'approved', created_by: by, checked_by: by, approved_by: by, approved_at: now
      };
      const saved = ((await sbInsert('social_posts', row)) || [])[0];
      return res.status(200).json({ ok: true, row: saved });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
};
