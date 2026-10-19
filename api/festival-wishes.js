// DigiSmart ERP — Festival Wishes API (part of Social Media Posts)
// Festival greeting posters: a festival picture + school logo + school name + wishes,
// optionally with the correspondent's photo. The poster itself is drawn in the browser
// (js/festival-wishes.js) — no server cost. This door only does three things:
//
//   1. art      { festival, variant, design? }  → { ok, url }   design 'full' = full-poster picture
//      The AI festival picture (Goddess Saraswathi, Pongal pot, Deepavali lamps …).
//      Made ONCE by OpenAI and saved in the public 'social-posts' bucket under
//      festival-art/ — every school shares the same pictures, so each one is paid for
//      only once. Only fixed pictures from the list below can be made (no free text),
//      and at most 4 versions per festival, so the cost can never run away.
//   2. person   { data_url, name, role } → { ok, person }   save the correspondent's photo once
//      person_get {}                      → { ok, person }   (null when none saved)
//      person_remove {}                   → { ok }
//   3. post     { data_url, title, caption_en, caption_ta, hashtags } → { ok, row }
//   today    {}  → today's (or tomorrow's) festival from the calendar + its ready pictures
//   compose  { festival, variant, en, with_person, pose } → this school's whole AI poster (see makePoster)
//            pose: auto | vanakkam | smile | heart | formal | majestic | folded
//   GET (Vercel scheduler, nightly) → makes tomorrow's festival pictures ahead of time
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

// "Full picture" design: the picture fills the whole poster, like greetings seen in Reels.
// The school logo, name and wishes are laid on top in the browser, so the picture keeps
// calm space at the top and bottom for them. (Saved separately from the framed pictures.)
const ART_STYLE_FULL = 'A stunning, richly detailed festival greeting artwork that fills the whole frame edge to edge, '
  + 'like a premium festival wishes post on Instagram: cinematic warm glowing light, deep rich colours, fine detail, '
  + 'soft bokeh sparkles, flowers and brass lamps around, an auspicious celebratory mood, beautiful and respectful. '
  + 'Tall vertical composition. The main subject is large and centred in the middle of the frame. '
  + 'The top sixth of the picture is a calm, softly glowing, uncluttered background. '
  + 'The bottom third gently fades into a darker, uncluttered area of soft glow, with no important details there, '
  + 'because greeting text will be added on top later. '
  + 'No text, no letters, no numbers, no words, no signature, no watermark, no border, no frame. Picture: ';

// Brighter version (Oct 2026): the first full pictures came out dark and moody.
// Bright daylight, vivid festive colours, light cream space at the bottom for the wishes band.
const ART_STYLE_BRIGHT = 'A bright, vivid, cheerful Indian festival greeting artwork that fills the whole frame edge to edge, '
  + 'like a premium colourful festival wishes post on Instagram: clear bright daylight, sunny warm glow, '
  + 'vibrant saffron, gold, white, pink and green colours, fresh marigold and jasmine garlands, pink lotus flowers, '
  + 'shining brass lamps, a joyful auspicious mood, beautiful and respectful, high detail. Never dark, gloomy or night-time. '
  + 'Tall vertical composition. The main subject is large and placed in the upper and middle part of the frame. '
  + 'The bottom quarter of the picture is a soft, light, cream-coloured and uncluttered area with no important details, '
  + 'because a greeting band will be added on top later. '
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

// ── Festival calendar (Tamil Nadu) ──
// Fixed-date festivals repeat every year. Moving festivals are listed by date and must be
// added for each new year (dates checked Oct 2026 from Drik Panchang / the TN holiday list;
// Ramzan and Bakrid depend on the moon and may move by a day).
const FIXED = { '01-01': 'new_year', '01-15': 'pongal', '01-26': 'republic', '04-14': 'tamil_new_year',
  '08-15': 'independence', '09-05': 'teachers', '11-14': 'childrens', '12-25': 'christmas' };
