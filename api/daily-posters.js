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
//   post    { data_url, title, caption_en, caption_ta, hashtags, video?, video_seconds? } → finished poster into "Ready to Post"
//           video = the animated Reel the browser made and uploaded (via /api/social-posts video_url); the poster stays as its cover
// The browser (js/daily-posters.js) puts the words, logo, name and (placed) photo on top.
//
// Step 3 ("This week's posters"):
//   week_get     {}                                   → { ok, week }  this week's 3 posters (null if not made yet)
//   week_prepare {}                                   → { ok, week }  make this week's 3 posters now (themes in turn)
//   week_update  { id, text?, variant?, status? }     → { ok, item }  save edits / another picture / added / skipped
// Stored as a small file: <school>/daily/week-<Monday's date>.json
//
// Update (Oct 2026, after comparing with agency posters):
//   portrait_get  {}            → { ok, url }   the school's big cut-out portrait (or '' if not made)
//   portrait_make { again? }    → { ok, url }   AI makes it ONCE from the saved photo (at most 3 tries per photo)
//   Messages are now written as a short story: series title, hook, lines, a highlighted punch line,
//   an optional quote bubble, and an ending (fields *_ta / *_en below).
//
// Step 4 (Monday auto-prepare):
//   GET (Vercel scheduler, Monday 6:00 and 7:00 am India time) → makes the week's 3 posters for every
//   school that has Social Media Posts on AND ticked "Make 3 posters for us every Monday".
//   Schools already done this week are skipped, so the 7 am run only finishes what 6 am could not.
// Env: ANTHROPIC_API_KEY (message writing) · OPENAI_API_KEY (pictures)
//
// Step 5: a paid add-on — the super admin switches it on per school (schools.has_daily_posters = true).
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
  look: ['bright', 'dark'],           // bright = light daylight look (default, Oct 2026) · dark = the first dark-glow look
  per_week: [3]                       // fixed at 3 for now (decided Oct 2026)
};
const DEFAULTS = { enabled: false, style: 'placed', language: 'both', gender: 'sir', look: 'bright', per_week: 3, from_line: '' };

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
  for (const k of ['style', 'language', 'gender', 'look']) if (CHOICES[k].indexOf(s[k]) !== -1) out[k] = s[k];
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
// Bright look (Oct 2026): like the admission ads parents see — airy daylight, white and cream, fresh colours
const LOOK_BRIGHT = 'A bright, airy, cheerful, realistic, high-quality photograph-style picture for an Indian school\'s social media poster, '
  + 'like a premium school admission advertisement. Clear soft daylight, white, cream and light warm tones with fresh touches of green plants and natural wood, '
  + 'clean and uncluttered, emotional and respectful, suitable for children and families. Never dark, gloomy, night-time or moody. '
  + 'Tall vertical composition. Keep the LEFT HALF of the picture very light, plain and softly blurred (light cream or white wall), with no important details and no faces, '
  + 'because words will be placed there later. ';
const NO_TEXT = ' Absolutely no text, letters, numbers, words, logos, signatures or watermarks anywhere in the picture.';

