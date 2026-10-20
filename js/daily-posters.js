// DigiSmart ERP — Daily Posters (a tab inside Social Media Posts)
// Step 1: the school's setup — the correspondent / principal photo (shared with Festival Wishes),
// how they appear in the posters, the poster language, and the on/off switch.
// Step 2: the poster maker — AI writes the message, makes the picture; the words, logo, name and
//         (placed) photo are drawn on top here, so Tamil letters are always clean.
// Step 3: "This week's posters" — the week's 3 posters as tiles: add to Ready to Post, check & edit, skip.
// Step 4 adds the Monday auto-prepare.
//
// Used by pages/social-posts.html:
//   DP.init({ logoUrl, school })   after the page's "info" call
//   DP.open()                      when the 🗓 Daily Posters tab is opened
// Server doors: /api/daily-posters (settings) · /api/festival-wishes (the saved photo — same photo for both)

(function () {
  const API = '/api/daily-posters';
  const FW_API = '/api/festival-wishes';
  const MAROON = '#6B1A1A', MAROON_DARK = '#3E0D0D', GOLD = '#C9A84C', SANDAL = '#F5E6C8';
  const F_EN = '"Poppins", "Segoe UI", Arial, sans-serif';
  const F_TA = '"Noto Serif Tamil", "Noto Sans Tamil", "Latha", serif';

  // Sample words for the preview only (our own wording)
  const SAMPLE = { ta: 'ஒவ்வொரு குழந்தையும் ஒரு நட்சத்திரம்', en: 'Every child is a star — we help them shine.' };

  let cfg = { logoUrl: '', school: { name: '' } };
  let built = false, logoImg = null;
  const st = {
    settings: { enabled: false, style: 'placed', language: 'both', gender: 'sir', look: 'bright', per_week: 3, from_line: '' },
    person: null, personImg: null, personNew: '',
    portrait: null, portraitUrl: ''   // the big cut-out portrait (placed style), ready to draw
  };
  // Step 2: the poster being made
  const mk = { theme: 'auto', made: null, text: null, variant: 1, bg: null, busy: false, itemId: '' };
  // Step 3: this week's posters
  const wk = { week: null, imgs: {}, busy: false };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'success'); else alert(m); }
  function token() { return sessionStorage.getItem('digismart_session_token') || ''; }
  function who() { return (typeof STAFF_NAME !== 'undefined' && STAFF_NAME) ? STAFF_NAME : 'Office'; }
  async function post(url, action, extra) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action, token: token(), by: who() }, extra || {})) });
    let d; try { d = await r.json(); } catch (e) { throw new Error('The server sent back something unreadable (' + r.status + '). If this is new, check that ' + url.slice(1) + '.js was uploaded.'); }
    if (!d.ok) throw new Error(d.error || 'Something went wrong.');
    return d;
  }
  function loadImg(src) {
    return new Promise((ok, bad) => {
      const i = new Image(); i.crossOrigin = 'anonymous';
      i.onload = () => ok(i); i.onerror = () => bad(new Error('Could not load a picture.'));
      i.src = src;
    });
  }
  function fileToImg(file, maxSide) {
    return new Promise((ok, bad) => {
      const r = new FileReader();
      r.onerror = () => bad(new Error('Could not read that file.'));
      r.onload = async () => {
        try {
          const img = await loadImg(r.result);
          const s = Math.min(1, maxSide / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          const url = c.toDataURL('image/jpeg', 0.86);
          ok({ img: await loadImg(url), url });
        } catch (e) { bad(new Error('That file is not a photo.')); }
      };
      r.readAsDataURL(file);
    });
  }
  function chip(group, value, label, on) {
    return '<label class="chip' + (on ? ' on' : '') + '" data-g="' + group + '" data-v="' + value + '"><input type="radio" name="dp-' + group + '" value="' + value + '"' + (on ? ' checked' : '') + '>' + label + '</label>';
  }
  function setChip(group, v) {
    document.querySelectorAll('#tab-daily label.chip[data-g="' + group + '"]').forEach(l => {
      const on = l.dataset.v === v; l.classList.toggle('on', on); l.querySelector('input').checked = on;
    });
  }

  // ── THE TAB ──
  function build() {
    const box = $('tab-daily');
    if (!box || built) return;
    built = true;
    const s = st.settings;
    box.innerHTML =
      '<div class="card" style="margin-bottom:16px">'
      + '<div class="card-title">🗓 Daily Posters — what this is</div>'
      + '<div class="help" style="margin-top:6px">Every Monday, 3 ready posters for your school page: teachers\' love, school memories, parenting tips, exam tips, values, and admission messages in admission season. '
      + 'Each poster has your correspondent / principal, school logo and name. You check them, then share with one tap — like a social media agency, without the monthly bill.<br>'
      + 'Set up once below, then use <b>This week\'s posters</b>, or make one any time with <b>Make a poster now</b>.</div>'
      + '</div>'
      + weekHtml()
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start">'
      + '<div class="card">'
      +   '<div class="card-title">⚙️ Setup</div>'

      +   '<div class="lbl">1. Correspondent / principal photo</div>'
      +   '<div class="help">The same photo as Festival Wishes — save it once, it is used for both.</div>'
      +   '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px">'
      +     '<img id="dp-thumb" alt="" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--gold);display:none">'
      +     '<input type="file" id="dp-file" accept="image/*" class="form-control" style="max-width:260px"></div>'
      +   '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">'
      +     '<input id="dp-pname" class="form-control" maxlength="60" placeholder="Name, e.g. Mr. R. Kumar">'
      +     '<input id="dp-prole" class="form-control" maxlength="60" placeholder="e.g. Correspondent"></div>'
      +   '<div class="style-row"><b style="font-size:12px;margin-right:4px">This photo is of</b>'
      +     chip('gender', 'sir', '👨 Sir', s.gender === 'sir') + chip('gender', 'madam', '👩 Madam', s.gender === 'madam')
      +     '<div class="help" style="width:100%;margin-top:4px">So the AI draws the right person and dress.</div></div>'
      +   '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">'
      +     '<button class="btn btn-secondary btn-sm" id="dp-psave">💾 Save photo & name</button>'
      +     '<button class="btn btn-secondary btn-sm" id="dp-pdel">🗑 Remove saved photo</button></div>'
      +   '<div class="help" style="margin-top:4px">A clear, front-facing face photo looks best.</div>'

      +   '<div class="lbl" style="margin-top:16px">2. How should they appear?</div>'
      +   '<div class="style-row">'
      +     chip('style', 'placed', '🖼 Their photo placed on the poster', s.style === 'placed')
      +     chip('style', 'painted', '🎨 AI paints them into the picture', s.style === 'painted')
      +     '<div class="help" id="dp-style-note" style="width:100%;margin-top:6px"></div>'
      +     '<div id="dp-portrait-row" style="width:100%;margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      +       '<img id="dp-portrait-thumb" alt="" style="height:84px;border-radius:8px;background:#1F3B2C;display:none">'
      +       '<button class="btn btn-secondary btn-sm" id="dp-portrait-go">✨ Make the big portrait</button>'
      +       '<span class="help" id="dp-portrait-note" style="flex:1;min-width:180px"></span></div></div>'

      +   '<div class="lbl" style="margin-top:16px">3. Poster language</div>'
      +   '<div class="style-row">'
      +     chip('language', 'both', 'தமிழ் + one English line', s.language === 'both')
      +     chip('language', 'ta', 'தமிழ் only', s.language === 'ta')
      +     chip('language', 'en', 'English only', s.language === 'en') + '</div>'

      +   '<div class="lbl" style="margin-top:16px">Poster look</div>'
      +   '<div class="style-row">'
      +     chip('look', 'bright', '☀️ Bright (light, like admission ads)', (s.look || 'bright') === 'bright')
      +     chip('look', 'dark', '🌙 Dark glow', s.look === 'dark') + '</div>'

      +   '<div class="lbl" style="margin-top:16px">4. Signed as (optional)</div>'
      +   '<input id="dp-from" class="form-control" maxlength="70" placeholder="e.g. — Correspondent, ARK Global School">'

      +   '<label class="tick" style="margin-top:16px"><input type="checkbox" id="dp-on"> Make 3 posters for us every Monday</label>'
      +   '<div class="help" style="margin-left:27px">You can switch this off any time.</div>'

      +   '<div class="actions" style="margin-top:14px"><button class="btn btn-primary" id="dp-save">💾 Save setup</button></div>'
      + '</div>'

      + '<div class="card" style="text-align:center">'
      +   '<div class="card-title" style="text-align:left">👀 How a poster will look</div>'
      +   '<canvas id="dp-canvas" width="1080" height="1350" style="width:100%;max-width:340px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);background:' + MAROON_DARK + ';margin-top:8px"></canvas>'
      +   '<div class="help" id="dp-note" style="margin-top:8px"></div>'
      + '</div></div>'
      + makerHtml();

    $('dp-on').checked = !!s.enabled;
    $('dp-from').value = s.from_line || '';
    box.addEventListener('change', onChange);
    box.addEventListener('input', (e) => { if (/^dp-(pname|prole|from)$/.test(e.target.id)) redraw(); });
    $('dp-psave').onclick = savePerson;
    $('dp-pdel').onclick = removePerson;
    $('dp-save').onclick = saveSettings;
    $('dp-portrait-go').onclick = () => makePortrait();
    $('dp-wk-again').onclick = () => prepareWeek(true);
    wireMaker(box);
    styleNote();
  }

  function styleNote() {
    const n = $('dp-style-note'); if (!n) return;
    n.innerHTML = st.settings.style === 'painted'
      ? 'Looks natural, like the agency posters. <b>Costs more</b> — a fresh AI picture is made for your school for every poster.'
      : 'AI turns the photo into a big, neat portrait <b>once</b>; it stands large on every poster. <b>Much cheaper</b> than painting each poster.';
    const row = $('dp-portrait-row'); if (row) row.style.display = st.settings.style === 'placed' ? 'flex' : 'none';
    portraitNote();
  }

  async function onChange(e) {
    const t = e.target;
    if (t.name === 'dp-gender' || t.name === 'dp-style' || t.name === 'dp-language' || t.name === 'dp-look') {
      const g = t.name.slice(3);
      st.settings[g] = t.value; setChip(g, t.value);
      if (g === 'style') styleNote();
      return redraw();
    }
    if (t.id === 'dp-file' && t.files && t.files[0]) {
      try {
        const r = await fileToImg(t.files[0], 1024);
        st.personImg = r.img; st.personNew = r.url;
        $('dp-thumb').src = r.url; $('dp-thumb').style.display = '';
        toast('Photo added. Press "Save photo & name" to keep it.');
        redraw();
      } catch (err) { toast('⚠️ ' + err.message, 'error'); }
    }
  }

  // ── the saved photo (shared with Festival Wishes) ──
  async function loadPerson() {
    try {
      const d = await post(FW_API, 'person_get');
      if (!d.person) return;
      st.person = d.person;
      $('dp-pname').value = d.person.name || ''; $('dp-prole').value = d.person.role || '';
      $('dp-thumb').src = d.person.url; $('dp-thumb').style.display = '';
      st.personImg = await loadImg(d.person.url);
    } catch (e) { /* no photo saved yet */ }
  }
  async function savePerson() {
    if (!st.personNew && !st.person) { toast('⚠️ Please choose a photo first.', 'error'); return; }
    try {
      if (typeof showLoading === 'function') showLoading('Saving photo…');
      const d = await post(FW_API, 'person', { data_url: st.personNew || '', name: $('dp-pname').value.trim(), role: $('dp-prole').value.trim() });
      const newPhoto = !!st.personNew;
      st.person = d.person; st.personNew = '';
      if (newPhoto) await setPortrait('');   // a new photo needs a new portrait
      toast('Saved. Used for Daily Posters and Festival Wishes.');
    } catch (e) { toast('⚠️ ' + e.message, 'error'); }
    if (typeof hideLoading === 'function') hideLoading();
  }
  async function removePerson() {
    if (!st.person) { st.personImg = null; st.personNew = ''; $('dp-thumb').style.display = 'none'; redraw(); return; }
    if (!window.confirm('Remove the saved photo? It will also be removed from Festival Wishes.')) return;
    try {
      await post(FW_API, 'person_remove');
      st.person = null; st.personImg = null; st.personNew = '';
      $('dp-thumb').style.display = 'none'; $('dp-pname').value = ''; $('dp-prole').value = '';
      await setPortrait('');
      toast('Removed.'); redraw();
    } catch (e) { toast('⚠️ ' + e.message, 'error'); }
  }

  // ── settings ──
  async function loadSettings() {
    try {
      const d = await post(API, 'settings_get');
      st.settings = d.settings;
    } catch (e) { toast('⚠️ ' + e.message, 'error'); }
  }
  async function saveSettings() {
    if (st.personNew) await savePerson();
    const s = Object.assign({}, st.settings, { enabled: $('dp-on').checked, from_line: $('dp-from').value.trim() });
    if (s.enabled && !st.person) { toast('⚠️ Please save the correspondent / principal photo first.', 'error'); return; }
    try {
      if (typeof showLoading === 'function') showLoading('Saving…');
      const d = await post(API, 'settings_save', { settings: s });
      st.settings = d.settings;
      toast(s.enabled ? '✓ Saved. Weekly posters are switched on.' : '✓ Saved.');
    } catch (e) { toast('⚠️ ' + e.message, 'error'); }
    if (typeof hideLoading === 'function') hideLoading();
  }

  // ── preview: a simple sample showing the chosen language and photo style ──
  function wrap(x, text, maxW) {
    const words = String(text).split(' '); const lines = []; let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (x.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }
  function cover(x, img, X, Y, W, H) {
    const s = Math.max(W / img.width, H / img.height);
    const w = img.width * s, h = img.height * s;
    x.drawImage(img, X + (W - w) / 2, Y + (H - h) * 0.25, w, h);
  }
  // ── the big cut-out portrait (placed style) ──
  function portraitNote() {
    const n = $('dp-portrait-note'), btn = $('dp-portrait-go'); if (!n || !btn) return;
    if (!st.person) { n.textContent = 'Save the photo above first.'; btn.disabled = true; return; }
    btn.disabled = false;
    btn.textContent = st.portraitUrl ? '🔄 Make another portrait' : '✨ Make the big portrait';
    n.textContent = st.portraitUrl ? 'Ready — used on every poster. Not happy? Make another (up to 3 per photo).'
      : 'One AI picture, made once from the photo (about 1 minute). It is also made automatically with the first weekly posters.';
  }
  // If the AI could not give a see-through background, soften the edges so it still blends in
  // If the AI could not give a see-through background, remove the plain background here:
  // start from the picture's edges and clear every connected pixel close to the background colour
  // (like Photoshop's background eraser), then soften the outline by a pixel or two.
  function prepareCut(img) {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    let data;
    try { data = x.getImageData(0, 0, c.width, c.height); } catch (e) { return c; }
    const W = c.width, H = c.height, px = data.data;
    if (px[3 + 4 * (4 * W + 4)] < 20 && px[3 + 4 * (4 * W + W - 5)] < 20) return c;   // already see-through
    // background colour: the most common colour along the top and side edges
    const counts = {};
    const sample = (i) => { const k = (px[i] >> 4) + ',' + (px[i + 1] >> 4) + ',' + (px[i + 2] >> 4); counts[k] = (counts[k] || 0) + 1; };
    for (let xx = 0; xx < W; xx += 3) sample(4 * xx);
    for (let yy = 0; yy < H * 0.7; yy += 3) { sample(4 * (yy * W)); sample(4 * (yy * W + W - 1)); }
    const top = Object.keys(counts).sort((p1, p2) => counts[p2] - counts[p1])[0].split(',').map(v => v * 16 + 8);
    const TOL = 52, tol2 = TOL * TOL;
    const bgSat = Math.max(top[0], top[1], top[2]) - Math.min(top[0], top[1], top[2]);
    const near = (i) => {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const dr = r - top[0], dg = g - top[1], db = b - top[2];
      if (dr * dr + dg * dg + db * db >= tol2) return false;
      // a plain white / grey background has almost no colour; a light blue or cream shirt does — keep it
      return bgSat > 30 || (Math.max(r, g, b) - Math.min(r, g, b)) < 20;
    };
    // flood fill from all edges
    const bg = new Uint8Array(W * H), stack = [];
    const seed = (n) => { if (!bg[n] && near(4 * n)) { bg[n] = 1; stack.push(n); } };
    for (let xx = 0; xx < W; xx++) { seed(xx); seed((H - 1) * W + xx); }
    for (let yy = 0; yy < H; yy++) { seed(yy * W); seed(yy * W + W - 1); }
    while (stack.length) {
      const n = stack.pop(), xx = n % W, yy = (n - xx) / W;
      if (xx > 0) seed(n - 1); if (xx < W - 1) seed(n + 1);
      if (yy > 0) seed(n - W); if (yy < H - 1) seed(n + W);
    }
    let cleared = 0; for (let n = 0; n < W * H; n++) cleared += bg[n];
    if (cleared < W * H * 0.08) {
      // the background was not plain (nothing to remove) — fall back to softening the edges
      x.globalCompositeOperation = 'destination-in';
      x.save(); x.translate(W / 2, H * 0.62); x.scale(1, H / W * 1.15);
      const g = x.createRadialGradient(0, 0, 0, 0, 0, W * 0.56);
      g.addColorStop(0.55, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(-W, -H, W * 2, H * 2); x.restore();
      return c;
    }
    // mask → soften by blurring it slightly → apply
    const m = document.createElement('canvas'); m.width = W; m.height = H;
    const mx = m.getContext('2d'), md = mx.createImageData(W, H);
    for (let n = 0; n < W * H; n++) { md.data[4 * n + 3] = bg[n] ? 0 : 255; }
    mx.putImageData(md, 0, 0);
    const m2 = document.createElement('canvas'); m2.width = W; m2.height = H;
    const m2x = m2.getContext('2d'); m2x.filter = 'blur(' + Math.max(1, Math.round(W / 600)) + 'px)'; m2x.drawImage(m, 0, 0);
    // pull the outline in by a hair, so no light fringe is left around hair and shoulders
    const fd = m2x.getImageData(0, 0, W, H);
    for (let n = 0; n < W * H; n++) { const a = fd.data[4 * n + 3]; fd.data[4 * n + 3] = a < 140 ? 0 : Math.min(255, (a - 140) * 2.2); }
    m2x.putImageData(fd, 0, 0);
    x.globalCompositeOperation = 'destination-in'; x.drawImage(m2, 0, 0);
    x.globalCompositeOperation = 'source-over';
    return c;
  }
  async function setPortrait(url) {
    st.portraitUrl = url || ''; st.portrait = null;
    if (url) { try { st.portrait = prepareCut(await loadImg(url + '?t=' + Date.now())); } catch (e) { st.portrait = null; } }
    const t = $('dp-portrait-thumb'); if (t) { t.src = url || ''; t.style.display = url ? '' : 'none'; }
    portraitNote();
  }
  async function loadPortrait() {
    try { const d = await post(API, 'portrait_get'); await setPortrait(d.url); } catch (e) { /* none yet */ }
  }
  async function makePortrait() {
    if (st.personNew) await savePerson();
    if (!st.person) { toast('⚠️ Please save the photo first.', 'error'); return; }
    const again = !!st.portraitUrl;
    if (again && !window.confirm('Make a new portrait? (Up to 3 per photo.)')) return;
    const btn = $('dp-portrait-go'); btn.disabled = true;
    $('dp-portrait-note').textContent = '✨ Making the portrait… about 1 minute. Please keep this page open.';
    try {
      // the gender choice is read from saved settings on the server, so save it first
      await post(API, 'settings_save', { settings: Object.assign({}, st.settings, { enabled: $('dp-on').checked, from_line: $('dp-from').value.trim() }) });
      const d = await post(API, 'portrait_make', { again });
      await setPortrait(d.url); redraw(); drawMade(); if (wk.week) renderWeek();
      toast('✓ Portrait ready.');
    } catch (e) { toast('⚠️ ' + e.message, 'error'); portraitNote(); }
    btn.disabled = false;
  }

  // ── sample preview in Setup: the real poster drawing with sample words ──
  const SAMPLE_T = {
    series_ta: 'ஆசிரியர் என்னும் அன்பு…', series_en: "A Teacher's Heart",
    title_ta: 'Teacher வரலையா?', body_ta: ['வகுப்புக்குள் போக மாட்டான்…', 'சாப்பிடவும் மாட்டான்…'],
    punch_ta: 'அவ்வளவு அன்பு!', quote_ta: 'Miss எப்போ வருவாங்க?', end_ta: 'ஒரு ஆசிரியர் தான் குழந்தையின் உலகம்.',
    line_en: 'A teacher is a child\'s safe place.',
    title_en: 'Where is my teacher?', body_en: ['He would not go inside the class…', 'He would not eat his lunch…'],
    punch_en: 'That is love.', quote_en: 'When will Miss come?', end_en: 'A teacher becomes a child\'s whole world.'
  };
  async function redraw() {
    const c = $('dp-canvas'); if (!c) return;
    if (cfg.logoUrl && !logoImg) { try { logoImg = await loadImg(cfg.logoUrl); } catch (e) { logoImg = null; } }
    drawOn(c, SAMPLE_T, null, true);
    const note = $('dp-note');
    if (note) note.textContent = 'Sample words only, to show your choices. Real posters have a full picture and a new story each time.'
      + (st.settings.style === 'placed' && !st.portrait ? ' Make the big portrait to see the person here.' : '');
  }

  // ════════════ Step 2: make a poster ════════════
  const THEMES = [['auto', '✨ Auto (next theme in turn)'], ['teachers', "Teachers' love"], ['memories', 'School memories'],
    ['parenting', 'Parenting tips'], ['exam', 'Exam tips'], ['values', 'Values & assembly'], ['admission', 'Admission open']];
  function makerHtml() {
    return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start;margin-top:16px">'
      + '<div class="card">'
      +   '<div class="card-title">✨ Make a poster now</div>'
      +   '<div class="help" style="margin:4px 0 10px">AI writes a new message and makes the picture. Check the words, change them if you like, then add it to "Ready to Post". The first picture of a theme takes 1–2 minutes; after that it is ready at once.</div>'
      +   '<label class="form-label">Theme</label>'
      +   '<select id="dp-mk-theme" class="form-control">' + THEMES.map(t => '<option value="' + t[0] + '">' + esc(t[1]) + '</option>').join('') + '</select>'
      +   '<div class="actions" style="margin-top:10px"><button class="btn btn-primary" id="dp-mk-go">✨ Make poster</button></div>'
      +   '<div class="help" id="dp-mk-status" style="margin-top:8px"></div>'
      +   '<div id="dp-mk-edit" class="hidden">'
      +     '<div class="lbl" id="dp-mk-title-lbl">Heading</div><input id="dp-mk-title" class="form-control" maxlength="90">'
      +     '<div class="lbl" id="dp-mk-body-lbl">Lines (one per line)</div><textarea id="dp-mk-body" class="form-control" rows="4"></textarea>'
      +     '<div class="lbl">⭐ Punch line (highlighted)</div><input id="dp-mk-punch" class="form-control" maxlength="70">'
      +     '<div class="lbl">💬 Quote bubble (optional — leave empty to hide)</div><input id="dp-mk-quote" class="form-control" maxlength="90">'
      +     '<div class="lbl">Closing saying (பொன்மொழி)</div><input id="dp-mk-end" class="form-control" maxlength="130">'
      +     '<div id="dp-mk-en-row"><div class="lbl">English line</div><input id="dp-mk-en" class="form-control" maxlength="120"></div>'
      +     '<div class="help" style="margin-top:6px">Please read the Tamil once before sharing.</div>'
      +     '<div class="actions" style="margin-top:10px;flex-wrap:wrap">'
      +       '<button class="btn btn-secondary btn-sm" id="dp-mk-text">📝 New message</button>'
      +       '<button class="btn btn-secondary btn-sm" id="dp-mk-pic">🖼 Another picture</button>'
      +       '<button class="btn btn-gold btn-sm hidden" id="dp-mk-save">💾 Save changes to this week\'s poster</button></div>'
      +   '</div>'
      + '</div>'
      + '<div class="card" style="text-align:center">'
      +   '<canvas id="dp-mk-canvas" width="1080" height="1350" style="width:100%;max-width:380px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);background:' + MAROON_DARK + '"></canvas>'
      +   '<div class="actions" style="justify-content:center;margin-top:10px">'
      +     '<button class="btn btn-primary btn-sm" id="dp-mk-add" disabled>✅ Add to Ready to Post</button>'
      +     '<button class="btn btn-secondary btn-sm" id="dp-mk-dl" disabled>⬇ Download</button></div>'
      +   '<div class="help" style="margin-top:8px">"Ready to Post" lets you post to Facebook / Instagram, send to WhatsApp, or put it in the Parent Gallery.</div>'
      +   '<div class="style-row" style="justify-content:center;margin-top:12px"><b style="font-size:12px">🎬 Reel</b>'
      +     '<span class="help">Phone-size video: the words appear one by one with soft music — Reels reach far more parents.</span>'
      +     '<div style="width:100%;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:6px">'
      +       '<select id="dp-reel-music" class="form-control" style="width:auto;padding:5px 8px">'
      +         (window.SD && SD.MUSIC ? SD.MUSIC.map(m => '<option value="' + m.id + '"' + (m.id === 'calm-learning' ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') : '')
      +         '<option value="none">🔇 No music</option></select>'
      +       '<button class="btn btn-gold btn-sm" id="dp-reel-go" disabled>🎬 Make Reel</button></div>'
      +     '<div class="help" id="dp-reel-status" style="width:100%;text-align:center"></div>'
      +     '<div id="dp-reel-box" class="hidden" style="width:100%;text-align:center;margin-top:8px">'
      +       '<video id="dp-reel-video" controls playsinline style="width:100%;max-width:240px;border-radius:10px;background:#000"></video>'
      +       '<div class="actions" style="justify-content:center;margin-top:8px">'
      +         '<button class="btn btn-primary btn-sm" id="dp-reel-add">✅ Add Reel to Ready to Post</button>'
      +         '<button class="btn btn-secondary btn-sm" id="dp-reel-dl">⬇ Download Reel</button></div></div>'
      +   '</div>'
      + '</div></div>';
  }
  function wireMaker(box) {
    $('dp-mk-go').onclick = () => makePoster();
    $('dp-mk-text').onclick = () => newText();
    $('dp-mk-pic').onclick = () => newPicture();
    $('dp-mk-add').onclick = () => addToReady();
    $('dp-mk-dl').onclick = () => download();
    $('dp-mk-save').onclick = () => saveItem(true);
    $('dp-reel-go').onclick = () => makeReel();
    $('dp-reel-add').onclick = () => addReel();
    $('dp-reel-dl').onclick = () => { if (reel.url) { const a = document.createElement('a'); a.href = reel.url; a.download = fileName().replace('.jpg', '-reel.mp4'); a.click(); } };
    box.addEventListener('input', (e) => { if (/^dp-mk-(title|body|en|punch|quote|end)$/.test(e.target.id)) { readEdits(); drawMade(); } });
  }
  function mkStatus(t) { const s = $('dp-mk-status'); if (s) s.innerHTML = t; }
  function mkButtons() {
    ['dp-mk-go', 'dp-mk-text', 'dp-mk-pic', 'dp-mk-save'].forEach(id => { if ($(id)) $(id).disabled = mk.busy; });
    const ready = !mk.busy && mk.text && mk.bg;
    ['dp-mk-add', 'dp-mk-dl', 'dp-reel-go'].forEach(id => { if ($(id)) $(id).disabled = !ready || reel.busy; });
  }
  function rememberedVariant(theme) { try { return parseInt(localStorage.getItem('dp_v_' + st.settings.style + '_' + theme), 10) || 1; } catch (e) { return 1; } }
  function rememberVariant(theme, v) { try { localStorage.setItem('dp_v_' + st.settings.style + '_' + theme, String(v)); } catch (e) {} }

  // The words shown in the edit boxes, by language
  function fillEdits() {
    const t = mk.text, en = st.settings.language === 'en';
    $('dp-mk-edit').classList.remove('hidden');
    $('dp-mk-title-lbl').textContent = en ? 'Hook (first line)' : 'Hook — first Tamil line';
    $('dp-mk-body-lbl').textContent = (en ? 'Lines' : 'Tamil lines') + ' (one per line)';
    $('dp-mk-title').value = en ? (t.title_en || '') : (t.title_ta || '');
    $('dp-mk-body').value = ((en ? t.body_en : t.body_ta) || []).join('\n');
    $('dp-mk-en-row').style.display = st.settings.language === 'both' ? '' : 'none';
    $('dp-mk-en').value = t.line_en || '';
    const L = en ? 'en' : 'ta';
    $('dp-mk-punch').value = t['punch_' + L] || ''; $('dp-mk-quote').value = t['quote_' + L] || ''; $('dp-mk-end').value = t['end_' + L] || '';
  }
  function readEdits() {
    const t = mk.text; if (!t) return;
    const lines = $('dp-mk-body').value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 5);
    if (st.settings.language === 'en') { t.title_en = $('dp-mk-title').value.trim(); t.body_en = lines; }
    else { t.title_ta = $('dp-mk-title').value.trim(); t.body_ta = lines; t.line_en = $('dp-mk-en').value.trim(); }
    const L = st.settings.language === 'en' ? 'en' : 'ta';
    t['punch_' + L] = $('dp-mk-punch').value.trim(); t['quote_' + L] = $('dp-mk-quote').value.trim(); t['end_' + L] = $('dp-mk-end').value.trim();
  }

  async function loadPicture() {
    const d = await post(API, 'picture', { theme: mk.theme, variant: mk.variant });
    mk.bg = await loadImg(d.url);
    mk.max = d.max || 4;
    rememberVariant(mk.theme, mk.variant);
  }
  async function makePoster() {
    if (mk.busy) return;
    if (st.settings.style === 'painted' && !st.person) { toast('⚠️ Please save the correspondent / principal photo in Setup first.', 'error'); return; }
    mk.busy = true; mkButtons();
    try {
      mkStatus('✍️ AI is writing the message…');
      const d = await post(API, 'write', { theme: $('dp-mk-theme').value });
      mk.text = d.text; mk.theme = d.theme; mk.variant = rememberedVariant(d.theme); mk.bg = null; editingItem('');
      fillEdits(); drawMade();
      mkStatus('🖼 Getting the picture for <b>' + esc(d.theme_name) + '</b>… (the first one of a theme takes 1–2 minutes)');
      await loadPicture();
      drawMade();
      mkStatus('✓ Ready: <b>' + esc(d.theme_name) + '</b>. Check the words, then add it to "Ready to Post".');
    } catch (e) { mkStatus('⚠️ ' + esc(e.message)); }
    mk.busy = false; mkButtons();
  }
  async function newText() {
    if (mk.busy || !mk.text) return;
    mk.busy = true; mkButtons();
    try {
      mkStatus('✍️ Writing a new message…');
      const d = await post(API, 'write', { theme: mk.theme });
      mk.text = d.text; fillEdits(); drawMade();
      if (mk.itemId) await saveItem(false);
      mkStatus('✓ New message ready.');
    } catch (e) { mkStatus('⚠️ ' + esc(e.message)); }
    mk.busy = false; mkButtons();
  }
  async function newPicture() {
    if (mk.busy || !mk.text) return;
    mk.busy = true; mkButtons();
    const keep = mk.variant;
    try {
      mk.variant = (mk.variant % (mk.max || 4)) + 1;
      mkStatus('🖼 Getting another picture… (a new one takes 1–2 minutes)');
      if (mk.itemId) {
        const d = await post(API, 'week_update', { id: mk.itemId, variant: mk.variant });
        mk.bg = await loadImg(d.item.url); wk.imgs[mk.itemId] = mk.bg; mk.max = mk.max || 4;
        updateWeekItem(d.item);
      } else await loadPicture();
      drawMade(); mkStatus('✓ Picture ' + mk.variant + ' of ' + (mk.max || 4) + '.');
    } catch (e) { mk.variant = keep; mkStatus('⚠️ ' + esc(e.message)); }
    mk.busy = false; mkButtons();
  }

  // ── drawing the finished poster ──
  function lineSet(x, text, font, maxW) { x.font = font; return wrap(x, text, maxW); }
  function drawMade() { drawOn($('dp-mk-canvas'), mk.text, mk.bg); clearReel(); }
  // Story-style poster: series title, hook, lines, highlighted punch line, quote bubble, ending,
  // with the big portrait (placed) or the painted person (in the picture) on the right.
  function rrect(x, X, Y, W, H, R) { x.beginPath(); x.moveTo(X + R, Y); x.arcTo(X + W, Y, X + W, Y + H, R); x.arcTo(X + W, Y + H, X, Y + H, R); x.arcTo(X, Y + H, X, Y, R); x.arcTo(X, Y, X + W, Y, R); x.closePath(); }
  // anim (Reel only): { stage: 0…6 words shown so far, zoom: picture zoom, pin: 0…1 portrait slide-in }
  function drawOn(c, t, bg, sample, anim) {
    if (!c || !t) return;
    const x = c.getContext('2d'), W = c.width, H = c.height, s = st.settings;
    const tall = H > W * 1.5;                // the Reel frame (9:16): keep clear of the phone's top and bottom buttons
    const TOPX = tall ? 150 : 0;
    const ease = (v) => v <= 0 ? 0 : v >= 1 ? 1 : 1 - Math.pow(1 - v, 3);
    const placed = s.style === 'placed';
    const bright = s.look !== 'dark';
    // colours for the two looks
    const P = bright
      ? { base1: '#FFF8EE', base2: '#F3E6D2', shade: '255,250,241', shadeTop: '255,252,246', name: MAROON, series: '#9A7425', hook: MAROON,
          body: '#3A2A20', end: '#1F6B3A', eng: '#5A4A40', from: '#9A7425', shadow: 'rgba(255,255,255,.0)', blur: 0,
          bubble: MAROON, bubbleText: '#FFFFFF', punchBg: '#F6C744', punchText: '#3E0D0D', glow: '255,232,170' }
      : { base1: '#24452F', base2: '#0E2017', shade: '12,28,20', shadeTop: '10,20,15', name: '#F2D27A', series: '#E8C96A', hook: '#FFFFFF',
          body: SANDAL, end: '#F2D27A', eng: '#FFFFFF', from: GOLD, shadow: 'rgba(0,0,0,.85)', blur: 14,
          bubble: '#FBEFE6', bubbleText: MAROON, punchBg: '#F2C94C', punchText: '#3E0D0D', glow: '242,210,122' };
    const en = s.language === 'en', L = en ? 'en' : 'ta';
    const F_HEAD = en ? '"Playfair Display", Georgia, serif' : F_TA, F_BODY = en ? F_EN : F_TA;
    // picture
    x.save();
    x.fillStyle = P.base2; x.fillRect(0, 0, W, H);
    if (bg) {
      const z = anim ? anim.zoom || 1 : 1;
      x.save(); x.translate(W / 2, H / 2); x.scale(z, z); x.translate(-W / 2, -H / 2); cover(x, bg, 0, 0, W, H); x.restore();
    }
    else { const g0 = x.createLinearGradient(0, 0, W, H); g0.addColorStop(0, P.base1); g0.addColorStop(1, P.base2); x.fillStyle = g0; x.fillRect(0, 0, W, H); }
    // shade so the words read clearly
    let g = x.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(' + P.shade + ',' + (bright ? .9 : .8) + ')'); g.addColorStop(0.4, 'rgba(' + P.shade + ',' + (bright ? .72 : .58) + ')'); g.addColorStop(0.62, 'rgba(' + P.shade + ',0)'); g.addColorStop(1, 'rgba(' + P.shade + ',0)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    g = x.createLinearGradient(0, 0, 0, 250);
    g.addColorStop(0, 'rgba(' + P.shadeTop + ',' + (bright ? .9 : .8) + ')'); g.addColorStop(1, 'rgba(' + P.shadeTop + ',0)');
    x.fillStyle = g; x.fillRect(0, 0, W, 230);

    // the person on the right
    const nmTxt = [$('dp-pname') ? $('dp-pname').value.trim() : '', $('dp-prole') ? $('dp-prole').value.trim() : ''].filter(Boolean);
    let tagX = 0, tagY = 0;
    if (placed && st.portrait) {
      const ph = tall ? Math.min(H * 0.6, W * 1.05) : H * 0.66, pw = ph * st.portrait.width / st.portrait.height;
      const slide = anim ? 1 - ease(anim.pin) : 0;
      const px = W - pw * 0.92 + slide * pw * 0.35, py = H - 64 - ph;
      if (anim) x.globalAlpha = ease(anim.pin);
      // soft glow behind the person
      const gl = x.createRadialGradient(px + pw / 2, py + ph * 0.4, 10, px + pw / 2, py + ph * 0.4, pw * 0.7);
      gl.addColorStop(0, 'rgba(' + P.glow + ',' + (bright ? .45 : .30) + ')'); gl.addColorStop(1, 'rgba(' + P.glow + ',0)');
      x.fillStyle = gl; x.fillRect(px - 100, py - 100, pw + 200, ph + 100);
      x.drawImage(st.portrait, px, py, pw, ph);
      x.globalAlpha = 1;
      tagX = px + pw * 0.5; tagY = tall ? H - 340 : H - 64 - 26;   // Reel: above the phone's caption area
    } else if (placed && st.personImg) {
      const r = 150, cx = W - 200, cy = H - 380;
      x.save(); x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.closePath(); x.clip();
      cover(x, st.personImg, cx - r, cy - r, r * 2, r * 2); x.restore();
      x.lineWidth = 10; x.strokeStyle = GOLD; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
      tagX = cx; tagY = cy + r + 60;
    } else if (!placed && sample) {
      x.fillStyle = bright ? 'rgba(107,26,26,.06)' : 'rgba(255,255,255,.07)'; x.fillRect(W * 0.58, 300, W * 0.42, H - 364);
      x.fillStyle = bright ? 'rgba(107,26,26,.7)' : 'rgba(255,255,255,.75)'; x.font = '600 26px ' + F_EN; x.textAlign = 'center';
      x.fillText('AI paints the person here', W * 0.79, H * 0.6); x.textAlign = 'left';
    }
    if (tagX && nmTxt.length) {
      x.font = '700 30px ' + F_EN; const w1 = x.measureText(nmTxt[0]).width;
      x.font = '500 25px ' + F_EN; const w2 = nmTxt[1] ? x.measureText(nmTxt[1]).width : 0;
      const bw = Math.min(W * 0.42, Math.max(w1, w2) + 48), bh = nmTxt[1] ? 82 : 50;
      const bx = Math.min(W - bw - 16, tagX - bw / 2), by = tagY - bh + 10;
      x.fillStyle = 'rgba(62,13,13,.92)'; rrect(x, bx, by, bw, bh, 12); x.fill();
      x.fillStyle = GOLD; x.fillRect(bx + 14, by, bw - 28, 3);
      x.textAlign = 'center'; x.fillStyle = '#fff'; x.font = '700 30px ' + F_EN; x.fillText(nmTxt[0], bx + bw / 2, by + 36, bw - 20);
      if (nmTxt[1]) { x.fillStyle = '#F2D27A'; x.font = '500 25px ' + F_EN; x.fillText(nmTxt[1], bx + bw / 2, by + 68, bw - 20); }
      x.textAlign = 'left';
    }

    // logo + school name
    if (logoImg) { x.save(); x.beginPath(); x.arc(110, 108 + TOPX, 66, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill(); x.clip(); x.drawImage(logoImg, 44, 42 + TOPX, 132, 132); x.restore();
      x.lineWidth = 5; x.strokeStyle = GOLD; x.beginPath(); x.arc(110, 108 + TOPX, 66, 0, Math.PI * 2); x.stroke(); }
    x.textAlign = 'left'; x.fillStyle = P.name;
    const nm = lineSet(x, cfg.school.name || '', '700 44px ' + F_EN, W - 260).slice(0, 2);
    x.shadowColor = P.shadow; x.shadowBlur = P.blur;   // dark look: soft shadow behind the words · bright look: none
    nm.forEach((l, i) => x.fillText(l, 205, (nm.length > 1 ? 92 : 120) + i * 52 + TOPX));

    // the words — plan them, shrinking until they fit
    const series = en ? t.series_en : t.series_ta;
    const title = en ? t.title_en : t.title_ta;
    const body = (en ? t.body_en : t.body_ta) || [];
    const punch = t['punch_' + L] || '', quote = t['quote_' + L] || '', end = t['end_' + L] || '';
    const eng = s.language === 'both' ? t.line_en : '';
    const from = (st.settings.from_line || '').trim();
    const maxW = W * ((placed && (st.portrait || st.personImg)) || !placed ? 0.52 : 0.6), X0 = 64, top = tall ? 300 + TOPX + 40 : 300, bottom = tall ? H - 330 : H - 110;
    let k = 1, plan;
    for (; k >= 0.55; k -= 0.05) {
      plan = []; let y = top, stg = 1;
      let wide = false;   // a single long word wider than the column (e.g. நினைவிருக்கிறதா?) — shrink until it fits
      const add = (it) => {
        it.s = stg; plan.push(it);
        const w = (font, s) => { x.font = font; return x.measureText(s).width; };
        if (it[0] === 'text' && w(it[2], it[3]) > maxW + 4) wide = true;
        if (it[0] === 'punch' && w(it[1], it[2]) + 34 > maxW + 4) wide = true;
        if (it[0] === 'quote' && it[2].some(l => w(it[1], l) + 64 > maxW + 20)) wide = true;
      };
      const R = (n) => Math.round(n * k);
      if (series) { const f = (en ? 'italic 600 ' : '600 ') + R(36) + 'px ' + (en ? F_EN : F_TA);
        lineSet(x, series, f, maxW).slice(0, 2).forEach(l => { add(['text', P.series, f, l, y]); y += R(48); });
        add(['rule', y - R(18)]); y += R(40); }
      const tf = '700 ' + R(en ? 86 : 80) + 'px ' + F_HEAD;
      lineSet(x, title || '', tf, maxW).forEach(l => { add(['text', P.hook, tf, l, y + R(26)]); y += R(100); });
      y += R(14);
      const bf = (en ? '500 ' : '600 ') + R(46) + 'px ' + F_BODY;
      stg = 2; body.forEach(b => { lineSet(x, b, bf, maxW).forEach(l => { add(['text', P.body, bf, l, y]); y += R(62); }); });
      stg = 3;
      if (punch) { y += R(30); const pf = '800 ' + R(54) + 'px ' + F_BODY;
        lineSet(x, punch, pf, maxW - R(40)).forEach(l => { add(['punch', pf, l, y]); y += R(82); }); y += R(6); }
      stg = 4;
      if (quote) { y += R(22); const qf = '700 ' + R(42) + 'px ' + F_BODY;
        const ql = lineSet(x, '“' + quote + '”', qf, maxW - R(70)); add(['quote', qf, ql, y, R(56)]); y += ql.length * R(56) + R(104); }
      stg = 5;
      if (end) { y += R(10); const ef = '700 ' + R(48) + 'px ' + F_BODY;
        lineSet(x, end, ef, maxW).forEach(l => { add(['text', P.end, ef, l, y]); y += R(62); }); }
      stg = 6;
      if (eng) { y += R(14); const ef = 'italic 500 ' + R(34) + 'px ' + F_EN;
        lineSet(x, eng, ef, maxW).forEach(l => { add(['text', P.eng, ef, l, y]); y += R(46); }); }
      if (from) { y += R(18); const ff = '600 ' + R(28) + 'px ' + F_EN;
        lineSet(x, from, ff, maxW).forEach(l => { add(['text', P.from, ff, l, y]); y += R(38); }); }
      if (y <= bottom && !wide) break;
    }
    const drawItem = (p) => {
      if (p[0] === 'rule') {
        x.shadowBlur = 0; x.fillStyle = bright ? '#C9A84C' : GOLD; x.fillRect(X0, p[1], 70, 3);
        x.beginPath(); x.arc(X0 + 86, p[1] + 1.5, 5, 0, Math.PI * 2); x.fill(); x.fillRect(X0 + 102, p[1], 70, 3); x.shadowBlur = P.blur; return;
      }
      if (p[0] === 'punch') {
        // yellow brush highlight behind dark words
        x.font = p[1]; const w = x.measureText(p[2]).width, fs = parseInt(p[1].split(' ')[1], 10);
        x.shadowBlur = 0; x.save(); x.translate(X0 - 14, p[3] - fs * 0.92); x.rotate(-0.012);
        x.fillStyle = P.punchBg; rrect(x, 0, 0, w + 34, fs * 1.32, 8); x.fill();
        x.fillStyle = 'rgba(255,255,255,.25)'; x.fillRect(6, 4, w + 22, fs * 0.18); x.restore();
        x.fillStyle = P.punchText; x.fillText(p[2], X0 + 3, p[3]); x.shadowBlur = P.blur; return;
      }
      if (p[0] === 'quote') {
        // speech bubble with little dots, like a child thinking
        x.font = p[1]; const lh = p[4], lines = p[2];
        const w = Math.max.apply(null, lines.map(l => x.measureText(l).width)) + 64, h = lines.length * lh + 34;
        const bx = X0 - 6, by = p[3] - lh + 2;
        x.shadowColor = 'rgba(0,0,0,.25)'; x.shadowBlur = 12; x.fillStyle = P.bubble; rrect(x, bx, by, w, h, h / 2.4); x.fill();
        x.beginPath(); x.arc(bx + w - 30, by + h + 14, 11, 0, Math.PI * 2); x.fill();
        x.beginPath(); x.arc(bx + w - 8, by + h + 34, 7, 0, Math.PI * 2); x.fill();
        x.shadowBlur = 0; x.shadowColor = P.shadow; x.fillStyle = P.bubbleText;
        lines.forEach((l, i) => x.fillText(l, bx + 32, p[3] + 14 + i * lh));
        x.shadowBlur = P.blur; return;
      }
      x.fillStyle = p[1]; x.font = p[2]; x.fillText(p[3], X0, p[4]);
    };
    plan.forEach(p => {
      if (!anim) return drawItem(p);
      const a = ease(anim.stage - (p.s - 1));
      if (a <= 0) return;
      x.save(); x.globalAlpha = a; x.translate(0, (1 - a) * 30); drawItem(p); x.restore();
    });
    x.shadowBlur = 0;

    // bottom band
    x.fillStyle = MAROON; x.fillRect(0, H - 64, W, 64);
    x.fillStyle = GOLD; x.fillRect(0, H - 68, W, 4);
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.font = '600 28px ' + F_EN;
    x.fillText([cfg.school.name, cfg.school.phone ? '📞 ' + cfg.school.phone : ''].filter(Boolean).join('   ·   '), W / 2, H - 22, W - 60);
    x.textAlign = 'left';
    x.restore();
  }
  // ════════════ Reel: the poster as a phone-size video ════════════
  const reel = { blob: null, url: '', busy: false, seconds: 12 };
  function clearReel() {
    if (reel.busy) return;
    if (reel.url) { try { URL.revokeObjectURL(reel.url); } catch (e) {} }
    reel.blob = null; reel.url = '';
    const b = $('dp-reel-box'); if (b) b.classList.add('hidden');
    const s = $('dp-reel-status'); if (s) s.textContent = '';
  }
  async function makeReel() {
    if (reel.busy || !mk.text || !mk.bg || !window.SD || !SD.frames) return;
    readEdits();
    const m = $('dp-reel-music').value;
    const music = m === 'none' ? null : '../assets/music/' + m + '.mp3';
    const sup = await SD.reelSupport(!!music);
    if (!sup.ok) { $('dp-reel-status').textContent = '⚠️ ' + sup.reason; return; }
    clearReel(); reel.busy = true; mkButtons();
    const tall = document.createElement('canvas'); tall.width = 1080; tall.height = 1920;
    const T = 12, starts = [0.4, 1.7, 3.0, 4.3, 5.6, 6.7];   // hook, lines, punch, quote, ending, English line
    const stageAt = (t) => starts.reduce((s, st0) => s + Math.min(1, Math.max(0, (t - st0) / 0.8)), 0);
    const text = mk.text, bg = mk.bg;
    try {
      const blob = await SD.frames(T, (x, t) => {
        drawOn(tall, text, bg, false, { stage: stageAt(t), zoom: 1 + 0.08 * t / T, pin: t / 0.9 });
        x.drawImage(tall, 0, 0, SD.REEL_W, SD.REEL_H);
      }, { music, onProgress: (pc, msg) => { $('dp-reel-status').textContent = '🎬 ' + msg; } });
      reel.blob = blob; reel.url = URL.createObjectURL(blob); reel.seconds = T;
      $('dp-reel-video').src = reel.url;
      $('dp-reel-box').classList.remove('hidden');
      $('dp-reel-status').textContent = '✓ Reel ready (' + T + ' seconds, ' + (Math.round(blob.size / 104857.6) / 10) + ' MB). Play it to check.';
    } catch (e) { $('dp-reel-status').textContent = '⚠️ ' + e.message; }
    reel.busy = false; mkButtons();
  }
  async function addReel() {
    if (reel.busy || !reel.blob || !mk.text) return;
    reel.busy = true; mkButtons();
    try {
      if (typeof showLoading === 'function') showLoading('Uploading the Reel (' + (Math.round(reel.blob.size / 104857.6) / 10) + ' MB)…');
      const u = await post('/api/social-posts', 'video_url');
      const r = await fetch(u.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'x-upsert': 'true' }, body: reel.blob });
      if (!r.ok) throw new Error('Could not upload the Reel (' + r.status + ').');
      if (typeof showLoading === 'function') showLoading('Adding to Ready to Post…');
      const t = mk.text;
      await post(API, 'post', { data_url: toJpeg($('dp-mk-canvas')), title: t.title, caption_en: t.caption_en, caption_ta: t.caption_ta,
        hashtags: t.hashtags, video: u.public_url, video_seconds: reel.seconds });
      if (mk.itemId) { try { const d = await post(API, 'week_update', { id: mk.itemId, text: t, status: 'added' }); updateWeekItem(d.item); } catch (e) {} }
      if (typeof hideLoading === 'function') hideLoading();
      toast('✓ Reel added to "Ready to Post".');
      reel.busy = false;
      if (typeof loadPosts === 'function') await loadPosts();
      if (typeof switchTab === 'function') switchTab('ready');
    } catch (e) {
      if (typeof hideLoading === 'function') hideLoading();
      toast('⚠️ ' + e.message, 'error');
    }
    reel.busy = false; mkButtons();
  }

  function toJpeg(c) {
    for (let q = 0.9; q >= 0.5; q -= 0.1) { const u = c.toDataURL('image/jpeg', q); if (u.length * 0.75 < 850 * 1024) return u; }
    return c.toDataURL('image/jpeg', 0.5);
  }
  function fileName() { return 'daily-poster-' + (mk.theme || 'post') + '-' + new Date().toISOString().slice(0, 10) + '.jpg'; }
  function download() {
    const a = document.createElement('a'); a.href = toJpeg($('dp-mk-canvas')); a.download = fileName(); a.click();
  }
  async function addToReady() {
    if (mk.busy || !mk.text || !mk.bg) return;
    readEdits(); drawMade();
    mk.busy = true; mkButtons();
    try {
      if (typeof showLoading === 'function') showLoading('Adding to Ready to Post…');
      const t = mk.text;
      await post(API, 'post', { data_url: toJpeg($('dp-mk-canvas')), title: t.title, caption_en: t.caption_en, caption_ta: t.caption_ta, hashtags: t.hashtags });
      if (mk.itemId) { try { const d = await post(API, 'week_update', { id: mk.itemId, text: t, status: 'added' }); updateWeekItem(d.item); } catch (e) {} }
      if (typeof hideLoading === 'function') hideLoading();
      toast('✓ Added to "Ready to Post".');
      if (typeof loadPosts === 'function') await loadPosts();
      if (typeof switchTab === 'function') switchTab('ready');
    } catch (e) {
      if (typeof hideLoading === 'function') hideLoading();
      toast('⚠️ ' + e.message, 'error');
    }
    mk.busy = false; mkButtons();
  }

  // ════════════ Step 3: this week's posters ════════════
  function weekHtml() {
    return '<div class="card" style="margin-bottom:16px">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">'
      +   '<div class="card-title">📅 This week\'s posters</div>'
      +   '<button class="btn btn-secondary btn-sm hidden" id="dp-wk-again">🔄 Make a fresh set</button></div>'
      + '<div class="help" id="dp-wk-status" style="margin-top:6px">Loading…</div>'
      + '<div id="dp-wk-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;margin-top:12px"></div>'
      + '</div>';
  }
  function badge(s) {
    return s === 'added' ? '<span style="color:#1E7B34;font-weight:700">✓ Added to Ready to Post</span>'
      : s === 'skipped' ? '<span style="color:#888;font-weight:700">Skipped</span>'
      : '<span style="color:' + MAROON + ';font-weight:700">Waiting for you</span>';
  }
  function tile(it, i) {
    const done = it.status !== 'ready';
    return '<div style="border:1px solid var(--border);border-radius:12px;padding:10px;background:#FDF8F0' + (it.status === 'skipped' ? ';opacity:.6' : '') + '">'
      + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px"><b>' + (i + 1) + '. ' + esc(it.theme_name) + '</b>' + badge(it.status) + '</div>'
      + '<canvas id="dp-wk-c-' + it.id + '" width="1080" height="1350" style="width:100%;border-radius:8px;background:' + MAROON_DARK + '"></canvas>'
      + (it.error ? '<div class="help" style="color:#B3261E;margin-top:4px">Picture not ready: ' + esc(it.error) + ' Press ✏️ Check & edit, then 🖼 Another picture.</div>' : '')
      + '<div class="actions" style="margin-top:8px;flex-wrap:wrap;gap:6px">'
      +   (done ? '' : '<button class="btn btn-primary btn-sm" data-wk="add" data-id="' + it.id + '"' + (it.url ? '' : ' disabled') + '>✅ Add</button>')
      +   '<button class="btn btn-secondary btn-sm" data-wk="edit" data-id="' + it.id + '">✏️ Check & edit</button>'
      +   '<button class="btn btn-secondary btn-sm" data-wk="dl" data-id="' + it.id + '"' + (it.url ? '' : ' disabled') + '>⬇</button>'
      +   (it.status === 'ready' ? '<button class="btn btn-secondary btn-sm" data-wk="skip" data-id="' + it.id + '">Skip</button>'
        : it.status === 'skipped' ? '<button class="btn btn-secondary btn-sm" data-wk="undo" data-id="' + it.id + '">Bring back</button>' : '')
      + '</div></div>';
  }
  function wkStatus(t) { const s = $('dp-wk-status'); if (s) s.innerHTML = t; }
  async function loadWeek() {
    try { const d = await post(API, 'week_get'); wk.week = d.week; } catch (e) { wkStatus('⚠️ ' + esc(e.message)); return; }
    renderWeek();
  }
  function renderWeek() {
    const list = $('dp-wk-list'); if (!list) return;
    const w = wk.week;
    $('dp-wk-again').classList.toggle('hidden', !w);
    if (!w || !(w.items || []).length) {
      list.innerHTML = '';
      wkStatus('This week\'s posters are not made yet. '
        + (st.settings.enabled ? 'They will be made every Monday morning. ' : 'Tick "Make 3 posters for us every Monday" in Setup to get them every week. ')
        + '<br><button class="btn btn-primary btn-sm" id="dp-wk-make" style="margin-top:8px">✨ Make this week\'s 3 posters now</button>');
      $('dp-wk-make').onclick = () => prepareWeek(false);
      return;
    }
    const left = w.items.filter(i => i.status === 'ready').length;
    wkStatus('Made on ' + new Date(w.made_at).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' }) + '. '
      + (left ? left + ' waiting for you. Read the Tamil once, then press ✅ Add — or ✏️ Check & edit to change the words or picture.' : 'All done for this week. 🎉'));
    list.innerHTML = w.items.map(tile).join('');
    list.onclick = onTile;
    w.items.forEach(drawTile);
  }
  async function drawTile(it) {
    let img = wk.imgs[it.id];
    if (!img && it.url) { try { img = await loadImg(it.url); wk.imgs[it.id] = img; } catch (e) { img = null; } }
    drawOn($('dp-wk-c-' + it.id), it.text, img);
  }
  function updateWeekItem(item) {
    if (!wk.week) return;
    const i = wk.week.items.findIndex(x => x.id === item.id);
    if (i !== -1) { wk.week.items[i] = item; renderWeek(); }
  }
  async function prepareWeek(again) {
    if (wk.busy) return;
    if (again && !window.confirm('Make 3 new posters for this week? The current ones will be replaced (ones already added to Ready to Post stay there).')) return;
    if (st.settings.style === 'painted' && !st.person) { toast('⚠️ Please save the correspondent / principal photo in Setup first.', 'error'); return; }
    wk.busy = true;
    if ($('dp-wk-make')) $('dp-wk-make').disabled = true;
    $('dp-wk-again').disabled = true;
    wkStatus('✍️ AI is writing 3 messages and getting the pictures… this can take 2–3 minutes the first time. Please keep this page open.');
    try {
      const d = await post(API, 'week_prepare', { again: !!again });
      wk.week = d.week; wk.imgs = {};
      renderWeek();
    } catch (e) { wkStatus('⚠️ ' + esc(e.message)); if ($('dp-wk-make')) $('dp-wk-make').disabled = false; }
    $('dp-wk-again').disabled = false;
    wk.busy = false;
  }
  function itemOf(id) { return wk.week && wk.week.items.find(x => x.id === id); }
  async function onTile(e) {
    const b = e.target.closest('button[data-wk]'); if (!b || wk.busy) return;
    const it = itemOf(b.dataset.id); if (!it) return;
    const act = b.dataset.wk;
    if (act === 'edit') return editItem(it);
    if (act === 'dl') {
      const a = document.createElement('a'); a.href = toJpeg($('dp-wk-c-' + it.id));
      a.download = 'daily-poster-' + it.theme + '-' + new Date().toISOString().slice(0, 10) + '.jpg'; a.click(); return;
    }
    if (act === 'skip' || act === 'undo') {
      try { const d = await post(API, 'week_update', { id: it.id, status: act === 'skip' ? 'skipped' : 'ready' }); updateWeekItem(d.item); }
      catch (err) { toast('⚠️ ' + err.message, 'error'); }
      return;
    }
    if (act === 'add') {
      wk.busy = true; b.disabled = true;
      try {
        if (typeof showLoading === 'function') showLoading('Adding to Ready to Post…');
        const t = it.text;
        await post(API, 'post', { data_url: toJpeg($('dp-wk-c-' + it.id)), title: t.title, caption_en: t.caption_en, caption_ta: t.caption_ta, hashtags: t.hashtags });
        const d = await post(API, 'week_update', { id: it.id, status: 'added' });
        updateWeekItem(d.item);
        if (typeof loadPosts === 'function') await loadPosts();
        toast('✓ Added to "Ready to Post".');
      } catch (err) { toast('⚠️ ' + err.message, 'error'); b.disabled = false; }
      if (typeof hideLoading === 'function') hideLoading();
      wk.busy = false;
    }
  }
  function editingItem(id) {
    mk.itemId = id || '';
    const s = $('dp-mk-save'); if (s) s.classList.toggle('hidden', !mk.itemId);
  }
  function editItem(it) {
    mk.text = JSON.parse(JSON.stringify(it.text)); mk.theme = it.theme; mk.variant = it.variant || 1;
    mk.bg = wk.imgs[it.id] || null; mk.max = 4;
    editingItem(it.id);
    if ($('dp-mk-theme')) $('dp-mk-theme').value = it.theme;
    fillEdits(); drawMade(); mkButtons();
    mkStatus('✏️ Editing this week\'s poster: <b>' + esc(it.theme_name) + '</b>. Change the words or picture, then press 💾 Save changes or ✅ Add to Ready to Post.');
    $('dp-mk-canvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function saveItem(tell) {
    if (!mk.itemId || !mk.text) return;
    readEdits();
    try {
      const d = await post(API, 'week_update', { id: mk.itemId, text: mk.text });
      updateWeekItem(d.item);
      if (tell) toast('✓ Saved.');
    } catch (e) { toast('⚠️ ' + e.message, 'error'); }
  }

  window.DP = {
    init(o) {
      cfg = Object.assign(cfg, o || {}); cfg.school = Object.assign({ name: '' }, (o && o.school) || {}); logoImg = null;
      if (location.hash === '#daily') setTimeout(() => {
        const t = document.querySelector('.tab[data-tab="daily"]');
        if (t && !t.classList.contains('hidden') && typeof switchTab === 'function') switchTab('daily');
      }, 0);
    },
    async open() {
      if (!built) {
        // Step 5: a paid add-on — if it is not switched on for this school, show a friendly note instead
        try { const d = await post(API, 'settings_get'); st.settings = d.settings; }
        catch (e) {
          const box = $('tab-daily');
          if (box) box.innerHTML = '<div class="card"><div class="card-title">🗓 Daily Posters</div>'
            + '<div class="help" style="margin-top:6px">Every Monday, 3 ready posters for your school page — teachers\' love, school memories, parenting tips, exam tips, values and admission messages — '
            + 'with your correspondent / principal, school logo and name, in Tamil and English. You check them and share with one tap.</div>'
            + '<div class="help" style="margin-top:10px;font-weight:600;color:' + MAROON + '">' + esc(e.message) + '</div></div>';
          return;
        }
        build();
        await loadPerson();
        await loadPortrait();
        styleNote();
        await redraw();
        loadWeek();
        if (!document.getElementById('fw-fonts')) {   // same Tamil font link as Festival Wishes
          const l = document.createElement('link');
          l.id = 'fw-fonts'; l.rel = 'stylesheet';
          l.href = 'https://fonts.googleapis.com/css2?family=Noto+Serif+Tamil:wght@600;700&family=Playfair+Display:wght@700&display=swap';
          document.head.appendChild(l);
        }
        try { await document.fonts.load('700 64px "Noto Serif Tamil"', 'தமிழ்'); } catch (e) {}
      }
      redraw();
    }
  };
})();