const MOVING = {
  '2026-10-19': 'ayudha', '2026-10-20': 'ayudha', '2026-10-21': 'vijayadasami',
  '2026-11-08': 'deepavali', '2026-11-24': 'karthigai',
  '2027-03-09': 'ramzan', '2027-05-17': 'bakrid', '2027-08-25': 'krishna', '2027-09-04': 'vinayagar',
  '2027-10-08': 'ayudha', '2027-10-09': 'vijayadasami', '2027-10-29': 'deepavali', '2027-12-12': 'karthigai'
};
// Which picture each festival uses (same as the list in js/festival-wishes.js)
const FEST_ART = { ayudha: 'saraswathi', saraswathi: 'saraswathi', vijayadasami: 'vijayadasami', deepavali: 'deepavali',
  childrens: 'childrens', karthigai: 'karthigai', christmas: 'christmas', new_year: 'new_year', pongal: 'pongal',
  republic: 'republic', tamil_new_year: 'tamil_new_year', ramzan: 'ramzan', bakrid: 'bakrid', independence: 'independence',
  krishna: 'krishna', teachers: 'teachers', vinayagar: 'vinayagar' };
function istDate(addDays) {
  return new Date(Date.now() + 5.5 * 3600000 + (addDays || 0) * 86400000).toISOString().slice(0, 10);
}
function festivalOnDay(d) { return MOVING[d] || FIXED[d.slice(5)] || null; }
// The festival to show today: today's own festival first, else tomorrow's (posters go out the evening before)
function currentFestival() {
  const today = festivalOnDay(istDate(0));
  if (today) return { key: today, date: istDate(0), when: 'today' };
  const tom = festivalOnDay(istDate(1));
  if (tom) return { key: tom, date: istDate(1), when: 'tomorrow' };
  return null;
}
async function existingArt(pre, art, v) {
  for (const ext of ['jpg', 'png']) {
    const p = ART_FOLDER + '/' + pre + art + '-v' + v + '.' + ext;
    if (await exists(p)) return publicUrl(p);
  }
  return '';
}
// Make one picture now if it is not saved yet (used by the nightly run)
async function ensureArt(full, art, v) {
  const pre = full ? 'bright-' : '';
  const have = await existingArt(pre, art, v);
  if (have) return { made: false, url: have };
  const prompt = (full ? ART_STYLE_BRIGHT : ART_STYLE) + FESTIVALS[art][(v - 1) % FESTIVALS[art].length];
  const out = await drawArt(prompt);
  const p = ART_FOLDER + '/' + pre + art + '-v' + v + '.' + (out.jpeg ? 'jpg' : 'png');
  await storeFile(out.buf, p, out.jpeg ? 'image/jpeg' : 'image/png');
  return { made: true, url: publicUrl(p) };
}

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

// ── "AI poster" design (Oct 2026): the AI makes the WHOLE poster in one go — festival scene,
//    the correspondent painted into it (from the saved photo), the school name and the English
//    greeting as designed lettering, and an empty ribbon at the bottom. The browser then adds
//    only what the AI cannot be trusted with: Tamil wishes (in the ribbon), the real logo, the phone.
//    Made per school (its own name and photo), so it costs more than the shared pictures:
//    at most 4 versions per festival per school, saved and reused.
const POSTER_VERSION = 'p1';
const POSTER_QUALITY = process.env.FESTIVAL_POSTER_QUALITY || 'medium';
const FEST_NAME = { ayudha: 'Ayudha Pooja & Vijayadasami', saraswathi: 'Saraswathi Pooja', vijayadasami: 'Vijayadasami',
  deepavali: 'Deepavali', childrens: "Children's Day", karthigai: 'Karthigai Deepam', christmas: 'Christmas', new_year: 'New Year',
  pongal: 'Pongal', republic: 'Republic Day', tamil_new_year: 'Tamil New Year', ramzan: 'Ramzan', bakrid: 'Bakrid',
  independence: 'Independence Day', krishna: 'Krishna Jayanthi', teachers: "Teachers' Day", vinayagar: 'Vinayagar Chathurthi',
  other: 'Festival' };