function personLine(gender) {
  return gender === 'madam'
    ? 'Include the woman from the reference photo: keep her face, features, skin tone, hairstyle, bindi and glasses (if any) exactly the same so she is clearly recognisable. '
      + 'Show her as a graceful half-body portrait on the RIGHT side of the picture, wearing an elegant cotton or silk saree, neat hair, a warm kind smile, like a respected school leader, '
    : 'Include the man from the reference photo: keep his face, features, skin tone, hairstyle, moustache and glasses (if any) exactly the same so he is clearly recognisable. '
      + 'Show him as a dignified half-body portrait on the RIGHT side of the picture, wearing a neat formal shirt, a warm kind smile, like a respected school leader, ';
}
function scenePrompt(theme, variant, painted, gender, look) {
  const t = THEMES[theme];
  const scene = t.scenes[(variant - 1) % t.scenes.length];
  return (look === 'dark' ? LOOK : LOOK_BRIGHT) + 'Scene: ' + scene + ' '
    + (painted
      ? personLine(gender) + 'lit by the same light as the scene and blended in naturally, not cut out. '
      : 'Keep the RIGHT side soft and simple too, with no people or faces, because a person\'s portrait will be placed there. ')
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
    const parts = ['d1', theme, settings.gender, info.v || 1];
    if (settings.look !== 'dark') parts.push('bright');   // dark pictures keep their old place
    const h = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
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
    const out = await makePicture(scenePrompt(theme, variant, true, settings.gender, settings.look), Buffer.from(await pr.arrayBuffer()));
    await storeFile(out.buf, path, out.jpeg ? 'image/jpeg' : 'image/png');
    await storeFile(Buffer.from(JSON.stringify({ week: wk, count: count + 1 })), usePath, 'application/json');
    return { url: publicUrl(path), made: true };
  }
  // placed: shared by every school
  const path = ART_FOLDER + (settings.look === 'dark' ? '/p2-' : '/p3-') + theme + '-v' + variant + '.jpg';   // p2 = dark, p3 = bright (both made for the big portrait)
  if (await exists(path)) return { url: publicUrl(path), made: false };
  const out = await makePicture(scenePrompt(theme, variant, false, '', settings.look), null);
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

// Our own series titles, so parents recognise each kind of poster (written by DigiSmart, fixed)
const SERIES = {
  teachers:  { ta: 'ஆசிரியர் என்னும் அன்பு…', en: "A Teacher's Heart" },
  memories:  { ta: 'பள்ளி நினைவுகள்…', en: 'Our School Days' },
  parenting: { ta: 'பெற்றோருக்கு ஒரு வார்த்தை…', en: 'A Word for Parents' },
  exam:      { ta: 'தேர்வு நேர டிப்ஸ்…', en: 'Exam Time Tips' },
  values:    { ta: 'இன்றைய சிந்தனை…', en: 'Thought for Today' },
  admission: { ta: 'உங்கள் குழந்தையின் அடுத்த அடி…', en: "Your Child's Next Step" }
};

