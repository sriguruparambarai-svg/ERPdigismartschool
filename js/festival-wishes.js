// DigiSmart ERP — Festival Wishes (a tab inside Social Media Posts)
// Makes a festival greeting poster in the browser (no server cost):
//   festival picture (AI-made and shared by all schools, or the school's own picture)
//   + school logo + school name + wishes in Tamil and English
//   + optional correspondent / principal photo with name.
// Sizes: Post (1080×1350, Instagram/Facebook) and WhatsApp Status (1080×1920).
// Server door: /api/festival-wishes (AI picture, saved correspondent photo, add to Ready to Post).
//
// Used by pages/social-posts.html:
//   FW.init({ logoUrl, school })   after the page's "info" call
//   FW.open()                      when the 🪔 Festival Wishes tab is opened
//   FW.drawPoster(canvas, state)   the drawing itself (also usable on its own)

(function () {
  const API = '/api/festival-wishes';
  const MAROON = '#6B1A1A', MAROON_DARK = '#3E0D0D', GOLD = '#C9A84C', GOLD_LIGHT = '#E8C96A', SANDAL = '#F5E6C8';
  const F_EN = '"Poppins", "Segoe UI", "Noto Sans", Arial, sans-serif';
  const F_HEAD = '"Playfair Display", Georgia, "Times New Roman", serif';
  const F_TA = '"Noto Serif Tamil", "Noto Sans Tamil", "Latha", "Vijaya", serif';

  // key · picture (art) · Tamil wish · English wish · short message
  const FESTIVALS = [
    { key: 'ayudha', art: 'saraswathi', name: 'Ayudha Pooja & Vijayadasami', ta: 'ஆயுத பூஜை & விஜயதசமி நல்வாழ்த்துக்கள்', en: 'Happy Ayudha Pooja & Vijayadasami', msg: 'May Goddess Saraswathi bless every child with wisdom, knowledge and success.' },
    { key: 'saraswathi', art: 'saraswathi', name: 'Saraswathi Pooja', ta: 'சரஸ்வதி பூஜை நல்வாழ்த்துக்கள்', en: 'Happy Saraswathi Pooja', msg: 'May Goddess Saraswathi bless every child with wisdom, knowledge and success.' },
    { key: 'vijayadasami', art: 'vijayadasami', name: 'Vijayadasami', ta: 'விஜயதசமி நல்வாழ்த்துக்கள்', en: 'Happy Vijayadasami', msg: 'May this auspicious day give every child a bright beginning in learning.' },
    { key: 'deepavali', art: 'deepavali', name: 'Deepavali', ta: 'இனிய தீபாவளி நல்வாழ்த்துக்கள்', en: 'Happy Deepavali', msg: 'May the festival of lights fill your home with joy, peace and prosperity.' },
    { key: 'childrens', art: 'childrens', name: "Children's Day", ta: 'குழந்தைகள் தின நல்வாழ்த்துக்கள்', en: "Happy Children's Day", msg: 'Every child is a star. Keep shining!' },
    { key: 'karthigai', art: 'karthigai', name: 'Karthigai Deepam', ta: 'திருக்கார்த்திகை தீப நல்வாழ்த்துக்கள்', en: 'Happy Karthigai Deepam', msg: 'May the light of the lamps brighten every home.' },
    { key: 'christmas', art: 'christmas', name: 'Christmas', ta: 'கிறிஸ்துமஸ் நல்வாழ்த்துக்கள்', en: 'Merry Christmas', msg: 'Wishing you joy, peace and love this Christmas.' },
    { key: 'new_year', art: 'new_year', name: 'New Year', ta: 'இனிய புத்தாண்டு நல்வாழ்த்துக்கள்', en: 'Happy New Year', msg: 'Wishing every family a happy, healthy and successful new year.' },
    { key: 'pongal', art: 'pongal', name: 'Pongal', ta: 'இனிய பொங்கல் நல்வாழ்த்துக்கள்', en: 'Happy Pongal', msg: 'May this harvest festival bring sweetness and prosperity to every home.' },
    { key: 'republic', art: 'republic', name: 'Republic Day', ta: 'குடியரசு தின நல்வாழ்த்துக்கள்', en: 'Happy Republic Day', msg: 'Proud to be Indian. Jai Hind!' },
    { key: 'tamil_new_year', art: 'tamil_new_year', name: 'Tamil New Year', ta: 'இனிய தமிழ்ப் புத்தாண்டு நல்வாழ்த்துக்கள்', en: 'Happy Tamil New Year', msg: 'May the new year bring happiness and success to every family.' },
    { key: 'ramzan', art: 'ramzan', name: 'Ramzan', ta: 'ரம்ஜான் நல்வாழ்த்துக்கள்', en: 'Eid Mubarak', msg: 'Wishing everyone peace, happiness and blessings.' },
    { key: 'bakrid', art: 'bakrid', name: 'Bakrid', ta: 'பக்ரீத் நல்வாழ்த்துக்கள்', en: 'Happy Bakrid', msg: 'Wishing everyone peace, happiness and blessings.' },
    { key: 'independence', art: 'independence', name: 'Independence Day', ta: 'சுதந்திர தின நல்வாழ்த்துக்கள்', en: 'Happy Independence Day', msg: 'Proud to be Indian. Jai Hind!' },
    { key: 'krishna', art: 'krishna', name: 'Krishna Jayanthi', ta: 'கிருஷ்ண ஜெயந்தி நல்வாழ்த்துக்கள்', en: 'Happy Krishna Jayanthi', msg: 'May Little Krishna fill every home with joy.' },
    { key: 'teachers', art: 'teachers', name: "Teachers' Day", ta: 'ஆசிரியர் தின நல்வாழ்த்துக்கள்', en: "Happy Teachers' Day", msg: "Thank you, dear teachers, for shaping our children's future." },
    { key: 'vinayagar', art: 'vinayagar', name: 'Vinayagar Chathurthi', ta: 'விநாயகர் சதுர்த்தி நல்வாழ்த்துக்கள்', en: 'Happy Vinayagar Chathurthi', msg: 'May Lord Vinayagar remove all obstacles and bless every child.' },
    { key: 'other', art: 'general', name: 'Other (type your own wishes)', ta: '', en: '', msg: '' }
  ];
  // A starting guess from today's date — festival dates move every year, so the school can always change it
  function guessFestival(d) {
    const m = d.getMonth() + 1, day = d.getDate(), n = m * 100 + day;
    const ranges = [[101, 105, 'new_year'], [106, 120, 'pongal'], [121, 131, 'republic'], [401, 420, 'tamil_new_year'],
      [801, 815, 'independence'], [816, 831, 'krishna'], [901, 905, 'teachers'], [906, 925, 'vinayagar'],
      [926, 1025, 'ayudha'], [1026, 1112, 'deepavali'], [1113, 1116, 'childrens'], [1117, 1210, 'karthigai'],
      [1211, 1229, 'christmas'], [1230, 1231, 'new_year']];
    for (const r of ranges) if (n >= r[0] && n <= r[1]) return r[2];
    return 'ayudha';
  }
  function festOf(key) { return FESTIVALS.find(f => f.key === key) || FESTIVALS[0]; }

  let cfg = { logoUrl: '', school: { name: '', city: '', phone: '' } };
  let logoImg = null, built = false, busy = false, drawTimer = null, fontsLoaded = false;
  const artCache = {};
  const st = {
    fest: 'ayudha', design: 'ai', pose: 'auto', pic: 'ai', variant: 1, art: null, own: null,
    withPerson: false, person: null, personImg: null, personNew: '',
    size: 'post', ta: '', en: '', msg: '', from: 'Correspondent, Principal, Staff & Students', phone: true
  };

  // ── small helpers ──
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'success'); else alert(m); }
  function token() { return sessionStorage.getItem('digismart_session_token') || ''; }
  function who() { return (typeof STAFF_NAME !== 'undefined' && STAFF_NAME) ? STAFF_NAME : 'Office'; }
  async function call(action, extra) {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action, token: token(), by: who() }, extra || {})) });
    let d; try { d = await r.json(); } catch (e) { throw new Error('The server sent back something unreadable (' + r.status + '). If this is new, check that api/festival-wishes.js was uploaded.'); }
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
  function addFonts() {
    if (document.getElementById('fw-fonts')) return;
    const l = document.createElement('link');
    l.id = 'fw-fonts'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Noto+Serif+Tamil:wght@600;700&family=Playfair+Display:wght@700&display=swap';
    document.head.appendChild(l);
  }
  async function fontsReady() {
    if (fontsLoaded) return;
    addFonts();
    try {
      await Promise.all([
        document.fonts.load('700 60px "Noto Serif Tamil"', 'தமிழ் நல்வாழ்த்துக்கள்'),
        document.fonts.load('600 30px "Noto Serif Tamil"', 'தமிழ்'),
        document.fonts.load('700 54px "Playfair Display"', 'Happy'),
        document.fonts.load('600 30px Poppins'), document.fonts.load('700 30px Poppins'), document.fonts.load('500 30px Poppins')
      ]);
      fontsLoaded = true;
    } catch (e) { /* draw with fallback fonts */ }
  }
  async function getLogo() {
    if (!cfg.logoUrl) return null;
    if (!logoImg) { try { logoImg = await loadImg(cfg.logoUrl); } catch (e) { logoImg = null; } }
    return logoImg;
  }
  function initials(name) {
    const w = String(name || 'School').replace(/[^A-Za-z\s]/g, ' ').trim().split(/\s+/);
    return w.slice(0, 2).map(x => x[0] || '').join('').toUpperCase() || 'S';
  }

  // ── drawing helpers ──
  function fit(x, text, maxW, size, weight, family, minSize) {
    text = String(text || ''); let s = size;
    for (; s > (minSize || 14); s -= 2) { x.font = weight + ' ' + s + 'px ' + family; if (x.measureText(text).width <= maxW) return { s, text }; }
    x.font = weight + ' ' + s + 'px ' + family;
    while (text.length > 3 && x.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return { s, text: text + '…' };
  }
  // Wrap into at most maxLines lines, shrinking the font until it fits
  function wrapFit(x, text, maxW, size, weight, family, maxLines, minSize) {
    text = String(text || '').trim();
    if (!text) return { s: size, lines: [] };
    const words = text.split(/\s+/);
    for (let s = size; s >= (minSize || 18); s -= 2) {
      x.font = weight + ' ' + s + 'px ' + family;
      const lines = []; let cur = '';
      let ok = true;
      for (const w of words) {
        const t = cur ? cur + ' ' + w : w;
        if (x.measureText(t).width <= maxW) { cur = t; continue; }
        if (!cur) { ok = false; break; }           // one word wider than the line
        lines.push(cur); cur = w;
        if (lines.length >= maxLines) { ok = false; break; }
      }
      if (ok && cur) lines.push(cur);
      if (ok && lines.length <= maxLines) return { s, lines };
    }
    const f = fit(x, text, maxW, minSize || 18, weight, family, 12);
    return { s: f.s, lines: [f.text] };
  }
  function drawLines(x, lines, cx, top, lineH, color, weight, size, family, shadow) {
    x.save();
    x.font = weight + ' ' + size + 'px ' + family; x.textAlign = 'center'; x.textBaseline = 'top'; x.fillStyle = color;
    if (shadow) { x.shadowColor = typeof shadow === 'number' ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.45)'; x.shadowBlur = typeof shadow === 'number' ? shadow : 8; x.shadowOffsetY = 2; }
    lines.forEach((l, i) => x.fillText(l, cx, top + i * lineH));
    x.restore();
  }
  function rr(x, X, Y, W, H, R) {
    x.beginPath();
    if (x.roundRect) x.roundRect(X, Y, W, H, R); else x.rect(X, Y, W, H);
  }
  function coverDraw(x, img, X, Y, W, H, focusY) {
    const s = Math.max(W / img.width, H / img.height);
    const w = img.width * s, h = img.height * s;
    x.drawImage(img, X + (W - w) / 2, Y + (H - h) * (focusY == null ? 0.5 : focusY), w, h);
  }
  // A temple-style arch: straight sides, round top
  function archPath(x, X, Y, W, H) {
    const r = W / 2;
    x.beginPath();
    x.moveTo(X, Y + H);
    x.lineTo(X, Y + r);
    x.arc(X + r, Y + r, r, Math.PI, 0);
    x.lineTo(X + W, Y + H);
    x.closePath();
  }
  function mandala(x, cx, cy, r, alpha) {
    x.save(); x.globalAlpha = alpha; x.strokeStyle = GOLD; x.fillStyle = GOLD; x.lineWidth = 2;
    [1, 0.78, 0.56].forEach(k => { x.beginPath(); x.arc(cx, cy, r * k, 0, Math.PI * 2); x.stroke(); });
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      x.beginPath();
      x.ellipse(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78, r * 0.16, r * 0.06, a, 0, Math.PI * 2);
      x.stroke();
      x.beginPath(); x.arc(cx + Math.cos(a) * r * 1.06, cy + Math.sin(a) * r * 1.06, r * 0.025, 0, Math.PI * 2); x.fill();
    }
    x.restore();
  }
  // When there is no festival picture: a glowing brass lamp on a sandal background
  function drawLamp(x, X, Y, W, H) {
    const g = x.createRadialGradient(X + W / 2, Y + H * 0.55, 10, X + W / 2, Y + H * 0.55, Math.max(W, H) * 0.7);
    g.addColorStop(0, '#FFF3D6'); g.addColorStop(0.5, SANDAL); g.addColorStop(1, '#D9B47A');
    x.fillStyle = g; x.fillRect(X, Y, W, H);
    mandala(x, X + W / 2, Y + H * 0.55, Math.min(W, H) * 0.38, 0.35);
    const cx = X + W / 2, by = Y + H * 0.66, bw = Math.min(W, H) * 0.42;
    const glow = x.createRadialGradient(cx, by - bw * 0.42, 4, cx, by - bw * 0.42, bw * 0.7);
    glow.addColorStop(0, 'rgba(255,214,102,0.85)'); glow.addColorStop(1, 'rgba(255,214,102,0)');
    x.fillStyle = glow; x.beginPath(); x.arc(cx, by - bw * 0.42, bw * 0.7, 0, Math.PI * 2); x.fill();
    const fg = x.createLinearGradient(cx, by - bw * 0.75, cx, by - bw * 0.1);
    fg.addColorStop(0, '#FFE680'); fg.addColorStop(0.6, '#FF9F1C'); fg.addColorStop(1, '#E85D04');
    x.fillStyle = fg; x.beginPath();
    x.moveTo(cx, by - bw * 0.78);
    x.bezierCurveTo(cx + bw * 0.16, by - bw * 0.48, cx + bw * 0.12, by - bw * 0.16, cx, by - bw * 0.1);
    x.bezierCurveTo(cx - bw * 0.12, by - bw * 0.16, cx - bw * 0.16, by - bw * 0.48, cx, by - bw * 0.78);
    x.fill();
    const lg = x.createLinearGradient(cx - bw / 2, by, cx + bw / 2, by);
    lg.addColorStop(0, '#8C4A12'); lg.addColorStop(0.5, '#C9852E'); lg.addColorStop(1, '#8C4A12');
    x.fillStyle = lg; x.beginPath();
    x.moveTo(cx - bw / 2, by - bw * 0.1);
    x.quadraticCurveTo(cx, by + bw * 0.42, cx + bw / 2, by - bw * 0.1);
    x.quadraticCurveTo(cx, by - bw * 0.02, cx - bw / 2, by - bw * 0.1);
    x.fill();
  }

  // ── THE POSTER ──
  // s: { size:'post'|'status', art: Image|null, withPerson, personImg, personName, personRole,
  //      ta, en, msg, from, showPhone, school:{name,city,phone}, logo: Image|null }

  // ── FULL PICTURE design (like bright greeting posts): the picture fills the poster,
  //    logo + school name on a light card at the top, wishes on a cream band at the bottom,
  //    phone and town on a maroon strip — no dark shading over the picture ──
  function drawFull(c, s) {
    const W = 1080, H = s.size === 'status' ? 1920 : 1350;
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const sch = s.school || {};
    const tall = H > 1500;
    const CREAM = '#FFF8EC', BROWN = '#5A3A22', GOLD_DARK = '#9A7424';

    if (s.art) coverDraw(x, s.art, 0, 0, W, H, 0.3);
    else drawLamp(x, 0, 0, W, H);

    // ── top: light card with logo + school name + town ──
    const lr = tall ? 62 : 52, m = tall ? 40 : 30, pad = 14;
    const nx0 = m + pad + lr * 2 + 20;
    const maxNameW = W - nx0 - m - 30;
    const nm = wrapFit(x, sch.name || 'Our School', maxNameW, tall ? 50 : 44, '700', F_HEAD, 2, 24);
    const ct = sch.city ? fit(x, sch.city, maxNameW, tall ? 28 : 24, '600', F_EN, 14) : null;
    x.font = '700 ' + nm.s + 'px ' + F_HEAD;
    let textW = Math.max.apply(null, nm.lines.map(l => x.measureText(l).width));
    if (ct) { x.font = '600 ' + ct.s + 'px ' + F_EN; textW = Math.max(textW, x.measureText(ct.text).width); }
    const cardH = lr * 2 + pad * 2, cardW = nx0 - m + textW + 34;
    x.save(); x.shadowColor = 'rgba(60,20,10,0.25)'; x.shadowBlur = 22; x.shadowOffsetY = 6;
    x.fillStyle = 'rgba(255,255,255,0.93)'; rr(x, m, m, cardW, cardH, cardH / 2); x.fill(); x.restore();
    x.strokeStyle = GOLD; x.lineWidth = 2.5; rr(x, m, m, cardW, cardH, cardH / 2); x.stroke();
    const lcx = m + pad + lr, lcy = m + pad + lr;
    if (s.logo) {
      x.save(); x.beginPath(); x.arc(lcx, lcy, lr, 0, Math.PI * 2); x.clip();
      const k = Math.min(lr * 2 / s.logo.width, lr * 2 / s.logo.height);
      x.drawImage(s.logo, lcx - s.logo.width * k / 2, lcy - s.logo.height * k / 2, s.logo.width * k, s.logo.height * k);
      x.restore();
    } else {
      x.fillStyle = MAROON; x.beginPath(); x.arc(lcx, lcy, lr, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#fff'; x.font = '700 ' + Math.round(lr * 0.7) + 'px ' + F_EN; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(initials(sch.name), lcx, lcy + 2);
    }
    const nh = nm.lines.length * nm.s * 1.1 + (ct ? ct.s + 6 : 0);
    const ny = lcy - nh / 2;
    x.save(); x.textAlign = 'left'; x.textBaseline = 'top';
    x.font = '700 ' + nm.s + 'px ' + F_HEAD; x.fillStyle = MAROON;
    nm.lines.forEach((l, i) => x.fillText(l, nx0, ny + i * nm.s * 1.1));
    if (ct) { x.font = '600 ' + ct.s + 'px ' + F_EN; x.fillStyle = GOLD_DARK; x.fillText(ct.text, nx0, ny + nm.lines.length * nm.s * 1.1 + 4); }
    x.restore();

    // ── bottom: maroon strip with phone · town ──
    const foot = [];
    if (s.showPhone && sch.phone) foot.push('📞 ' + sch.phone);
    if (sch.city) foot.push('📍 ' + sch.city);
    const stripH = foot.length ? (tall ? 84 : 70) : 0;
    const stripY = H - stripH;
    if (stripH) {
      x.fillStyle = MAROON; x.fillRect(0, stripY, W, stripH);
      x.fillStyle = GOLD; x.fillRect(0, stripY, W, 4);
      const ft = fit(x, foot.join('     '), W - 80, tall ? 32 : 28, '600', F_EN, 16);
      x.fillStyle = '#FFFFFF'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '600 ' + ft.s + 'px ' + F_EN;
      x.fillText(ft.text, W / 2, stripY + stripH / 2 + 2);
    }

    // ── wishes, measured from the bottom up ──
    const tw = W - 110;
    const ta = wrapFit(x, s.ta, tw, tall ? 72 : 62, '700', F_TA, 2, 30);
    const en = s.en ? fit(x, s.en, tw, tall ? 58 : 50, '700', F_HEAD, 24) : null;
    const msg = wrapFit(x, s.msg, tw - 40, tall ? 32 : 27, '500', F_EN, 2, 16);
    const from = s.from ? fit(x, '— ' + s.from + ' —', tw, tall ? 29 : 25, '600', F_EN, 14) : null;
    const gap = tall ? 16 : 10;
    const blocks = [];
    if (ta.lines.length) blocks.push({ h: ta.lines.length * ta.s * 1.3, draw: (t) => drawLines(x, ta.lines, W / 2, t, ta.s * 1.3, MAROON, '700', ta.s, F_TA, false) });
    if (ta.lines.length && en) blocks.push({ h: 10, draw: (t) => {
      x.save(); x.strokeStyle = GOLD; x.lineWidth = 2; x.beginPath(); x.moveTo(W / 2 - 160, t + 5); x.lineTo(W / 2 + 160, t + 5); x.stroke();
      x.translate(W / 2, t + 5); x.rotate(Math.PI / 4); x.fillStyle = GOLD; x.fillRect(-6, -6, 12, 12); x.restore(); } });
    if (en) blocks.push({ h: en.s * 1.18, draw: (t) => drawLines(x, [en.text], W / 2, t, 0, MAROON_DARK, '700', en.s, F_HEAD, false) });
    if (msg.lines.length) blocks.push({ h: msg.lines.length * msg.s * 1.38, draw: (t) => drawLines(x, msg.lines, W / 2, t, msg.s * 1.38, BROWN, '500', msg.s, F_EN, false) });
    if (from) blocks.push({ h: from.s * 1.3, draw: (t) => drawLines(x, [from.text], W / 2, t, 0, GOLD_DARK, '600', from.s, F_EN, false) });
    const textH = blocks.reduce((a, b) => a + b.h, 0) + Math.max(0, blocks.length - 1) * gap;
    const textTop = (stripH ? stripY : H) - (tall ? 40 : 26) - textH;

    // cream band with a gentle wave on top and a gold edge
    const bandTop = textTop - (tall ? 70 : 56);
    const wave = tall ? 34 : 28;
    const bandPath = () => {
      x.beginPath();
      x.moveTo(0, bandTop + wave);
      x.bezierCurveTo(W * 0.25, bandTop - wave, W * 0.75, bandTop + wave * 2, W, bandTop);
      x.lineTo(W, stripH ? stripY : H); x.lineTo(0, stripH ? stripY : H); x.closePath();
    };
    x.save(); x.shadowColor = 'rgba(60,20,10,0.22)'; x.shadowBlur = 24; x.shadowOffsetY = -4;
    bandPath(); x.fillStyle = CREAM; x.fill(); x.restore();
    x.save(); bandPath(); x.clip(); mandala(x, 0, H, 260, 0.12); mandala(x, W, H, 260, 0.12); x.restore();
    x.strokeStyle = GOLD; x.lineWidth = 4;
    x.beginPath(); x.moveTo(0, bandTop + wave); x.bezierCurveTo(W * 0.25, bandTop - wave, W * 0.75, bandTop + wave * 2, W, bandTop); x.stroke();

    // person (optional): round photo at the right, resting on the band — keeps the picture's centre clear
    const person = s.withPerson && s.personImg;
    if (person) {
      const pr = tall ? 130 : 96;
      const pcx = W - m - pr - 10, pcy = bandTop - pr * 0.55;
      x.save(); x.shadowColor = 'rgba(60,20,10,0.35)'; x.shadowBlur = 20;
      x.fillStyle = '#fff'; x.beginPath(); x.arc(pcx, pcy, pr + 7, 0, Math.PI * 2); x.fill(); x.restore();
      x.save(); x.beginPath(); x.arc(pcx, pcy, pr, 0, Math.PI * 2); x.clip();
      coverDraw(x, s.personImg, pcx - pr, pcy - pr, pr * 2, pr * 2, 0.25);
      x.restore();
      x.strokeStyle = GOLD; x.lineWidth = 6; x.beginPath(); x.arc(pcx, pcy, pr + 10, 0, Math.PI * 2); x.stroke();
      const t = [s.personName, s.personRole].filter(Boolean).join(', ');
      if (t) {
        const nl = fit(x, t, W * 0.6, tall ? 30 : 26, '700', F_EN, 14);
        x.font = '700 ' + nl.s + 'px ' + F_EN;
        const w = x.measureText(nl.text).width + 34, h = nl.s + 18;
        const bx = Math.min(W - m - w, pcx - w / 2), by = pcy - pr - 14 - h;
        x.fillStyle = MAROON; rr(x, bx, by, w, h, h / 2); x.fill();
        x.strokeStyle = GOLD; x.lineWidth = 2; rr(x, bx, by, w, h, h / 2); x.stroke();
        x.fillStyle = '#FFFFFF'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(nl.text, bx + w / 2, by + h / 2 + 1);
      }
    }

    let t = textTop;
    blocks.forEach(b => { b.draw(t); t += b.h + gap; });
    return c;
  }

  // ── AI POSTER design: the AI made the whole poster (scene, correspondent, school name, English
  //    greeting, empty ribbon). Here we only add the real logo as a small seal, the Tamil wishes
  //    in the ribbon, and the phone number. The poster is never cropped: if its shape differs,
  //    the sides are filled with a soft blurred copy. ──
  // The school logo with its plain white (or near-white) background removed, so it sits on the
  // poster by itself. Only white that touches the picture's edge is removed — white inside the
  // logo design stays. Falls back to the logo as it is if the browser will not allow it.
  let logoCut = null, logoCutFrom = null;
  function cutLogo(img) {
    if (!img) return null;
    if (logoCut && logoCutFrom === img) return logoCut;
    try {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height), p = d.data, W = c.width, H = c.height;
      const light = (i) => p[i + 3] < 20 || (p[i] > 228 && p[i + 1] > 228 && p[i + 2] > 228);
      const seen = new Uint8Array(W * H), stack = [];
      for (let xx = 0; xx < W; xx++) { stack.push(xx, (H - 1) * W + xx); }
      for (let yy = 0; yy < H; yy++) { stack.push(yy * W, yy * W + W - 1); }
      while (stack.length) {
        const k = stack.pop();
        if (seen[k]) continue; seen[k] = 1;
        if (!light(k * 4)) continue;
        p[k * 4 + 3] = 0;
        const xx = k % W, yy = (k - xx) / W;
        if (xx > 0) stack.push(k - 1); if (xx < W - 1) stack.push(k + 1);
        if (yy > 0) stack.push(k - W); if (yy < H - 1) stack.push(k + W);
      }
      // soften the cut edge: half-clear light pixels next to a cleared one
      for (let k = 0; k < W * H; k++) {
        if (p[k * 4 + 3] === 0) continue;
        const xx = k % W;
        const nb = [k - 1, k + 1, k - W, k + W].some(n => n >= 0 && n < W * H && Math.abs((n % W) - xx) <= 1 && p[n * 4 + 3] === 0);
        if (nb && p[k * 4] > 200 && p[k * 4 + 1] > 200 && p[k * 4 + 2] > 200) p[k * 4 + 3] = 110;
      }
      x.putImageData(d, 0, 0);
      logoCut = c; logoCutFrom = img;
      return c;
    } catch (e) { return img; }
  }

  function drawAi(c, s) {
    const W = 1080, H = s.size === 'status' ? 1920 : 1350;
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const sch = s.school || {};
    if (!s.art) {
      drawLamp(x, 0, 0, W, H);
      x.save(); x.fillStyle = 'rgba(62,13,13,0.82)'; rr(x, W / 2 - 330, H * 0.82, 660, 120, 60); x.fill();
      x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#F5E6C8'; x.font = '600 34px ' + F_EN;
      x.fillText(s.designing ? '⏳ The AI is designing your poster…' : 'Your poster will appear here', W / 2, H * 0.82 + 60);
      x.restore();
      return c;
    }
    const img = s.art;
    try { x.filter = 'blur(30px) brightness(0.95)'; coverDraw(x, img, -40, -40, W + 80, H + 80, 0.5); x.filter = 'none'; } catch (e) {}
    const k = Math.min(W / img.width, H / img.height);
    const iw = img.width * k, ih = img.height * k, ix = (W - iw) / 2, iy = (H - ih) / 2;
    x.save(); x.shadowColor = 'rgba(0,0,0,0.35)'; x.shadowBlur = 30;
    x.drawImage(img, ix, iy, iw, ih); x.restore();

    // real logo in the top-left corner, on its own — no circle, no shade behind it
    if (s.logo) {
      const lg = cutLogo(s.logo);
      const box = Math.round(iw * 0.13);
      const lk = Math.min(box / lg.width, box / lg.height);
      x.drawImage(lg, ix + iw * 0.03, iy + ih * 0.018, lg.width * lk, lg.height * lk);
    }

    // Tamil wishes inside the ribbon (lower part of the poster): gold with a maroon edge, like foil lettering
    if (s.ta) {
      const tf = wrapFit(x, s.ta, iw * 0.66, Math.round(iw * 0.052), '700', F_TA, 2, Math.round(iw * 0.03));
      const lh = tf.s * 1.25, ty0 = iy + ih * 0.872 - (tf.lines.length - 1) * lh / 2;
      x.save(); x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '700 ' + tf.s + 'px ' + F_TA;
      x.lineJoin = 'round'; x.lineWidth = Math.max(4, tf.s * 0.16); x.strokeStyle = '#4A0E0E';
      tf.lines.forEach((l, i) => {
        const ty = ty0 + i * lh;
        x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = 8; x.shadowOffsetY = 2;
        x.strokeText(l, W / 2, ty);
        x.shadowColor = 'transparent';
        const fg = x.createLinearGradient(0, ty - tf.s / 2, 0, ty + tf.s / 2);
        fg.addColorStop(0, '#FFF1B8'); fg.addColorStop(0.55, '#E8C96A'); fg.addColorStop(1, '#B98E2E');
        x.fillStyle = fg; x.fillText(l, W / 2, ty);
      });
      x.restore();
    }

    // phone · town on the thin strip at the very bottom
    const foot = [];
    if (s.showPhone && sch.phone) foot.push('📞 ' + sch.phone);
    if (sch.city) foot.push(sch.city);
    if (foot.length) {
      const ft = fit(x, foot.join('   ·   '), iw * 0.8, Math.round(iw * 0.026), '600', F_EN, 12);
      x.save(); x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '600 ' + ft.s + 'px ' + F_EN;
      x.fillStyle = '#FFFFFF'; x.shadowColor = 'rgba(0,0,0,0.7)'; x.shadowBlur = 6;
      x.fillText(ft.text, W / 2, iy + ih - ih * 0.022);
      x.restore();
    }
    return c;
  }

  function drawPoster(c, s) {
    if (s.design === 'ai') return drawAi(c, s);
    if (s.design === 'full') return drawFull(c, s);
    const W = 1080, H = s.size === 'status' ? 1920 : 1350;
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const sch = s.school || {};

    // background: deep maroon glow, corner kolam patterns, double gold border
    const bg = x.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H * 0.45, H * 0.85);
    bg.addColorStop(0, '#8E2C24'); bg.addColorStop(0.55, '#5E1616'); bg.addColorStop(1, '#2C0707');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    mandala(x, 0, 0, 230, 0.18); mandala(x, W, 0, 230, 0.18); mandala(x, 0, H, 230, 0.18); mandala(x, W, H, 230, 0.18);
    x.strokeStyle = GOLD; x.lineWidth = 5; x.strokeRect(22, 22, W - 44, H - 44);
    x.lineWidth = 1.5; x.strokeRect(36, 36, W - 72, H - 72);
    [[36, 36], [W - 36, 36], [36, H - 36], [W - 36, H - 36]].forEach(p => {
      x.save(); x.translate(p[0], p[1]); x.rotate(Math.PI / 4); x.fillStyle = GOLD; x.fillRect(-9, -9, 18, 18); x.restore();
    });

    // header: logo + school name + town
    const tall = H > 1500;
    const lr = tall ? 82 : 66, lcy = tall ? 150 : 118;
    x.save(); x.shadowColor = 'rgba(0,0,0,0.4)'; x.shadowBlur = 16;
    x.fillStyle = '#fff'; x.beginPath(); x.arc(W / 2, lcy, lr, 0, Math.PI * 2); x.fill(); x.restore();
    x.strokeStyle = GOLD; x.lineWidth = 5; x.beginPath(); x.arc(W / 2, lcy, lr + 3, 0, Math.PI * 2); x.stroke();
    if (s.logo) {
      x.save(); x.beginPath(); x.arc(W / 2, lcy, lr - 4, 0, Math.PI * 2); x.clip();
      const k = Math.min((lr * 2 - 12) / s.logo.width, (lr * 2 - 12) / s.logo.height);
      x.drawImage(s.logo, W / 2 - s.logo.width * k / 2, lcy - s.logo.height * k / 2, s.logo.width * k, s.logo.height * k);
      x.restore();
    } else {
      x.fillStyle = MAROON; x.font = '700 ' + Math.round(lr * 0.7) + 'px ' + F_EN; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(initials(sch.name), W / 2, lcy + 2);
    }
    let y = lcy + lr + (tall ? 30 : 22);
    const nm = wrapFit(x, sch.name || 'Our School', W - 170, tall ? 56 : 48, '700', F_HEAD, 2, 30);
    drawLines(x, nm.lines, W / 2, y, nm.s * 1.15, GOLD_LIGHT, '700', nm.s, F_HEAD, true);
    y += nm.lines.length * nm.s * 1.15;
    if (sch.city) {
      const ct = fit(x, sch.city, W - 200, tall ? 30 : 26, '500', F_EN, 16);
      drawLines(x, [ct.text], W / 2, y + 4, 0, SANDAL, '500', ct.s, F_EN, false);
      y += ct.s + 8;
    }
    const archTop = y + (tall ? 64 : 54);          // room for the little ornament on top of the arch

    // footer band: phone · town
    const foot = [];
    if (s.showPhone && sch.phone) foot.push('📞 ' + sch.phone);
    if (sch.city) foot.push(sch.city);
    const footH = foot.length ? (tall ? 76 : 62) : 0;
    const footY = H - 36 - footH;
    if (footH) {
      const fg = x.createLinearGradient(0, footY, W, footY);
      fg.addColorStop(0, '#A9832F'); fg.addColorStop(0.5, GOLD_LIGHT); fg.addColorStop(1, '#A9832F');
      x.fillStyle = fg; x.fillRect(36, footY, W - 72, footH);
      const ft = fit(x, foot.join('   ·   '), W - 160, tall ? 32 : 28, '600', F_EN, 16);
      x.fillStyle = MAROON_DARK; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '600 ' + ft.s + 'px ' + F_EN;
      x.fillText(ft.text, W / 2, footY + footH / 2 + 1);
    }

    // wishes, measured from the bottom up
    const tw = W - 150;
    const person = s.withPerson && s.personImg;
    const compact = person && !tall;
    const ta = wrapFit(x, s.ta, tw, tall ? 70 : 60, '700', F_TA, compact ? 1 : 2, 30);
    const en = s.en ? fit(x, s.en, tw, tall ? 60 : 50, '700', F_HEAD, 26) : null;
    const msg = wrapFit(x, s.msg, tw - 40, tall ? 34 : 29, '500', F_EN, compact ? 1 : 2, 18);
    const from = s.from ? fit(x, '— ' + s.from + ' —', tw, tall ? 30 : 26, '500', F_EN, 16) : null;
    const gap = tall ? 22 : 14;
    const blocks = [];
    if (ta.lines.length) blocks.push({ h: ta.lines.length * ta.s * 1.32, draw: (t) => drawLines(x, ta.lines, W / 2, t, ta.s * 1.32, GOLD_LIGHT, '700', ta.s, F_TA, true) });
    if (en) blocks.push({ h: en.s * 1.2, draw: (t) => drawLines(x, [en.text], W / 2, t, 0, '#FFFFFF', '700', en.s, F_HEAD, true) });
    if (msg.lines.length) blocks.push({ h: msg.lines.length * msg.s * 1.4, draw: (t) => drawLines(x, msg.lines, W / 2, t, msg.s * 1.4, SANDAL, '500', msg.s, F_EN, false) });
    if (from) blocks.push({ h: from.s * 1.3, draw: (t) => drawLines(x, [from.text], W / 2, t, 0, GOLD, '500', from.s, F_EN, false) });
    const textH = blocks.reduce((a, b) => a + b.h, 0) + Math.max(0, blocks.length - 1) * gap;
    const textTop = (footH ? footY : H - 36) - (tall ? 40 : 26) - textH;

    // person block under the arch: round photo overlapping the arch bottom, then the name
    const pr = person ? (tall ? 150 : 104) : 0;
    let nameLine = null;
    if (person) {
      const t = [s.personName, s.personRole].filter(Boolean).join(', ');
      if (t) nameLine = fit(x, t, tw, tall ? 38 : 32, '700', F_EN, 18);
    }
    const personBelow = person ? pr + 12 + (nameLine ? nameLine.s * 1.3 : 0) : 0;
    const archBottom = textTop - (tall ? 40 : 26) - personBelow;

    // the arch with the festival picture
    let archH = archBottom - archTop;
    let archW = Math.min(tall ? 820 : 720, W - 200);
    if (archH < archW * 0.9) archW = Math.max(460, Math.round(archH / 0.9));
    archH = Math.max(260, archH);
    const archX = (W - archW) / 2;
    x.save(); x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = 30; x.shadowOffsetY = 8;
    archPath(x, archX, archTop, archW, archH); x.fillStyle = '#2C0707'; x.fill(); x.restore();
    x.save(); archPath(x, archX, archTop, archW, archH); x.clip();
    if (s.art) coverDraw(x, s.art, archX, archTop, archW, archH, 0.35);
    else drawLamp(x, archX, archTop, archW, archH);
    x.restore();
    x.strokeStyle = GOLD; x.lineWidth = 9; archPath(x, archX, archTop, archW, archH); x.stroke();
    x.strokeStyle = 'rgba(232,201,106,0.7)'; x.lineWidth = 2; archPath(x, archX - 14, archTop - 14, archW + 28, archH + 14); x.stroke();
    // little kalasam on top of the arch
    x.fillStyle = GOLD; x.beginPath(); x.arc(W / 2, archTop - 18, 9, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.moveTo(W / 2, archTop - 44); x.lineTo(W / 2 + 7, archTop - 27); x.lineTo(W / 2 - 7, archTop - 27); x.closePath(); x.fill();

    if (person) {
      const pcx = W / 2, pcy = archTop + archH;
      x.save(); x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = 20;
      x.fillStyle = '#fff'; x.beginPath(); x.arc(pcx, pcy, pr + 8, 0, Math.PI * 2); x.fill(); x.restore();
      x.save(); x.beginPath(); x.arc(pcx, pcy, pr, 0, Math.PI * 2); x.clip();
      coverDraw(x, s.personImg, pcx - pr, pcy - pr, pr * 2, pr * 2, 0.25);
      x.restore();
      x.strokeStyle = GOLD; x.lineWidth = 6; x.beginPath(); x.arc(pcx, pcy, pr + 11, 0, Math.PI * 2); x.stroke();
      if (nameLine) drawLines(x, [nameLine.text], W / 2, pcy + pr + 18, 0, '#FFFFFF', '700', nameLine.s, F_EN, true);
    }

    // wishes
    let t = textTop;
    blocks.forEach(b => { b.draw(t); t += b.h + gap; });
    return c;
  }

  // Keep the poster under the upload limit
  function toJpeg(c) {
    let q = 0.92, d = c.toDataURL('image/jpeg', q);
    while (d.length * 0.75 > 860 * 1024 && q > 0.5) { q -= 0.07; d = c.toDataURL('image/jpeg', q); }
    return d;
  }

  // ── THE TAB ──
  function chip(group, value, label, on) {
    return '<label class="chip' + (on ? ' on' : '') + '" data-g="' + group + '" data-v="' + value + '"><input type="radio" name="fw-' + group + '" value="' + value + '"' + (on ? ' checked' : '') + '>' + label + '</label>';
  }
  function build() {
    const box = $('tab-festival');
    if (!box || built) return;
    built = true;
    st.fest = guessFestival(new Date());
    box.innerHTML =
      '<div id="fw-ready" class="card hidden" style="margin-bottom:16px"></div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start">'
      + '<div class="card">'
      +   '<div class="card-title">🪔 Festival Wishes poster</div>'
      +   '<div class="help" style="margin:4px 0 12px">Pick the festival. The poster is made with your school logo and name, wishes in Tamil and English, and a festival picture. Check it, then download, share, or add it to "Ready to Post".</div>'
      +   '<label class="form-label">Festival</label>'
      +   '<select id="fw-fest" class="form-control">' + FESTIVALS.map(f => '<option value="' + f.key + '">' + esc(f.name) + '</option>').join('') + '</select>'
      +   '<div class="style-row"><b style="font-size:12px;margin-right:4px">Design</b>'
      +     chip('design', 'ai', '🎨 AI poster (best)', true) + chip('design', 'full', '✨ Full picture', false) + chip('design', 'framed', '🖼 Framed', false)
      +     '<div class="help" id="fw-ai-note" style="width:100%;margin-top:6px">The AI designs the whole poster — picture, school name, English wishes and the correspondent\'s photo blended in. Made for your school; the first one takes 1–2 minutes. Check the spelling before sharing.</div></div>'
      +   '<div class="style-row"><b style="font-size:12px;margin-right:4px">Picture</b>'
      +     chip('pic', 'ai', '🛕 Festival picture', true) + chip('pic', 'own', '📁 Our own picture', false) + chip('pic', 'none', '🪔 Lamp design', false)
      +     '<div id="fw-ai-row" style="width:100%;margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      +       '<button class="btn btn-secondary btn-sm" id="fw-next">🔄 Another picture</button><span class="help" id="fw-art-status"></span></div>'
      +     '<div id="fw-own-row" class="hidden" style="width:100%;margin-top:6px"><input type="file" id="fw-own-file" accept="image/*" class="form-control" style="max-width:300px">'
      +       '<div class="help" style="margin-top:4px">Use only a picture the school is allowed to use (your own photo or one you bought).</div></div>'
      +   '</div>'
      +   '<div class="style-row"><b style="font-size:12px;margin-right:4px">Photo of</b>'
      +     chip('who', 'no', 'Picture only', true) + chip('who', 'yes', '👤 With correspondent / principal photo', false)
      +     '<div id="fw-person-row" class="hidden" style="width:100%;margin-top:8px">'
      +       '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><img id="fw-person-thumb" alt="" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--gold);display:none">'
      +       '<input type="file" id="fw-person-file" accept="image/*" class="form-control" style="max-width:260px"></div>'
      +       '<div id="fw-pose-row" style="margin-top:10px"><b style="font-size:12px;margin-right:4px">Pose</b>'
      +         chip('pose', 'auto', '✨ Auto (suits the festival)', true) + chip('pose', 'vanakkam', '🙏 Vanakkam', false)
      +         chip('pose', 'smile', '😊 Smiling', false) + chip('pose', 'heart', '🤍 Hand on heart', false)
      +         chip('pose', 'formal', '👔 Formal', false) + chip('pose', 'majestic', '👑 Majestic', false) + chip('pose', 'folded', '💪 Arms folded', false)
      +         '<div class="help" style="margin-top:4px">Used in the 🎨 AI poster. Auto: vanakkam for most festivals, majestic for Independence / Republic Day, formal for Teachers\' Day and New Year, hand on heart for Christmas, Ramzan and Bakrid.</div></div>'
      +       '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">'
      +         '<input id="fw-pname" class="form-control" maxlength="60" placeholder="Name, e.g. Mr. R. Kumar">'
      +         '<input id="fw-prole" class="form-control" maxlength="60" placeholder="e.g. Correspondent"></div>'
      +       '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" id="fw-psave">💾 Save photo & name for next festivals</button>'
      +       '<button class="btn btn-secondary btn-sm" id="fw-pdel">🗑 Remove saved photo</button></div>'
      +       '<div class="help" style="margin-top:4px">A clear face photo looks best. Saved once, it is ready for every festival.</div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="lbl">Tamil wishes</div><input id="fw-ta" class="form-control" maxlength="80">'
      +   '<div class="lbl">English wishes</div><input id="fw-en" class="form-control" maxlength="60">'
      +   '<div class="lbl">Short message</div><input id="fw-msg" class="form-control" maxlength="120">'
      +   '<div class="lbl">From</div><input id="fw-from" class="form-control" maxlength="70">'
      +   '<label class="tick" id="fw-phone-row"><input type="checkbox" id="fw-phone" checked> Show school phone number at the bottom</label>'
      +   '<div class="style-row"><b style="font-size:12px;margin-right:4px">Size</b>'
      +     chip('size', 'post', '📷 Post (Instagram / Facebook)', true) + chip('size', 'status', '📱 WhatsApp Status', false) + '</div>'
      + '</div>'
      + '<div class="card" style="text-align:center">'
      +   '<canvas id="fw-canvas" style="width:100%;max-width:380px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);background:#3E0D0D"></canvas>'
      +   '<div class="help" id="fw-note" style="margin-top:8px"></div>'
      +   '<div class="actions" style="justify-content:center">'
      +     '<button class="btn btn-gold btn-sm" id="fw-share">📤 Share to WhatsApp</button>'
      +     '<button class="btn btn-primary btn-sm" id="fw-add">✅ Add to Ready to Post</button>'
      +     '<button class="btn btn-secondary btn-sm" id="fw-dl">⬇ Download</button>'
      +   '</div>'
      +   '<div class="help" style="margin-top:8px">"Ready to Post" lets you post to Facebook / Instagram, send to WhatsApp, or put it in the Parent Gallery.</div>'
      + '</div></div>';

    $('fw-fest').value = st.fest;
    $('fw-from').value = st.from;
    setTimeout(showDesignBits, 0);
    setFestTexts();
    if (!cfg.school.phone) $('fw-phone-row').style.display = 'none';

    box.addEventListener('change', onChange);
    box.addEventListener('input', (e) => { if (/^fw-(ta|en|msg|from|pname|prole)$/.test(e.target.id)) { readTexts(); redraw(); } });
    $('fw-next').onclick = () => nextArt();
    $('fw-psave').onclick = () => savePerson();
    $('fw-pdel').onclick = () => removePerson();
    $('fw-add').onclick = () => addToReady();
    $('fw-share').onclick = () => share();
    $('fw-dl').onclick = () => download();
    loadPerson();
  }
  function setFestTexts() {
    const f = festOf(st.fest);
    $('fw-ta').value = f.ta; $('fw-en').value = f.en; $('fw-msg').value = f.msg;
    readTexts();
  }
  function readTexts() {
    st.ta = $('fw-ta').value.trim(); st.en = $('fw-en').value.trim(); st.msg = $('fw-msg').value.trim();
    st.from = $('fw-from').value.trim(); st.phone = $('fw-phone').checked;
  }
  function setChip(group, v) {
    document.querySelectorAll('#tab-festival label.chip[data-g="' + group + '"]').forEach(l => {
      const on = l.dataset.v === v; l.classList.toggle('on', on); l.querySelector('input').checked = on;
    });
  }
  async function onChange(e) {
    const t = e.target;
    if (t.name === 'fw-pic') {
      st.pic = t.value; setChip('pic', t.value);
      $('fw-ai-row').classList.toggle('hidden', t.value !== 'ai');
      $('fw-own-row').classList.toggle('hidden', t.value !== 'own');
      if (t.value === 'ai') await loadArt();
      return redraw();
    }
    if (t.name === 'fw-who') {
      st.withPerson = t.value === 'yes'; setChip('who', t.value);
      $('fw-person-row').classList.toggle('hidden', !st.withPerson);
      if (st.design === 'ai' && (!st.withPerson || st.person)) await loadArt();
      return redraw();
    }
    if (t.name === 'fw-design') {
      st.design = t.value; setChip('design', t.value);
      if (st.design === 'ai') { st.pic = 'ai'; setChip('pic', 'ai'); $('fw-ai-row').classList.remove('hidden'); $('fw-own-row').classList.add('hidden'); }
      showDesignBits();
      if (st.pic === 'ai') await loadArt();
      return redraw();
    }
    if (t.name === 'fw-pose') {
      st.pose = t.value; setChip('pose', t.value);
      if (st.design === 'ai' && st.withPerson) await loadArt();
      return redraw();
    }
    if (t.name === 'fw-size') { st.size = t.value; setChip('size', t.value); return redraw(); }
    if (t.id === 'fw-fest') { st.fest = t.value; setFestTexts(); if (st.pic === 'ai') await loadArt(); return redraw(); }
    if (t.id === 'fw-phone') { readTexts(); return redraw(); }
    if (t.id === 'fw-own-file') {
      const f = t.files && t.files[0]; if (!f) return;
      try { st.own = (await fileToImg(f, 1600)).img; redraw(); } catch (err) { toast('⚠️ ' + err.message, 'error'); }
      return;
    }
    if (t.id === 'fw-person-file') {
      const f = t.files && t.files[0]; if (!f) return;
      try {
        const r = await fileToImg(f, 800);
        st.personImg = r.img; st.personNew = r.url;
        $('fw-person-thumb').src = r.url; $('fw-person-thumb').style.display = '';
        redraw();
      } catch (err) { toast('⚠️ ' + err.message, 'error'); }
    }
  }

  // ── Today's festival: ready designs to pick with one tap (pictures made the night before) ──
  async function loadToday() {
    let d;
    try { d = await call('today'); } catch (e) { return; }
    if (!d.festival || !FESTIVALS.find(f => f.key === d.festival)) return;
    st.fest = d.festival; $('fw-fest').value = d.festival; setFestTexts();
    const art = festOf(d.festival).art;
    const ready = (d.ready || []).sort((a, b) => (a.design === b.design ? a.variant - b.variant : a.design === 'full' ? -1 : 1));
    // start on a picture that is already made, so nothing has to wait
    const firstOwn = ready.find(r => r.design === st.design);
    try { if (firstOwn && !localStorage.getItem('fw_v_' + st.design + '_' + art)) localStorage.setItem('fw_v_' + st.design + '_' + art, String(firstOwn.variant)); } catch (e) {}
    const box = $('fw-ready');
    const when = d.when === 'tomorrow' ? 'Tomorrow is ' : 'Today is ';
    box.classList.remove('hidden');
    box.innerHTML = '<div class="card-title">🪔 ' + esc(when + festOf(d.festival).name) + ' — your posters are ready</div>'
      + '<div class="help" style="margin:4px 0 10px">' + (ready.length
          ? 'Tap a design, check it, then press <b>📤 Share to WhatsApp</b>. Your logo, school name and phone are already on it.'
          : 'The festival pictures are being made — the first one takes about a minute. Your poster appears below.') + '</div>'
      + '<div id="fw-ready-strip" style="display:flex;gap:10px;overflow-x:auto;padding-bottom:6px"></div>';
    if (!ready.length) return;
    await fontsReady();
    const logo = await getLogo();
    const strip = $('fw-ready-strip');
    readyList = [];
    for (const r of ready.slice(0, 6)) {
      try {
        const k = r.design + '-' + art + '-' + r.variant;
        const img = artCache[k] || await loadImg(r.url);
        artCache[k] = img;
        const big = document.createElement('canvas');
        drawPoster(big, Object.assign(currentState(logo), { design: r.design, art: img, size: 'post' }));
        const sm = document.createElement('canvas'); sm.width = 216; sm.height = 270;
        sm.getContext('2d').drawImage(big, 0, 0, 216, 270);
        readyList.push({ r, img, art });
        const i = readyList.length - 1;
        const el = document.createElement('img');
        el.src = sm.toDataURL('image/jpeg', 0.8);
        el.alt = 'Ready design ' + (i + 1);
        el.style.cssText = 'width:150px;flex:none;border-radius:8px;border:3px solid transparent;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15)';
        el.onclick = () => pickReady(i);
        el.id = 'fw-rd-' + i;
        strip.appendChild(el);
      } catch (e) { /* skip a picture that will not load */ }
    }
    if (readyList.length) pickReady(0);   // start on the first ready design — no waiting
  }
  let readyList = [];
  // AI poster: the picture choices (own picture / lamp) do not apply, so they are hidden
  function showDesignBits() {
    const ai = st.design === 'ai';
    document.querySelectorAll('#tab-festival label.chip[data-g="pic"]').forEach(l => { l.style.display = ai ? 'none' : ''; });
    const n = $('fw-ai-note'); if (n) n.style.display = ai ? '' : 'none';
    const b = $('fw-next'); if (b) b.textContent = ai ? '🔄 Another poster' : '🔄 Another picture';
  }
  function pickReady(i) {
    const it = readyList[i]; if (!it) return;
    if (it.r.design === 'ai') {
      st.withPerson = !!it.r.person; setChip('who', st.withPerson ? 'yes' : 'no');
      $('fw-person-row').classList.toggle('hidden', !st.withPerson);
      if (st.withPerson) { st.pose = 'auto'; setChip('pose', 'auto'); }
      const key = 'ai-' + st.fest + '-' + (st.withPerson ? 'p-' + st.pose : 'n') + '-' + st.en;
      artCache[key + '-' + it.r.variant] = it.img;
      try { localStorage.setItem('fw_v_' + key, String(it.r.variant)); } catch (e) {}
    }
    document.querySelectorAll('#fw-ready-strip img').forEach((el, j) => { el.style.borderColor = j === i ? GOLD : 'transparent'; });
    st.design = it.r.design; setChip('design', it.r.design); showDesignBits();
    st.pic = 'ai'; setChip('pic', 'ai');
    $('fw-ai-row').classList.remove('hidden'); $('fw-own-row').classList.add('hidden');
    st.art = it.img; st.variant = it.r.variant;
    try { localStorage.setItem('fw_v_' + it.r.design + '_' + it.art, String(it.r.variant)); } catch (e) {}
    $('fw-art-status').textContent = (it.r.design === 'ai' ? 'Poster ' : 'Picture ') + it.r.variant + ' of 4';
    redraw();
    if (window.innerWidth < 900) { const c = $('fw-canvas'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }

  // ── festival picture (shared AI picture, made once for all schools) ──
  function rememberedVariant(art) { try { return parseInt(localStorage.getItem('fw_v_' + st.design + '_' + art), 10) || 1; } catch (e) { return 1; } }
  async function loadArt(variant) {
    if (st.design === 'ai') return loadPoster(variant);
    const art = festOf(st.fest).art;
    const v = variant || rememberedVariant(art);
    const design = st.design;
    const k = design + '-' + art + '-' + v;
    const status = $('fw-art-status');
    if (artCache[k]) { st.art = artCache[k]; st.variant = v; status.textContent = 'Picture ' + v + ' of 4'; return; }
    busy = true; setButtons();
    status.textContent = '⏳ Getting the festival picture… the first time it is made it takes about a minute.';
    try {
      const d = await call('art', { festival: art, variant: v, design });
      const img = await loadImg(d.url);
      artCache[k] = img;
      if (festOf(st.fest).art === art && st.design === design) { st.art = img; st.variant = d.variant; }
      try { localStorage.setItem('fw_v_' + design + '_' + art, String(d.variant)); } catch (e) {}
      status.textContent = 'Picture ' + d.variant + ' of ' + d.max + (d.made ? ' · newly made' : '');
    } catch (err) {
      st.art = null;
      status.textContent = '⚠️ ' + err.message;
    }
    busy = false; setButtons();
  }
  // the whole AI poster, made for this school (with the saved photo when "With correspondent" is on)
  async function loadPoster(variant) {
    const status = $('fw-art-status');
    if (st.withPerson && st.personNew) await savePerson();
    if (st.withPerson && !st.person) { status.textContent = 'Add and save the correspondent / principal photo below, then press 🔄.'; return; }
    const key = 'ai-' + st.fest + '-' + (st.withPerson ? 'p-' + st.pose : 'n') + '-' + st.en;
    const v = variant || (function () { try { return parseInt(localStorage.getItem('fw_v_' + key), 10) || 1; } catch (e) { return 1; } })();
    const k = key + '-' + v;
    if (artCache[k]) { st.art = artCache[k]; st.variant = v; status.textContent = 'Poster ' + v + ' of 4'; return; }
    busy = true; setButtons();
    st.art = null; st.designing = true; redraw();
    status.textContent = '⏳ The AI is designing your poster… the first time takes 1–2 minutes. Please keep this page open.';
    try {
      const d = await call('compose', { festival: st.fest, variant: v, en: st.en, with_person: !!st.withPerson, pose: st.pose });
      const img = await loadImg(d.url);
      artCache[k] = img;
      st.art = img; st.variant = d.variant;
      try { localStorage.setItem('fw_v_' + key, String(d.variant)); } catch (e) {}
      status.textContent = 'Poster ' + d.variant + ' of ' + d.max + (d.made ? ' · newly made' : '') + ' — check the spelling of the school name.';
    } catch (err) {
      st.art = null;
      status.textContent = '⚠️ ' + err.message;
    }
    st.designing = false;
    busy = false; setButtons();
    redraw();
  }
  async function nextArt() {
    if (busy) return;
    await loadArt((st.variant % 4) + 1);
    redraw();
  }

  // ── saved correspondent photo ──
  async function loadPerson() {
    try {
      const d = await call('person_get');
      if (!d.person) return;
      st.person = d.person;
      $('fw-pname').value = d.person.name || ''; $('fw-prole').value = d.person.role || '';
      $('fw-person-thumb').src = d.person.url; $('fw-person-thumb').style.display = '';
      st.personImg = await loadImg(d.person.url);
      redraw();
    } catch (e) { /* no saved photo yet */ }
  }
  async function savePerson() {
    if (!st.personNew && !st.person) { toast('⚠️ Please choose a photo first.', 'error'); return; }
    try {
      if (typeof showLoading === 'function') showLoading('Saving photo…');
      const d = await call('person', { data_url: st.personNew || '', name: $('fw-pname').value.trim(), role: $('fw-prole').value.trim() });
      st.person = d.person; st.personNew = '';
      toast('Saved. It will be ready for every festival.');
    } catch (e) { toast('⚠️ ' + e.message, 'error'); }
    if (typeof hideLoading === 'function') hideLoading();
  }
  async function removePerson() {
    if (!st.person) { st.personImg = null; st.personNew = ''; $('fw-person-thumb').style.display = 'none'; redraw(); return; }
    if (!window.confirm('Remove the saved photo?')) return;
    try {
      await call('person_remove');
      st.person = null; st.personImg = null; st.personNew = '';
      $('fw-person-thumb').style.display = 'none'; $('fw-pname').value = ''; $('fw-prole').value = '';
      toast('Removed.'); redraw();
    } catch (e) { toast('⚠️ ' + e.message, 'error'); }
  }

  // ── drawing the preview ──
  function currentState(logo) {
    return {
      design: st.design, designing: !!st.designing, size: st.size,
      art: st.pic === 'ai' ? st.art : st.pic === 'own' ? st.own : null,
      withPerson: st.withPerson, personImg: st.personImg,
      personName: $('fw-pname') ? $('fw-pname').value.trim() : '', personRole: $('fw-prole') ? $('fw-prole').value.trim() : '',
      ta: st.ta, en: st.en, msg: st.msg, from: st.from, showPhone: st.phone,
      school: cfg.school, logo
    };
  }
  function redraw() {
    clearTimeout(drawTimer);
    drawTimer = setTimeout(async () => {
      await fontsReady();
      const logo = await getLogo();
      const c = $('fw-canvas'); if (!c) return;
      drawPoster(c, currentState(logo));
      const notes = [];
      if (!cfg.logoUrl) notes.push('⚠️ No school logo found — add it in I-Card → Settings.');
      if (st.withPerson && !st.personImg) notes.push('Add the correspondent / principal photo to show it.');
      if (st.pic === 'own' && !st.own) notes.push('Choose your picture above.');
      $('fw-note').textContent = notes.join(' ');
    }, 120);
  }
  function setButtons() {
    ['fw-add', 'fw-share', 'fw-dl', 'fw-next'].forEach(id => { const b = $(id); if (b) b.disabled = busy; });
  }
  function fileName() {
    const n = String(cfg.school.name || 'school').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return n + '-' + st.fest + (st.size === 'status' ? '-status' : '') + '.jpg';
  }
  async function finalPoster() {
    await fontsReady();
    const c = document.createElement('canvas');
    drawPoster(c, currentState(await getLogo()));
    try { return toJpeg(c); }
    catch (e) { throw new Error('Could not make the picture (one of the pictures did not allow it). Please choose the picture again.'); }
  }
  async function download() {
    try {
      const d = await finalPoster();
      const a = document.createElement('a'); a.href = d; a.download = fileName(); document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { toast('⚠️ ' + e.message, 'error'); }
  }
  async function share() {
    try {
      const d = await finalPoster();
      const blob = await (await fetch(d)).blob();
      const file = new File([blob], fileName(), { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: [st.ta, st.en].filter(Boolean).join('\n') });
      } else {
        await download();
        toast('Downloaded. Sharing works on a phone — on a computer, send the downloaded picture.');
      }
    } catch (e) { if (e && e.name !== 'AbortError') toast('⚠️ ' + e.message, 'error'); }
  }
  function tagOf(s) { const t = String(s || '').replace(/[^A-Za-z0-9]/g, ''); return t ? '#' + t : ''; }
  async function addToReady() {
    if (busy) return;
    if (!st.ta && !st.en) { toast('⚠️ Please type the wishes first.', 'error'); return; }
    busy = true; setButtons();
    try {
      if (typeof showLoading === 'function') showLoading('Saving the poster…');
      const d = await finalPoster();
      const f = festOf(st.fest);
      const school = cfg.school.name || '';
      const en = [st.en ? st.en + '! 🪔' : '', st.msg, '— ' + (st.from || 'All of us') + (school ? ', ' + school : '')].filter(Boolean).join('\n');
      await call('post', {
        data_url: d,
        title: (f.key === 'other' ? (st.en || 'Festival') : f.name) + ' wishes',
        caption_en: en, caption_ta: st.ta,
        hashtags: [tagOf(st.en), tagOf(school), tagOf(cfg.school.city)].filter(Boolean).join(' ')
      });
      if (typeof hideLoading === 'function') hideLoading();
      toast('✓ Added to "Ready to Post".');
      if (typeof loadPosts === 'function') await loadPosts();
      if (typeof switchTab === 'function') switchTab('ready');
    } catch (e) {
      if (typeof hideLoading === 'function') hideLoading();
      toast('⚠️ ' + e.message, 'error');
    }
    busy = false; setButtons();
  }

  window.FW = {
    FESTIVALS,
    drawPoster,
    drawFull,
    init(o) {
      cfg = Object.assign(cfg, o || {}); cfg.school = Object.assign({ name: '', city: '', phone: '' }, (o && o.school) || {}); logoImg = null;
      // Opened from the dashboard's "poster is ready" card (…/social-posts.html#festival)
      if (location.hash === '#festival') setTimeout(() => {
        const t = document.querySelector('.tab[data-tab="festival"]');
        if (t && !t.classList.contains('hidden') && typeof switchTab === 'function') switchTab('festival');
      }, 0);
    },
    async open() {
      if (!built) { build(); redraw(); await loadToday(); if (st.pic === 'ai') await loadArt(); }
      redraw();
    }
  };
})();
