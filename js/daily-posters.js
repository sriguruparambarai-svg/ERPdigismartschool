// DigiSmart ERP — Daily Posters (a tab inside Social Media Posts)
// Step 1: the school's setup — the correspondent / principal photo (shared with Festival Wishes),
// how they appear in the posters, the poster language, and the on/off switch.
// Later steps add: the poster maker, "This week's posters" and the Monday auto-prepare.
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
      + '<b>Step 1 is this setup.</b> The weekly posters will appear here once the next steps are ready.</div>'
      + '</div>'
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
      + '</div></div>';

    $('dp-on').checked = !!s.enabled;
    $('dp-from').value = s.from_line || '';
    box.addEventListener('change', onChange);
    box.addEventListener('input', (e) => { if (/^dp-(pname|prole|from)$/.test(e.target.id)) redraw(); });
    $('dp-psave').onclick = savePerson;
    $('dp-pdel').onclick = removePerson;
    $('dp-save').onclick = saveSettings;
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