// ── The big cut-out portrait (placed style): made once per saved photo, then used on every poster ──
const PORTRAIT_TRIES = 3;
// The photo's own fingerprint, so saving only a new name does not throw away (and re-pay for) the portrait
async function photoKey(base) {
  try {
    const r = await fetch(publicUrl(base + '.jpg') + '?t=' + Date.now(), { method: 'HEAD' });
    if (!r.ok) return '';
    const k = String(r.headers.get('etag') || r.headers.get('content-length') || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    return k || 'x';
  } catch (e) { return ''; }
}
async function portraitInfo(sid) {
  const base = sid + '/festival/person';
  const v = await photoKey(base);
  if (!v) return null;
  return { base, v };
}
function portraitPath(sid, v, gender, n) { return sid + '/daily/portrait-' + v + '-' + gender + '-' + n + '.png'; }
async function currentPortrait(sid, gender) {
  const p = await portraitInfo(sid); if (!p) return '';
  const done = await readJson(sid + '/daily/portrait.json', {});
  if (done.v === p.v && done.gender === gender && done.path && (await exists(done.path))) return publicUrl(done.path);
  return '';
}
async function makePortrait(sid, gender, again) {
  const p = await portraitInfo(sid);
  if (!p) throw new Error('Please save the correspondent / principal photo first.');
  const done = await readJson(sid + '/daily/portrait.json', {});
  const same = done.v === p.v && done.gender === gender;
  if (same && done.path && !again && (await exists(done.path))) return { url: publicUrl(done.path), made: false };
  const n = same ? (done.n || 0) + 1 : 1;
  if (n > PORTRAIT_TRIES) throw new Error('The portrait has already been made ' + PORTRAIT_TRIES + ' times for this photo. To try again, save a new, clearer photo.');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('AI pictures are not set up yet for ERP (OPENAI_API_KEY missing in Vercel).');
  const pr = await fetch(publicUrl(p.base + '.jpg') + '?t=' + Date.now());
  if (!pr.ok) throw new Error('Could not read the saved photo. Please save it again.');
  const personBuf = Buffer.from(await pr.arrayBuffer());
  const who = gender === 'madam'
    ? 'the woman from the reference photo. Keep her face, features, skin tone, hairstyle, bindi and glasses (if any) exactly the same so she is clearly recognisable. She wears an elegant, neatly draped cotton-silk saree in a rich colour, '
    : 'the man from the reference photo. Keep his face, features, skin tone, hairstyle, moustache and glasses (if any) exactly the same so he is clearly recognisable. He wears a neat, well-ironed formal shirt, ';
  const prompt = 'A high-quality professional studio portrait photograph of ' + who
    + 'with a warm, kind, confident smile, like a respected Indian school leader. Half-body (waist up), facing slightly towards the left, '
    + 'soft flattering studio light, sharp and natural. The person is centred and fills most of the frame, with the top of the head fully inside the picture. '
    + 'Completely plain transparent background — or, if that is not possible, one flat, even, pure white background with no shadow, gradient or texture — only the person, nothing else. No text, no logo, no watermark.';
  let opts = { background: 'transparent', output_format: 'png', input_fidelity: 'high' };
  let out = null;
  for (let attempt = 0; attempt < 4 && !out; attempt++) {
    const fd = new FormData();
    fd.append('model', OPENAI_MODEL); fd.append('prompt', prompt); fd.append('n', '1');
    fd.append('size', '1024x1536'); fd.append('quality', IMAGE_QUALITY);
    Object.entries(opts).forEach(([k, v]) => fd.append(k, String(v)));
    fd.append('image[]', new Blob([personBuf], { type: 'image/jpeg' }), 'person.jpg');
    const r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: fd });
    const raw = await r.text();
    let d = null; try { d = JSON.parse(raw); } catch (e) {}
    if (r.ok && d && d.data && d.data[0] && d.data[0].b64_json) { out = Buffer.from(d.data[0].b64_json, 'base64'); break; }
    const msg = (d && d.error && d.error.message) || raw.slice(0, 200);
    const bad = Object.keys(opts).find(k => msg.indexOf(k) !== -1);
    if (bad) { opts = Object.assign({}, opts); delete opts[bad]; continue; }   // a model without see-through background: plain PNG, the page softens the edges
    if (/safety|moderation|rejected/i.test(msg)) throw new Error('The picture maker could not draw this portrait. Please try a different, clearer photo.');
    throw new Error('Picture maker error ' + r.status + ': ' + msg);
  }
  if (!out) throw new Error('The picture maker is not available right now.');
  const path = portraitPath(sid, p.v, gender, n);
  await storeFile(out, path, 'image/png');
  await storeFile(Buffer.from(JSON.stringify({ v: p.v, gender, n, path })), sid + '/daily/portrait.json', 'application/json');
  return { url: publicUrl(path), made: true };
}