const FEST_EN = { ayudha: 'Happy Ayudha Pooja & Vijayadasami', saraswathi: 'Happy Saraswathi Pooja', vijayadasami: 'Happy Vijayadasami',
  deepavali: 'Happy Deepavali', childrens: "Happy Children's Day", karthigai: 'Happy Karthigai Deepam', christmas: 'Merry Christmas',
  new_year: 'Happy New Year', pongal: 'Happy Pongal', republic: 'Happy Republic Day', tamil_new_year: 'Happy Tamil New Year',
  ramzan: 'Eid Mubarak', bakrid: 'Happy Bakrid', independence: 'Happy Independence Day', krishna: 'Happy Krishna Jayanthi',
  teachers: "Happy Teachers' Day", vinayagar: 'Happy Vinayagar Chathurthi' };
// Only plain letters go into the AI's instructions
function cleanText(v, max) { return String(v || '').replace(/[^A-Za-z0-9 .,&'!\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }

// How the correspondent / principal is shown. "auto" picks one that suits the festival.
const POSES = {
  vanakkam: 'smiling warmly with both hands folded in a respectful vanakkam greeting, wearing a crisp white traditional shirt with a gold-bordered angavastram on the shoulder',
  smile: 'with a warm, friendly, natural smile, relaxed and welcoming, wearing a neat crisp white shirt with a gold-bordered angavastram on the shoulder',
  heart: 'with a gentle smile and his right hand placed on his heart in a sincere greeting, wearing a neat light-coloured formal shirt',
  formal: 'smiling confidently, wearing a smart formal shirt with a dark well-fitted blazer, polished and professional',
  majestic: 'standing tall and majestic with a proud, dignified, confident expression, chin slightly raised, shoulders back, like a respected leader, wearing an elegant white silk shirt with a rich gold-bordered angavastram, a soft glow of light behind him',
  folded: 'standing confidently with his arms folded across his chest, a proud and friendly smile, like a successful school leader, wearing a smart formal shirt with a dark well-fitted blazer'
};
const AUTO_POSE = { independence: 'majestic', republic: 'majestic', teachers: 'formal', childrens: 'smile', new_year: 'formal',
  christmas: 'heart', ramzan: 'heart', bakrid: 'heart' };   // everything else: vanakkam
function resolvePose(festKey, pose) { return POSES[pose] ? pose : (AUTO_POSE[festKey] || 'vanakkam'); }

function posterPrompt(festKey, art, variant, schoolName, en, withPerson, pose) {
  const subjects = FESTIVALS[art] || FESTIVALS.general;
  const scene = subjects[(variant - 1) % subjects.length];
  return 'Design one complete, premium, professional Indian festival greeting poster for a school, for ' + (FEST_NAME[festKey] || 'the festival')
    + ', as a single finished artwork like the best festival posts on Instagram and ShareChat made by top designers. '
    + 'Tall vertical poster. Bright, vivid, cheerful colours, glowing warm daylight, rich detail, everything blended naturally with matching light and colour. '
    + 'Main scene: ' + scene + ' '
    + (withPerson
      ? 'Include the man from the reference photo in the poster: keep his face, features, skin tone, hairstyle, moustache and glasses exactly the same as in the photo so he is clearly recognisable. '
        + 'Show him as a dignified half-body portrait in the lower right part of the poster, ' + POSES[resolvePose(festKey, pose)] + ', '
        + 'lit by the same warm light as the scene and blended naturally into it, not cut out. '
        + 'He stands respectfully beside the scene and does not touch any deity. '
      : '')
    + 'Keep a square in the top-left corner of the poster, about one seventh of the width wide and tall, completely empty: only soft background there, no letters, no objects, because a logo will be placed there later. '
    + 'At the top of the poster, to the RIGHT of that empty corner, write the school name "' + schoolName + '" exactly as given, letter for letter, in elegant large gold 3D serif lettering with a fine maroon outline; the first letter must start well clear of the empty corner. '
    + 'Below the main scene write "' + en + '" in beautiful gold festive lettering, spelled exactly as given. '
    + 'Across the bottom of the poster, an ornate maroon and gold decorative ribbon banner spanning almost the full width and about one sixth of the height, completely EMPTY inside with no text, '
    + 'and below it a thin plain maroon strip, also empty. '
    + 'No other text, letters, numbers or words anywhere. No watermark, no signature.';
}
async function imageCall(path, makeBody) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('AI pictures are not set up yet for ERP (OPENAI_API_KEY missing in Vercel).');
  // Try with the best options first; drop any option this model does not know
  let opts = { output_format: 'jpeg', output_compression: 88, input_fidelity: 'high' };
  for (let attempt = 0; attempt < 4; attempt++) {
    const mb = makeBody(opts);
    const r = await fetch('https://api.openai.com/v1/images/' + path, {
      method: 'POST', headers: Object.assign({ Authorization: 'Bearer ' + apiKey }, mb.headers || {}), body: mb.body
    });
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
async function makePoster(prompt, personBuf) {
  if (!personBuf) {
    return imageCall('generations', (o) => ({ headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ model: OPENAI_MODEL, prompt, n: 1, size: '1024x1536', quality: POSTER_QUALITY },
        Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'input_fidelity')))) }));
  }
  return imageCall('edits', (o) => {
    const fd = new FormData();
    fd.append('model', OPENAI_MODEL); fd.append('prompt', prompt); fd.append('n', '1');
    fd.append('size', '1024x1536'); fd.append('quality', POSTER_QUALITY);
    Object.entries(o).forEach(([k, v]) => fd.append(k, String(v)));
    fd.append('image[]', new Blob([personBuf], { type: 'image/jpeg' }), 'person.jpg');
    return { body: fd };
  });
}
async function personInfo(sid) {
  const base = sid + '/festival/person';
  if (!(await exists(base + '.jpg'))) return null;
  let info = {};
  try { const r = await fetch(publicUrl(base + '.json') + '?t=' + Date.now()); if (r.ok) info = await r.json(); } catch (e) {}
  return { url: publicUrl(base + '.jpg'), v: info.v || 1 };
}
// Where one school's AI poster is saved: changes to the name, wishes or photo give a new place
function posterPath(sid, festKey, schoolName, en, personV, variant, pose) {
  const parts = [POSTER_VERSION, festKey, schoolName, en, personV || 0];
  if (personV && pose && pose !== 'vanakkam') parts.push(pose);   // vanakkam posters keep their old place
  const h = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
  return sid + '/festival/ai-' + festKey + '-' + h + '-v' + variant + '.jpg';
}
async function ensurePoster(sid, schoolName, festKey, enIn, withPerson, variant, poseIn) {
  const art = FEST_ART[festKey] || 'general';
  const en = cleanText(enIn, 60) || FEST_EN[festKey] || 'Festival Greetings';
  const name = cleanText(schoolName, 70) || 'Our School';
  const person = withPerson ? await personInfo(sid) : null;
  if (withPerson && !person) throw new Error('Please save the correspondent / principal photo first.');
  const pose = resolvePose(festKey, poseIn);
  const path = posterPath(sid, festKey, name, en, person ? person.v : 0, variant, pose);
  if (await exists(path)) return { url: publicUrl(path), made: false };
  let personBuf = null;
  if (person) {
    const r = await fetch(person.url + '?t=' + Date.now());
    if (!r.ok) throw new Error('Could not read the saved photo. Please save it again.');
    personBuf = Buffer.from(await r.arrayBuffer());
  }
  const out = await makePoster(posterPrompt(festKey, art, variant, name, en, !!person, pose), personBuf);
  await storeFile(out.buf, path, out.jpeg ? 'image/jpeg' : 'image/png');
  return { url: publicUrl(path), made: true };
}
async function readyPosters(sid, schoolName, festKey, withPerson) {
  const en = FEST_EN[festKey] || 'Festival Greetings';
  const name = cleanText(schoolName, 70) || 'Our School';
  const person = withPerson ? await personInfo(sid) : null;
  const list = [];
  for (let v = 1; v <= MAX_VARIANTS; v++) {
    const p = posterPath(sid, festKey, name, en, person ? person.v : 0, v, resolvePose(festKey, 'auto'));
    if (await exists(p)) list.push({ design: 'ai', variant: v, url: publicUrl(p), person: !!person });
  }
  return list;
}

