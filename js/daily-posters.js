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
    settings: { enabled: false, style: 'placed', language: 'both', gender: 'sir', per_week: 3, from_line: '' },
    person: null, personImg: null, personNew: ''
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
      +     '<div class="help" id="dp-style-note" style="width:100%;margin-top:6px"></div></div>'

      +   '<div class="lbl" style="margin-top:16px">3. Poster language</div>'
      +   '<div class="style-row">'
      +     chip('language', 'both', 'தமிழ் + one English line', s.language === 'both')
      +     chip('language', 'ta', 'தமிழ் only', s.language === 'ta')
      +     chip('language', 'en', 'English only', s.language === 'en') + '</div>'

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
    $('dp-wk-again').onclick = () => prepareWeek(true);
    wireMaker(box);
    styleNote();
  }

  function styleNote() {
    const n = $('dp-style-note'); if (!n) return;
    n.innerHTML = st.settings.style === 'painted'
      ? 'Looks natural, like the agency posters. <b>Costs more</b> — a fresh AI picture is made for your school for every poster.'
      : 'Their real photo is placed neatly on a ready background. <b>Much cheaper</b>, looks a little less natural.';
  }

  async function onChange(e) {
    const t = e.target;
    if (t.name === 'dp-gender' || t.name === 'dp-style' || t.name === 'dp-language') {
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
      st.person = d.person; st.personNew = '';
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
  async function redraw() {
    const c = $('dp-canvas'); if (!c) return;
    const x = c.getContext('2d'), W = c.width, H = c.height, s = st.settings;
    // background
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1F3B2C'); g.addColorStop(1, '#0F2219');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    // logo + school name
    if (cfg.logoUrl && !logoImg) { try { logoImg = await loadImg(cfg.logoUrl); } catch (e) { logoImg = null; } }
    if (logoImg) { x.save(); x.beginPath(); x.arc(110, 110, 70, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill(); x.clip(); x.drawImage(logoImg, 40, 40, 140, 140); x.restore(); }
    x.fillStyle = GOLD; x.font = '700 46px ' + F_EN; x.textAlign = 'left';
    const nm = wrap(x, cfg.school.name || 'Your School Name', W - 260);
    nm.slice(0, 2).forEach((l, i) => x.fillText(l, 210, 100 + i * 54));
    // person
    const img = st.personImg;
    if (s.style === 'painted') {
      x.save(); x.beginPath(); x.rect(W * 0.45, 330, W * 0.55, H - 330); x.clip();
      if (img) { x.globalAlpha = 0.9; cover(x, img, W * 0.45, 330, W * 0.55, H - 330); x.globalAlpha = 1; }
      else { x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(W * 0.45, 330, W * 0.55, H - 330); }
      const fade = x.createLinearGradient(W * 0.45, 0, W * 0.62, 0);
      fade.addColorStop(0, '#1A3326'); fade.addColorStop(1, 'rgba(26,51,38,0)');
      x.fillStyle = fade; x.fillRect(W * 0.45, 330, W * 0.2, H - 330);
      x.restore();
      x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(W * 0.5, H - 110, W * 0.46, 56);
      x.fillStyle = '#fff'; x.font = '600 26px ' + F_EN; x.textAlign = 'center';
      x.fillText('AI will paint them into the scene', W * 0.73, H - 73);
    } else {
      const r = 170, cx = W - 230, cy = H - 330;
      x.save(); x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.closePath();
      x.fillStyle = 'rgba(255,255,255,.12)'; x.fill(); x.clip();
      if (img) cover(x, img, cx - r, cy - r, r * 2, r * 2);
      x.restore();
      x.lineWidth = 10; x.strokeStyle = GOLD; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
      const nmTxt = [$('dp-pname') && $('dp-pname').value.trim(), $('dp-prole') && $('dp-prole').value.trim()].filter(Boolean).join(', ');
      if (nmTxt) { x.fillStyle = SANDAL; x.font = '600 30px ' + F_EN; x.textAlign = 'center'; x.fillText(nmTxt, cx, cy + r + 50); }
    }
    // message
    x.textAlign = 'left';
    let y = 420; const maxW = W * 0.5;
    if (s.language !== 'en') {
      x.fillStyle = '#F2D27A'; x.font = '700 64px ' + F_TA;
      wrap(x, SAMPLE.ta, maxW).forEach(l => { x.fillText(l, 60, y); y += 84; });
      y += 20;
    }
    if (s.language !== 'ta') {
      x.fillStyle = SANDAL; x.font = (s.language === 'en' ? '700 56px ' : '500 38px ') + F_EN;
      wrap(x, SAMPLE.en, maxW).forEach(l => { x.fillText(l, 60, y); y += (s.language === 'en' ? 72 : 52); });
    }
    const from = $('dp-from') ? $('dp-from').value.trim() : '';
    if (from) { x.fillStyle = GOLD; x.font = 'italic 500 32px ' + F_EN; wrap(x, from, maxW).forEach(l => { y += 20; x.fillText(l, 60, y + 20); y += 30; }); }
    // bottom band
    x.fillStyle = MAROON; x.fillRect(0, H - 40, W, 40);
    const note = $('dp-note');
    if (note) note.textContent = 'This is a sample only, to show your choices. Real posters will have a full picture and a new message each time.'
      + (img ? '' : ' Add the photo to see it here.');
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
      +     '<div class="lbl" id="dp-mk-title-lbl">Heading</div><input id="dp-mk-title" class="form-control" maxlength="80">'
      +     '<div class="lbl" id="dp-mk-body-lbl">Lines (one per line)</div><textarea id="dp-mk-body" class="form-control" rows="4"></textarea>'
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
      + '</div></div>';
  }
  function wireMaker(box) {
    $('dp-mk-go').onclick = () => makePoster();
    $('dp-mk-text').onclick = () => newText();
    $('dp-mk-pic').onclick = () => newPicture();
    $('dp-mk-add').onclick = () => addToReady();
    $('dp-mk-dl').onclick = () => download();
    $('dp-mk-save').onclick = () => saveItem(true);
    box.addEventListener('input', (e) => { if (/^dp-mk-(title|body|en)$/.test(e.target.id)) { readEdits(); drawMade(); } });
  }
  function mkStatus(t) { const s = $('dp-mk-status'); if (s) s.innerHTML = t; }
  function mkButtons() {
    ['dp-mk-go', 'dp-mk-text', 'dp-mk-pic', 'dp-mk-save'].forEach(id => { if ($(id)) $(id).disabled = mk.busy; });
    const ready = !mk.busy && mk.text && mk.bg;
    ['dp-mk-add', 'dp-mk-dl'].forEach(id => { if ($(id)) $(id).disabled = !ready; });
  }
  function rememberedVariant(theme) { try { return parseInt(localStorage.getItem('dp_v_' + st.settings.style + '_' + theme), 10) || 1; } catch (e) { return 1; } }
  function rememberVariant(theme, v) { try { localStorage.setItem('dp_v_' + st.settings.style + '_' + theme, String(v)); } catch (e) {} }

  // The words shown in the edit boxes, by language
  function fillEdits() {
    const t = mk.text, en = st.settings.language === 'en';
    $('dp-mk-edit').classList.remove('hidden');
    $('dp-mk-title-lbl').textContent = en ? 'Heading' : 'Tamil heading';
    $('dp-mk-body-lbl').textContent = (en ? 'Lines' : 'Tamil lines') + ' (one per line)';
    $('dp-mk-title').value = en ? (t.title_en || '') : (t.title_ta || '');
    $('dp-mk-body').value = ((en ? t.body_en : t.body_ta) || []).join('\n');
    $('dp-mk-en-row').style.display = st.settings.language === 'both' ? '' : 'none';
    $('dp-mk-en').value = t.line_en || '';
  }
  function readEdits() {
    const t = mk.text; if (!t) return;
    const lines = $('dp-mk-body').value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 5);
    if (st.settings.language === 'en') { t.title_en = $('dp-mk-title').value.trim(); t.body_en = lines; }
    else { t.title_ta = $('dp-mk-title').value.trim(); t.body_ta = lines; t.line_en = $('dp-mk-en').value.trim(); }
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
  function drawMade() { drawOn($('dp-mk-canvas'), mk.text, mk.bg); }
  function drawOn(c, t, bg) {
    if (!c || !t) return;
    const x = c.getContext('2d'), W = c.width, H = c.height, s = st.settings;
    const placed = s.style === 'placed';
    // picture
    x.fillStyle = '#16301F'; x.fillRect(0, 0, W, H);
    if (bg) cover(x, bg, 0, 0, W, H);
    // shade the left side and the top so the words read clearly
    let g = x.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(12,28,20,.90)'); g.addColorStop(0.48, 'rgba(12,28,20,.72)'); g.addColorStop(0.72, 'rgba(12,28,20,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    g = x.createLinearGradient(0, 0, 0, 260);
    g.addColorStop(0, 'rgba(10,20,15,.85)'); g.addColorStop(1, 'rgba(10,20,15,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, 260);
    // logo + school name
    if (logoImg) { x.save(); x.beginPath(); x.arc(110, 108, 66, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill(); x.clip(); x.drawImage(logoImg, 44, 42, 132, 132); x.restore();
      x.lineWidth = 5; x.strokeStyle = GOLD; x.beginPath(); x.arc(110, 108, 66, 0, Math.PI * 2); x.stroke(); }
    x.textAlign = 'left'; x.fillStyle = '#F2D27A';
    const nm = lineSet(x, cfg.school.name || '', '700 44px ' + F_EN, W - 260).slice(0, 2);
    x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = 8;
    nm.forEach((l, i) => x.fillText(l, 205, (nm.length > 1 ? 92 : 120) + i * 52));
    // the words — shrink until they fit
    const en = s.language === 'en';
    const title = en ? t.title_en : t.title_ta;
    const body = (en ? t.body_en : t.body_ta) || [];
    const eng = s.language === 'both' ? t.line_en : '';
    const from = (st.settings.from_line || '').trim();
    const maxW = W * 0.52, top = 330, bottom = H - 150;
    let k = 1, plan;
    for (; k >= 0.6; k -= 0.05) {
      plan = []; let y = top;
      const tf = en ? '700 ' + Math.round(70 * k) + 'px "Playfair Display", Georgia, serif' : '700 ' + Math.round(68 * k) + 'px ' + F_TA;
      lineSet(x, title || '', tf, maxW).forEach(l => { plan.push(['#F2D27A', tf, l, y]); y += Math.round(86 * k); });
      y += Math.round(10 * k); plan.push(['rule', '', '', y]); y += Math.round(44 * k);
      const bf = (en ? '500 ' + Math.round(40 * k) + 'px ' + F_EN : '600 ' + Math.round(40 * k) + 'px ' + F_TA);
      body.forEach(b => { lineSet(x, b, bf, maxW).forEach(l => { plan.push([SANDAL, bf, l, y]); y += Math.round(58 * k); }); y += Math.round(10 * k); });
      if (eng) { y += Math.round(14 * k); const ef = 'italic 500 ' + Math.round(34 * k) + 'px ' + F_EN;
        lineSet(x, eng, ef, maxW).forEach(l => { plan.push(['#FFFFFF', ef, l, y]); y += Math.round(46 * k); }); }
      if (from) { y += Math.round(22 * k); const ff = '600 ' + Math.round(30 * k) + 'px ' + F_EN;
        lineSet(x, from, ff, maxW).forEach(l => { plan.push([GOLD, ff, l, y]); y += Math.round(40 * k); }); }
      if (y <= bottom) break;
    }
    plan.forEach(p => {
      if (p[0] === 'rule') { x.shadowBlur = 0; x.fillStyle = GOLD; x.fillRect(64, p[3] - 4, 160, 5); x.shadowBlur = 8; return; }
      x.fillStyle = p[0]; x.font = p[1]; x.fillText(p[2], 64, p[3]);
    });
    x.shadowBlur = 0;
    // the person's own photo (placed style)
    if (placed && st.personImg) {
      const r = 160, cx = W - 215, cy = H - 360;
      x.save(); x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.closePath(); x.clip();
      cover(x, st.personImg, cx - r, cy - r, r * 2, r * 2); x.restore();
      x.lineWidth = 10; x.strokeStyle = GOLD; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
      const nmTxt = [$('dp-pname').value.trim(), $('dp-prole').value.trim()].filter(Boolean);
      if (nmTxt.length) {
        x.textAlign = 'center';
        x.fillStyle = 'rgba(62,13,13,.88)'; x.fillRect(cx - 200, cy + r + 14, 400, nmTxt.length > 1 ? 86 : 52);
        x.fillStyle = '#fff'; x.font = '700 30px ' + F_EN; x.fillText(nmTxt[0], cx, cy + r + 50, 380);
        if (nmTxt[1]) { x.fillStyle = '#F2D27A'; x.font = '500 26px ' + F_EN; x.fillText(nmTxt[1], cx, cy + r + 86, 380); }
        x.textAlign = 'left';
      }
    }
    // bottom band
    x.fillStyle = MAROON; x.fillRect(0, H - 64, W, 64);
    x.fillStyle = GOLD; x.fillRect(0, H - 68, W, 4);
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.font = '600 28px ' + F_EN;
    x.fillText([cfg.school.name, cfg.school.phone ? '📞 ' + cfg.school.phone : ''].filter(Boolean).join('   ·   '), W / 2, H - 22, W - 60);
    x.textAlign = 'left';
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
        await loadSettings();
        build();
        await loadPerson();
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