// AI writes the words. Only the school name and fixed choices go in — no free text from the page.
async function writeMessage(schoolName, theme, language, history) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('AI writing is not set up (ANTHROPIC_API_KEY missing in Vercel).');
  const recent = (history.items || []).slice(0, 30).map(it => '- ' + it.title).join('\n') || '(none yet)';
  const L = language === 'en' ? 'en' : 'ta', lang = L === 'en' ? 'English' : 'Tamil';
  const want = '"title_' + L + '": the HOOK — a striking ' + lang + ' opening line or question that stops a parent scrolling (3–7 words), '
    + '"body_' + L + '": EXACTLY 2 ' + lang + ' lines that tell the moment — each a complete, flowing sentence (5–9 words each), the second line leading into the punch line, '
    + '"punch_' + L + '": the PUNCH LINE (2–5 words) — a short, complete statement that makes full sense alone, it will be highlighted, '
    + '"quote_' + L + '": what a child or parent would say in that moment, in their own spoken voice (under 7 words), or "" if it does not fit, '
    + '"end_' + L + '": the CLOSING SAYING — ONE memorable, quotable line (6–12 words), like a wise saying a parent would want to share or remember'
    + (language === 'both' ? ', "line_en": ONE short, clear, natural English line (under 10 words) that says the closing saying\'s meaning simply' : '');
  const tamilRules = L === 'ta'
    ? '- TAMIL STYLE: write the hook, the lines, the punch line and the closing saying in clear, beautiful, simple WRITTEN Tamil (எழுத்துத் தமிழ்), the way a good Tamil poster, book or newspaper writes — '
      + 'correct grammar, correct spelling and correct புணர்ச்சி (sandhi), complete sentences that flow, gentle rhythm, and எதுகை / மோனை where it comes naturally. '
      + 'Do NOT write broken, clipped or telegraphic Tamil, and do NOT translate from English word by word. Avoid English words unless no common Tamil word exists. '
      + 'Only the quote bubble is in spoken Tamil (பேச்சுத் தமிழ்), exactly as a child or parent really talks.\n'
      + '- The CLOSING SAYING is the heart of the poster: it must read like a பொன்மொழி — a complete, balanced thought with a turn or contrast in it, not a plain statement of fact.\n'
      + '- Examples of the STYLE only (do not reuse these words or ideas):\n'
      + '  hook "அந்த மஞ்சள் பை நினைவிருக்கிறதா?" · lines "அம்மா தைத்துத் தந்த துணிப்பையில் புத்தகங்கள்." / "அதனுடன் ஒரு டிபன் பாக்ஸும், நிறைய கனவுகளும்." · punch "எளிமையே பெருமை!" · '
      + 'saying "சிறிய பையில் சுமந்தது புத்தகம் அல்ல; நம் எதிர்காலம்."\n'
      + '  hook "தேர்வுக்கு முந்தைய இரவு…" · lines "புத்தகத்தை மூடிவிட்டு நிம்மதியாகத் தூங்கட்டும்." / "ஓய்வெடுத்த மனமே தெளிவாக எழுதும்." · punch "தூக்கமும் படிப்புதான்!" · quote "அம்மா, நாளைக்கு எல்லாம் ஞாபகம் இருக்குமா?" · '
      + 'saying "விழித்திருந்து படிப்பதைவிட, விழிப்புடன் படிப்பதே வெற்றி."\n'
    : '- ENGLISH STYLE: warm, simple, natural English sentences that flow; the closing line reads like a memorable saying with a turn or contrast in it.\n';
  const prompt = 'You write daily social media posters for an Indian school in Tamil Nadu, "' + schoolName + '". '
    + 'Parents follow the school page. The posters are warm, emotional and positive, like the best Tamil school posts that parents love to share. '
    + 'Each poster tells ONE small, real-feeling moment as a story — a hook, two flowing lines, a punch line, maybe a child\'s words, and a closing saying worth remembering — not a list of advice.\n\n'
    + 'Today\'s theme: ' + THEMES[theme].name + ' — ' + THEMES[theme].brief + '.\n\n'
    + 'Rules:\n'
    + '- Write something NEW and original. Do not copy lines from any other page, film, song or poem.\n'
    + tamilRules
    + '- Simple, everyday words a parent understands at once. No hashtags, emojis, phone numbers, fees or dates on the poster.\n'
    + '- Keep the whole poster (hook + lines + punch + quote + saying) under 40 words in total, so the letters stay big.\n'
    + '- Never name or criticise another school. Nothing about religion, caste or politics.\n'
    + '- Do not repeat these recent headings:\n' + recent + '\n\n'
    + 'Reply with JSON only, no other text, with: ' + want
    + ', plus "caption_en": a 2–3 sentence English caption for Facebook/Instagram, "caption_ta": the same caption in natural Tamil, '
    + '"hashtags": 4–6 hashtags separated by spaces, and "title": a short English label for this poster (under 8 words).';
  const ask = async (content, maxTokens) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: TEXT_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content }] })
    });
    const raw = await r.text();
    if (!r.ok) throw new Error('AI could not write the message right now (' + r.status + '). Please try again.');
    let reply = '';
    try { reply = (JSON.parse(raw).content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim(); } catch (e) {}
    try { const a = reply.indexOf('{'), b = reply.lastIndexOf('}'); return JSON.parse(reply.slice(a, b + 1)); } catch (e) { return null; }
  };
  let t = await ask(prompt, 1400);
  if (!t) throw new Error('AI wrote something unreadable. Please press "New message".');
  // Second look by a Tamil editor: fix grammar, spelling and flow, make the ending a real saying (Oct 2026 — the first drafts read clipped)
  if (L === 'ta') {
    const keys = ['title_ta', 'body_ta', 'punch_ta', 'quote_ta', 'end_ta', 'caption_ta'];
    const draft = {}; keys.forEach(k => { draft[k] = t[k]; });
    const fixed = await ask('You are a senior Tamil editor and poet who writes posters for a respected Tamil Nadu school. '
      + 'Polish this Tamil poster text. Keep the same story, meaning and JSON keys. '
      + 'Rules: correct every grammar, spelling and புணர்ச்சி (sandhi) mistake; turn any clipped or word-by-word-translated line into a complete, natural, flowing sentence in clear written Tamil; '
      + 'title_ta 3–7 words, body_ta exactly 2 lines of 5–9 words, punch_ta 2–5 words and must make sense alone; '
      + 'end_ta must read like a பொன்மொழி — memorable, balanced, with a turn or contrast; '
      + 'read every line once more as a parent would: no line may carry an unintended or negative meaning (for example "வீட்டை விட்டு ஓடியது" reads as running away from home) — rephrase any such line; '
      + 'quote_ta stays in natural spoken Tamil (or stays "" if empty); caption_ta natural Tamil. Avoid English words unless no common Tamil word exists. '
      + 'Reply with JSON only, same keys:\n' + JSON.stringify(draft), 1200).catch(() => null);
    if (fixed) keys.forEach(k => { if (fixed[k] !== undefined && (Array.isArray(fixed[k]) ? fixed[k].length : String(fixed[k] || '').trim() || k === 'quote_ta')) t[k] = fixed[k]; });
  }
  const lines = (v, n, m) => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => str(x, m)).filter(Boolean).slice(0, n);
  return {
    title_ta: str(t.title_ta, 90), body_ta: lines(t.body_ta, 2, 110), line_en: str(t.line_en, 120),
    title_en: str(t.title_en, 80), body_en: lines(t.body_en, 2, 120),
    punch_ta: str(t.punch_ta, 70), quote_ta: str(t.quote_ta, 90), end_ta: str(t.end_ta, 130),
    punch_en: str(t.punch_en, 60), quote_en: str(t.quote_en, 90), end_en: str(t.end_en, 130),
    series_ta: SERIES[theme].ta, series_en: SERIES[theme].en,
    caption_en: str(t.caption_en, 1200), caption_ta: str(t.caption_ta, 1600),
    hashtags: str(t.hashtags, 300), title: str(t.title, 80) || THEMES[theme].name
  };
}