module.exports = async (req, res) => {
  // ── Nightly (Vercel scheduler, ~7:30 pm India time): make tomorrow's festival pictures ahead,
  //    so on the festival morning every school's posters are ready with no waiting.
  //    Two "Full picture" versions + one "Framed". Shared by all schools, so made only once.
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET || '';
    const header = String(req.headers.authorization || '');
    const fromQuery = req.query && String(req.query.key || '') === secret;
    if (!secret || (header !== 'Bearer ' + secret && !fromQuery)) return res.status(401).json({ ok: false, error: 'Not allowed.' });
    const out = { ok: true, ran_at: new Date().toISOString(), festivals: [] };
    const keys = Array.from(new Set([festivalOnDay(istDate(1)), festivalOnDay(istDate(0))].filter(Boolean)));
    for (const k of keys) {
      const art = FEST_ART[k];
      if (!art || !FESTIVALS[art]) continue;
      const jobs = [[true, art, 1], [true, art, 2], [false, art, 1]];
      const done = await Promise.all(jobs.map(j => ensureArt(j[0], j[1], j[2]).then(r => (r.made ? 'made' : 'ready')).catch(e => 'error: ' + e.message)));
      out.festivals.push({ festival: k, picture: art, results: done });
    }
    // Each school with Social Media Posts: its own AI poster for tomorrow (with the saved photo, if any)
    const tomorrow = festivalOnDay(istDate(1));
    if (tomorrow) {
      try {
        const schools = (await sb('GET', 'schools?has_social=is.true&select=school_id,name&limit=200')) || [];
        out.posters = await Promise.all(schools.filter(sc => isSchool(sc.school_id)).map(async sc => {
          const withP = !!(await personInfo(sc.school_id));
          return ensurePoster(sc.school_id, sc.name, tomorrow, '', withP, 1)
            .then(r => sc.school_id + ': ' + (r.made ? 'made' : 'ready')).catch(e => sc.school_id + ': error ' + e.message);
        }));
      } catch (e) { out.posters_error = e.message; }
    }
    return res.status(200).json(out);
  }
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

    const sch = ((await sb('GET', 'schools?school_id=eq.' + enc(sid) + '&select=school_id,name,has_social&limit=1')) || [])[0];
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
      const full = body.design === 'full';
      const pre = full ? 'bright-' : '';
      for (const ext of ['jpg', 'png']) {
        const p = ART_FOLDER + '/' + pre + key + '-v' + v + '.' + ext;
        if (await exists(p)) return res.status(200).json({ ok: true, url: publicUrl(p), variant: v, max: MAX_VARIANTS, made: false });
      }
      const prompt = (full ? ART_STYLE_BRIGHT : ART_STYLE) + subjects[(v - 1) % subjects.length];
      const out = await drawArt(prompt);
      const p = ART_FOLDER + '/' + pre + key + '-v' + v + '.' + (out.jpeg ? 'jpg' : 'png');
      await storeFile(out.buf, p, out.jpeg ? 'image/jpeg' : 'image/png');
      return res.status(200).json({ ok: true, url: publicUrl(p), variant: v, max: MAX_VARIANTS, made: true });
    }

    // ── Today's festival and its pictures that are already made (no waiting, no cost) ──
    if (action === 'today') {
      const f = currentFestival();
      if (!f) return res.status(200).json({ ok: true, festival: null });
      const art = FEST_ART[f.key];
      const checks = [];
      for (const design of ['full', 'framed']) {
        for (let v = 1; v <= MAX_VARIANTS; v++) {
          checks.push(existingArt(design === 'full' ? 'bright-' : '', art, v).then(url => url ? { design, variant: v, url } : null));
        }
      }
      let ready = (await Promise.all(checks)).filter(Boolean);
      // this school's own AI posters come first
      try { ready = (await readyPosters(sid, sch.name, f.key, true)).concat(await readyPosters(sid, sch.name, f.key, false), ready); } catch (e) {}
      return res.status(200).json({ ok: true, festival: f.key, date: f.date, when: f.when, ready });
    }

    // ── The AI poster for this school ──
    if (action === 'compose') {
      const fk = String(body.festival || '');
      if (!FEST_NAME[fk]) return res.status(400).json({ ok: false, error: 'Unknown festival.' });
      const v = Math.min(MAX_VARIANTS, Math.max(1, parseInt(body.variant, 10) || 1));
      const r = await ensurePoster(sid, sch.name, fk, body.en, body.with_person === true, v, String(body.pose || 'auto'));
      return res.status(200).json({ ok: true, url: r.url, made: r.made, variant: v, max: MAX_VARIANTS });
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