// ════════════ Step 3: this week's posters ════════════
const WEEK_COUNT = 3;
function weekPath(sid, wk) { return sid + '/daily/week-' + (wk || weekKey()) + '.json'; }
async function saveWeek(sid, week) { await storeFile(Buffer.from(JSON.stringify(week)), weekPath(sid, week.week), 'application/json'); }
async function addHistory(sid, theme, text) {
  const histPath = sid + '/daily/history.json';
  const history = await readJson(histPath, { items: [] });
  const items = [{ theme, title: text.title_ta || text.title_en || text.title, at: new Date().toISOString() }].concat(history.items || []).slice(0, 60);
  await storeFile(Buffer.from(JSON.stringify({ items })), histPath, 'application/json');
  return { items };
}
// Make the week's posters: 3 different themes in turn, words first, then the pictures together
async function prepareWeek(sid, schoolName) {
  const settings = await readSettings(sid);
  let history = await readJson(sid + '/daily/history.json', { items: [] });
  const items = [];
  for (let i = 0; i < WEEK_COUNT; i++) {
    const theme = nextTheme(history);
    const text = await writeMessage(schoolName, theme, settings.language, history);
    history = await addHistory(sid, theme, text);
    items.push({ id: crypto.randomUUID().slice(0, 8), theme, theme_name: THEMES[theme].name, variant: 1, text, url: '', status: 'ready', error: '' });
  }
  await Promise.all(items.map(async it => {
    try { it.url = (await posterPicture(sid, settings, it.theme, it.variant)).url; }
    catch (e) { it.error = e.message; }
  }).concat(settings.style === 'placed' ? [makePortrait(sid, settings.gender, false).catch(() => null)] : []));
  const week = { week: weekKey(), made_at: new Date().toISOString(), style: settings.style, language: settings.language, items };
  await saveWeek(sid, week);
  return week;
}

module.exports = async (req, res) => {
  // ── Step 4: Monday morning, make every school's posters ──
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET || '';
    const header = String(req.headers.authorization || '');
    const fromQuery = req.query && String(req.query.key || '') === secret;
    if (!secret || (header !== 'Bearer ' + secret && !fromQuery)) return res.status(401).json({ ok: false, error: 'Not allowed.' });
    const started = Date.now();
    const out = { ok: true, ran_at: new Date().toISOString(), week: weekKey(), schools: [] };
    try {
      const schools = ((await sb('GET', 'schools?has_social=is.true&has_daily_posters=is.true&select=school_id,name&limit=300')) || []).filter(s => isSchool(s.school_id));
      const todo = [];
      for (const s of schools) {
        const set = await readSettings(s.school_id);
        if (!set.enabled) continue;
        const have = await readJson(weekPath(s.school_id), null);
        if (have && (have.items || []).length) { out.schools.push(s.school_id + ': already done'); continue; }
        todo.push(s);
      }
      // 4 schools at a time; stop starting new ones near the time limit (the 7 am run picks them up)
      for (let i = 0; i < todo.length; i += 4) {
        if (Date.now() - started > 120000) { out.schools.push((todo.length - i) + ' school(s) left for the next run'); break; }
        const batch = todo.slice(i, i + 4);
        const done = await Promise.all(batch.map(s => prepareWeek(s.school_id, str(s.name, 80) || 'our school')
          .then(w => s.school_id + ': made ' + w.items.length + (w.items.some(x => x.error) ? ' (some pictures missing)' : ''))
          .catch(e => s.school_id + ': error ' + e.message)));
        out.schools = out.schools.concat(done);
      }
    } catch (e) { out.error = e.message; }
    return res.status(200).json(out);
  }
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

    let sch;
    try {
      sch = ((await sb('GET', 'schools?school_id=eq.' + encodeURIComponent(sid) + '&select=school_id,has_social,has_daily_posters&limit=1')) || [])[0];
    } catch (e) {
      if (/has_daily_posters/.test(e.message)) return res.status(403).json({ ok: false, not_on: true, error: 'Daily Posters is not set up yet. Please contact DigiSmart.' });
      throw e;
    }
    if (!sch || sch.has_social !== true) {
      return res.status(403).json({ ok: false, error: 'Social Media Posts is not switched on for this school. Please contact DigiSmart.' });
    }
    if (sch.has_daily_posters !== true) {
      return res.status(403).json({ ok: false, not_on: true, error: 'Daily Posters is an add-on that is not switched on for your school yet. Please contact DigiSmart to start it.' });
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

    // ── Step 3: this week's posters ──
    if (action === 'portrait_get') {
      const settings = await readSettings(sid);
      return res.status(200).json({ ok: true, url: await currentPortrait(sid, settings.gender) });
    }
    if (action === 'portrait_make') {
      const settings = await readSettings(sid);
      const r = await makePortrait(sid, settings.gender, body.again === true);
      return res.status(200).json({ ok: true, url: r.url, made: r.made });
    }
    if (action === 'week_get') {
      return res.status(200).json({ ok: true, week: await readJson(weekPath(sid), null), this_week: weekKey() });
    }
    if (action === 'week_prepare') {
      const settings = await readSettings(sid);
      if (settings.style === 'painted' && !(await exists(sid + '/festival/person.jpg'))) {
        return res.status(400).json({ ok: false, error: 'Please save the correspondent / principal photo in Setup first.' });
      }
      const old = await readJson(weekPath(sid), null);
      if (old && (old.items || []).length && body.again !== true) return res.status(200).json({ ok: true, week: old });
      const name = ((await sb('GET', 'schools?school_id=eq.' + encodeURIComponent(sid) + '&select=name&limit=1')) || [])[0];
      return res.status(200).json({ ok: true, week: await prepareWeek(sid, str(name && name.name, 80) || 'our school') });
    }
    if (action === 'week_update') {
      const week = await readJson(weekPath(sid), null);
      const it = week && (week.items || []).find(x => x.id === String(body.id || ''));
      if (!it) return res.status(404).json({ ok: false, error: 'That poster is no longer in this week\'s list. Please refresh.' });
      if (body.text && typeof body.text === 'object') {
        const t = body.text, lines = (v, n, m) => (Array.isArray(v) ? v : []).map(x => str(x, m)).filter(Boolean).slice(0, n);
        it.text = Object.assign({}, it.text, {
          title_ta: str(t.title_ta, 90), body_ta: lines(t.body_ta, 5, 110), line_en: str(t.line_en, 120),
          title_en: str(t.title_en, 80), body_en: lines(t.body_en, 5, 120),
          punch_ta: str(t.punch_ta, 70), quote_ta: str(t.quote_ta, 90), end_ta: str(t.end_ta, 130),
          punch_en: str(t.punch_en, 60), quote_en: str(t.quote_en, 90), end_en: str(t.end_en, 130),
          caption_en: str(t.caption_en, 1200), caption_ta: str(t.caption_ta, 1600), hashtags: str(t.hashtags, 300), title: str(t.title, 80)
        });
      }
      if (body.variant !== undefined) {
        const v = Math.min(MAX_VARIANTS, Math.max(1, parseInt(body.variant, 10) || 1));
        const settings = await readSettings(sid);
        it.url = (await posterPicture(sid, settings, it.theme, v)).url;
        it.variant = v; it.error = '';
      }
      if (['ready', 'added', 'skipped'].indexOf(body.status) !== -1) it.status = body.status;
      await saveWeek(sid, week);
      return res.status(200).json({ ok: true, item: it });
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
      // The animated Reel (optional): must be this school's own upload, a real file, not too big
      if (body.video) {
        const vu = String(body.video);
        const pre = publicUrl(sid + '/');
        if (vu.indexOf(pre) !== 0 || !/\/reel-[a-zA-Z0-9-]+\.mp4$/.test(vu)) return res.status(400).json({ ok: false, error: 'That Reel is not from this school.' });
        const h = await fetch(vu, { method: 'HEAD' });
        if (!h.ok) return res.status(400).json({ ok: false, error: 'The Reel did not finish uploading. Please try again.' });
        if (Number(h.headers.get('content-length') || 0) > 40 * 1048576) return res.status(400).json({ ok: false, error: 'The Reel is too big.' });
        row.own_video = vu;
        const secs = Number(body.video_seconds);
        if (secs > 0 && secs < 120) row.video_seconds = Math.round(secs * 10) / 10;
        row.title = (row.title + ' (Reel)').slice(0, 80);
      }
      const saved = ((await sbInsert('social_posts', row)) || [])[0];
      return res.status(200).json({ ok: true, row: saved });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
};
