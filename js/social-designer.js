// DigiSmart ERP — Social Media Posts designer
// Makes designed pictures and photo-slideshow Reels in the browser (no server cost):
//   SD.framed(url, title)            → JPEG data URL, 1080×1350, photo + school band
//   SD.collage(urls, title, date)    → JPEG data URL, 1080×1350, 1–6 photos in one designed tile
//   SD.reel(urls, opts)              → MP4 Blob, 720×1280 Reel with music (H.264 + AAC)
//   SD.reelSupport()                 → { ok, reason }
//   SD.clip(file, opts)              → a teacher's class video, shrunk to Reel size with the school logo (H.264 + AAC)
//   SD.frames(seconds, draw, opts)   → MP4 Blob, 720×1280 Reel drawn frame by frame by the caller (Daily Posters), with music
// Needs: mp4-muxer (window.Mp4Muxer) for Reels. Brand colours: maroon, gold, sandal.

(function () {
  const MAROON = '#6B1A1A', MAROON_DARK = '#3E0D0D', GOLD = '#C9A84C', GOLD_LIGHT = '#E8C96A', SANDAL = '#F5E6C8';
  const FONT = '"Poppins", "Segoe UI", "Noto Sans", Arial, sans-serif';
  let cfg = { logoUrl: '', school: { name: '', city: '', phone: '' } };
  let logoImg = null;

  function loadImg(src) {
    return new Promise((ok, bad) => {
      const i = new Image(); i.crossOrigin = 'anonymous';
      i.onload = () => ok(i); i.onerror = () => bad(new Error('Could not load a photo.'));
      i.src = src;
    });
  }
  async function getLogo() {
    if (!cfg.logoUrl) return null;
    if (!logoImg) { try { logoImg = await loadImg(cfg.logoUrl); } catch (e) { logoImg = null; } }
    return logoImg;
  }
  async function fontsReady() {
    try { await Promise.all(['500 30px Poppins', '600 30px Poppins', '700 30px Poppins'].map(f => document.fonts.load(f))); } catch (e) {}
  }
  function initials(name) {
    const w = String(name || 'School').replace(/[^A-Za-z\s]/g, ' ').trim().split(/\s+/);
    return (w[0] && w[0].length <= 4 && w[0] === w[0].toUpperCase() ? w[0] : w.slice(0, 2).map(x => x[0]).join('')).toUpperCase();
  }

  // Keep designed pictures under the upload limit (~820 KB)
  function toJpeg(c) {
    let q = 0.9, d = c.toDataURL('image/jpeg', q);
    while (d.length * 0.75 > 820 * 1024 && q > 0.5) { q -= 0.08; d = c.toDataURL('image/jpeg', q); }
    return d;
  }

  // ── drawing helpers ──
  function rr(x, X, Y, W, H, R) {
    x.beginPath();
    if (x.roundRect) x.roundRect(X, Y, W, H, R); else x.rect(X, Y, W, H);
  }
  // Fit text into a width by shrinking the font; ellipsis as a last resort
  function fitText(x, text, maxW, size, weight, minSize) {
    text = String(text || '');
    let s = size;
    for (; s > (minSize || 14); s -= 2) {
      x.font = weight + ' ' + s + 'px ' + FONT;
      if (x.measureText(text).width <= maxW) return s;
    }
    x.font = weight + ' ' + s + 'px ' + FONT;
    while (text.length > 3 && x.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return { size: s, text: text + '…' };
  }
  function drawFitted(x, text, X, Y, maxW, size, weight, color, align, minSize) {
    const r = fitText(x, text, maxW, size, weight, minSize);
    x.fillStyle = color; x.textAlign = align || 'left'; x.textBaseline = 'middle';
    x.fillText(typeof r === 'object' ? r.text : String(text || ''), X, Y);
  }
  // Two-line wrap for titles
  function wrap2(x, text, maxW, size, weight) {
    x.font = weight + ' ' + size + 'px ' + FONT;
    const words = String(text || '').split(/\s+/); const lines = [''];
    for (const w of words) {
      const t = (lines[lines.length - 1] + ' ' + w).trim();
      if (x.measureText(t).width <= maxW || !lines[lines.length - 1]) lines[lines.length - 1] = t;
      else if (lines.length < 2) lines.push(w);
      else { lines[1] = lines[1] + ' ' + w; }
    }
    return lines;
  }
  // Photo into a box: cover (fill, crop) or contain (whole photo, blurred fill behind)
  function drawCover(x, img, X, Y, W, H, focusY) {
    const s = Math.max(W / img.width, H / img.height);
    const w = img.width * s, h = img.height * s;
    const fy = focusY == null ? 0.42 : focusY;            // keep faces (usually upper half) in view
    x.drawImage(img, X + (W - w) / 2, Y + (H - h) * fy, w, h);
  }
  function drawContainBlur(x, img, X, Y, W, H) {
    x.save(); rr(x, X, Y, W, H, 0); x.clip();
    try { x.filter = 'blur(26px) brightness(0.85)'; drawCover(x, img, X - 30, Y - 30, W + 60, H + 60, 0.5); x.filter = 'none'; } catch (e) {}
    const s = Math.min(W / img.width, H / img.height);
    x.drawImage(img, X + (W - img.width * s) / 2, Y + (H - img.height * s) / 2, img.width * s, img.height * s);
    x.restore();
  }
  function logoBadge(x, logo, cx, cy, r) {
    x.save();
    x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = r * 0.25;
    x.fillStyle = '#fff'; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    x.restore();
    x.strokeStyle = GOLD; x.lineWidth = Math.max(2, r * 0.07); x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
    if (logo) {
      const s = Math.min((r * 1.62) / logo.width, (r * 1.62) / logo.height);
      x.drawImage(logo, cx - logo.width * s / 2, cy - logo.height * s / 2, logo.width * s, logo.height * s);
    } else {
      x.fillStyle = MAROON; x.font = '700 ' + Math.round(r * 0.62) + 'px ' + FONT; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(initials(cfg.school.name), cx, cy + 1);
    }
  }
  function schoolBand(x, logo, X, Y, W, H, subtitle) {
    const g = x.createLinearGradient(X, Y, X + W, Y + H);
    g.addColorStop(0, MAROON); g.addColorStop(1, MAROON_DARK);
    x.fillStyle = g; x.fillRect(X, Y, W, H);
    x.fillStyle = GOLD; x.fillRect(X, Y, W, Math.max(4, H * 0.025));
    const r = H * 0.34, cx = X + H * 0.5, cy = Y + H * 0.52;
    logoBadge(x, logo, cx, cy, r);
    const tx = cx + r + H * 0.2, tw = X + W - tx - H * 0.18;
    const sch = cfg.school;
    drawFitted(x, sch.name || 'Our School', tx, Y + H * 0.33, tw, Math.round(H * 0.2), '700', GOLD_LIGHT, 'left', 18);
    if (subtitle) drawFitted(x, subtitle, tx, Y + H * 0.58, tw, Math.round(H * 0.14), '600', '#fff', 'left', 14);
    const info = [sch.city, sch.phone && ('📞 ' + sch.phone)].filter(Boolean).join('   ·   ');
    if (info) drawFitted(x, info, tx, Y + H * 0.8, tw, Math.round(H * 0.11), '500', SANDAL, 'left', 12);
  }

  // ── 1. Framed photo (1080×1350) ──
  async function framed(url, title) {
    await fontsReady();
    const [img, logo] = await Promise.all([loadImg(url), getLogo()]);
    const W = 1080, H = 1350, band = 250, m = 26;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = SANDAL; x.fillRect(0, 0, W, H);
    x.save(); rr(x, m, m, W - m * 2, H - band - m * 2, 22); x.clip();
    drawContainBlur(x, img, m, m, W - m * 2, H - band - m * 2);
    x.restore();
    x.strokeStyle = 'rgba(201,168,76,.8)'; x.lineWidth = 3; rr(x, m, m, W - m * 2, H - band - m * 2, 22); x.stroke();
    schoolBand(x, logo, 0, H - band, W, band, title);
    return toJpeg(c);
  }

  // ── 2. Collage (1080×1350) ──
  function cells(n, X, Y, W, H, g, landscape) {
    const out = [];
    const rows = (counts) => {
      const rh = (H - g * (counts.length - 1)) / counts.length;
      counts.forEach((k, ri) => {
        const cw = (W - g * (k - 1)) / k;
        for (let i = 0; i < k; i++) out.push([X + i * (cw + g), Y + ri * (rh + g), cw, rh]);
      });
    };
    if (n === 1) out.push([X, Y, W, H]);
    else if (n === 2) { if (landscape) rows([1, 1]); else rows([2]); }
    else if (n === 3) {
      const th = (H - g) * 0.58;
      out.push([X, Y, W, th]);
      const bw = (W - g) / 2;
      out.push([X, Y + th + g, bw, H - th - g], [X + bw + g, Y + th + g, bw, H - th - g]);
    }
    else if (n === 4) rows([2, 2]);
    else if (n === 5) rows([2, 3]);
    else rows([2, 2, 2]);
    return out;
  }
  async function collage(urls, title, dateText) {
    await fontsReady();
    const list = urls.slice(0, 6);
    const imgs = await Promise.all(list.map(loadImg));
    const logo = await getLogo();
    const W = 1080, H = 1350, top = 170, band = 210, m = 24, g = 12;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = SANDAL; x.fillRect(0, 0, W, H);
    // header
    const hg = x.createLinearGradient(0, 0, W, top);
    hg.addColorStop(0, MAROON_DARK); hg.addColorStop(1, MAROON);
    x.fillStyle = hg; x.fillRect(0, 0, W, top);
    x.fillStyle = GOLD; x.fillRect(0, top - 6, W, 6);
    const lines = wrap2(x, title || 'Moments at our school', W - 120, 50, '700');
    if (lines.length > 1) {
      drawFitted(x, lines[0], W / 2, top * 0.36, W - 100, 46, '700', '#fff', 'center', 26);
      drawFitted(x, lines[1], W / 2, top * 0.66, W - 100, 46, '700', '#fff', 'center', 26);
    } else {
      drawFitted(x, lines[0], W / 2, top * 0.42, W - 100, 54, '700', '#fff', 'center', 26);
      if (dateText) drawFitted(x, dateText, W / 2, top * 0.74, W - 100, 28, '500', GOLD_LIGHT, 'center', 16);
    }
    // photos
    const avg = imgs.reduce((a, i) => a + i.width / i.height, 0) / imgs.length;
    const boxes = cells(imgs.length, m, top + m, W - m * 2, H - top - band - m * 2, g, avg > 1.15);
    boxes.forEach((b, i) => {
      x.save(); x.shadowColor = 'rgba(0,0,0,.18)'; x.shadowBlur = 10;
      x.fillStyle = '#fff'; rr(x, b[0], b[1], b[2], b[3], 18); x.fill(); x.restore();
      x.save(); rr(x, b[0] + 5, b[1] + 5, b[2] - 10, b[3] - 10, 14); x.clip();
      drawCover(x, imgs[i], b[0] + 5, b[1] + 5, b[2] - 10, b[3] - 10);
      x.restore();
    });
    schoolBand(x, logo, 0, H - band, W, band, 'Learning · Growing · Celebrating');
    return toJpeg(c);
  }

  // ── 3. Reel (720×1280, 30 fps, H.264 + AAC in MP4) ──
  const RW = 720, RH = 1280, FPS = 30;
  const VIDEO_CODECS = ['avc1.4d401f', 'avc1.42001f', 'avc1.640028'];
  async function pickVideoCodec() {
    const test = (window.__SD_TEST_VIDEO_CODECS || VIDEO_CODECS);
    for (const codec of test) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec, width: RW, height: RH, bitrate: 2500000, framerate: FPS });
        if (r.supported) return codec;
      } catch (e) {}
    }
    return null;
  }
  async function pickAudioCodec() {
    const test = (window.__SD_TEST_AUDIO_CODECS || ['mp4a.40.2']);
    for (const codec of test) {
      try {
        const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: 44100, numberOfChannels: 2, bitrate: 128000 });
        if (r.supported) return codec;
      } catch (e) {}
    }
    return null;
  }
  async function reelSupport(withMusic) {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return { ok: false, reason: 'This browser cannot make videos. Please use Google Chrome (updated) on a laptop or Android phone.' };
    if (typeof Mp4Muxer === 'undefined') return { ok: false, reason: 'The video maker did not load. Check the internet and refresh the page.' };
    if (!(await pickVideoCodec())) return { ok: false, reason: 'This browser cannot make Instagram videos (H.264). Please use Google Chrome on a Windows laptop or Android phone.' };
    if (withMusic && (typeof AudioEncoder === 'undefined' || !(await pickAudioCodec()))) return { ok: false, reason: 'This browser cannot add music to videos. Please use Google Chrome on a Windows laptop or Android phone, or choose "No music".' };
    return { ok: true };
  }

  const ease = t => t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3);
  // Pre-render each photo once (blurred backdrop + framed photo) so every frame draws fast
  function preparePhoto(img) {
    const bg = document.createElement('canvas'); bg.width = RW; bg.height = RH;
    const b = bg.getContext('2d');
    try { b.filter = 'blur(30px) brightness(0.72)'; drawCover(b, img, -40, -40, RW + 80, RH + 80, 0.5); b.filter = 'none'; }
    catch (e) { b.fillStyle = MAROON_DARK; b.fillRect(0, 0, RW, RH); }
    return { img, bg };
  }
  function drawIntro(x, t, d, logo, title, dateText) {
    const g = x.createRadialGradient(RW / 2, RH * 0.42, 40, RW / 2, RH * 0.45, RH * 0.75);
    g.addColorStop(0, MAROON); g.addColorStop(1, MAROON_DARK);
    x.fillStyle = g; x.fillRect(0, 0, RW, RH);
    // soft gold rays
    x.save(); x.globalAlpha = 0.08; x.translate(RW / 2, RH * 0.38); x.rotate(t * 0.15);
    x.fillStyle = GOLD_LIGHT;
    for (let i = 0; i < 12; i++) { x.rotate(Math.PI / 6); x.beginPath(); x.moveTo(0, 0); x.lineTo(-40, -RH); x.lineTo(40, -RH); x.fill(); }
    x.restore();
    const k = ease(t / 0.8);
    logoBadge(x, logo, RW / 2, RH * 0.36, 110 * (0.6 + 0.4 * k));
    x.globalAlpha = ease((t - 0.35) / 0.6);
    drawFitted(x, cfg.school.name || 'Our School', RW / 2, RH * 0.51, RW - 80, 46, '700', GOLD_LIGHT, 'center', 22);
    x.globalAlpha = ease((t - 0.7) / 0.6);
    const lines = wrap2(x, title || 'Moments at our school', RW - 100, 40, '600');
    lines.forEach((l, i) => drawFitted(x, l, RW / 2, RH * 0.6 + i * 50, RW - 90, 40, '600', '#fff', 'center', 20));
    if (dateText) drawFitted(x, dateText, RW / 2, RH * 0.6 + lines.length * 50 + 14, RW - 90, 26, '500', SANDAL, 'center', 14);
    x.globalAlpha = 1;
  }
  function drawPhotoScene(x, ph, t, d, idx, logo, title) {
    x.drawImage(ph.bg, 0, 0);
    const img = ph.img;
    const boxW = RW - 48, boxH = RH * 0.66, boxY = RH * 0.13;
    const z = 1 + 0.07 * (t / d);                              // slow zoom
    const pan = (idx % 2 ? -1 : 1) * 18 * (t / d - 0.5);        // gentle side drift
    const s = Math.min(boxW / img.width, boxH / img.height) * z;
    const w = img.width * s, h = img.height * s;
    x.save();
    x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 30;
    rr(x, (RW - Math.min(w, boxW)) / 2 - 6, boxY + (boxH - Math.min(h, boxH)) / 2 - 6, Math.min(w, boxW) + 12, Math.min(h, boxH) + 12, 18);
    x.fillStyle = '#fff'; x.fill();
    x.restore();
    x.save();
    rr(x, (RW - Math.min(w, boxW)) / 2, boxY + (boxH - Math.min(h, boxH)) / 2, Math.min(w, boxW), Math.min(h, boxH), 14); x.clip();
    x.drawImage(img, (RW - w) / 2 + pan, boxY + (boxH - h) / 2, w, h);
    x.restore();
    // top: logo + school name
    logoBadge(x, logo, 64, 62, 34);
    drawFitted(x, cfg.school.name || '', 112, 62, RW - 140, 28, '700', '#fff', 'left', 16);
    // bottom: title ribbon
    const by = RH * 0.83;
    x.fillStyle = 'rgba(62,13,13,.88)'; rr(x, 36, by, RW - 72, 110, 22); x.fill();
    x.fillStyle = GOLD; x.fillRect(60, by + 12, 6, 86);
    const lines = wrap2(x, title || '', RW - 150, 32, '600');
    lines.forEach((l, i) => drawFitted(x, l, 84, by + (lines.length > 1 ? 36 + i * 40 : 55), RW - 150, 32, '600', '#fff', 'left', 18));
  }
  function drawOutro(x, t, d, logo) {
    const g = x.createLinearGradient(0, 0, 0, RH);
    g.addColorStop(0, MAROON_DARK); g.addColorStop(1, MAROON);
    x.fillStyle = g; x.fillRect(0, 0, RW, RH);
    const k = ease(t / 0.7);
    logoBadge(x, logo, RW / 2, RH * 0.3, 100 * (0.7 + 0.3 * k));
    x.globalAlpha = ease((t - 0.2) / 0.6);
    drawFitted(x, cfg.school.name || 'Our School', RW / 2, RH * 0.43, RW - 80, 44, '700', GOLD_LIGHT, 'center', 22);
    if (cfg.school.city) drawFitted(x, cfg.school.city, RW / 2, RH * 0.48, RW - 80, 28, '500', SANDAL, 'center', 16);
    x.globalAlpha = ease((t - 0.5) / 0.6);
    x.fillStyle = GOLD; rr(x, RW / 2 - 230, RH * 0.56, 460, 84, 42); x.fill();
    drawFitted(x, '🎓 Admissions Open', RW / 2, RH * 0.56 + 43, 420, 36, '700', MAROON_DARK, 'center', 20);
    if (cfg.school.phone) drawFitted(x, '📞 ' + cfg.school.phone, RW / 2, RH * 0.68, RW - 80, 38, '600', '#fff', 'center', 20);
    drawFitted(x, 'Tap the link in our bio to enquire', RW / 2, RH * 0.75, RW - 80, 28, '500', SANDAL, 'center', 16);
    x.globalAlpha = 1;
  }

  async function decodeMusic(src, seconds) {
    let buf;
    if (src instanceof ArrayBuffer) buf = src;
    else { const r = await fetch(src); if (!r.ok) throw new Error('Could not load the music.'); buf = await r.arrayBuffer(); }
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    let audio;
    try { audio = await ac.decodeAudioData(buf.slice(0)); }
    catch (e) { throw new Error('That music file could not be read. Please use an MP3.'); }
    finally { try { ac.close(); } catch (e) {} }
    // Resample to 44.1 kHz stereo, cut to length, fade in/out
    const len = Math.ceil(seconds * 44100);
    const off = new OfflineAudioContext(2, len, 44100);
    const srcNode = off.createBufferSource(); srcNode.buffer = audio; srcNode.loop = audio.duration < seconds;
    const gain = off.createGain();
    gain.gain.setValueAtTime(0, 0); gain.gain.linearRampToValueAtTime(0.9, 0.4);
    gain.gain.setValueAtTime(0.9, Math.max(0.5, seconds - 1.8)); gain.gain.linearRampToValueAtTime(0, seconds);
    srcNode.connect(gain); gain.connect(off.destination); srcNode.start(0);
    return off.startRendering();
  }

  async function reel(urls, opts) {
    opts = opts || {};
    const withMusic = !!opts.music;
    const sup = await reelSupport(withMusic);
    if (!sup.ok) throw new Error(sup.reason);
    const onProgress = opts.onProgress || function () {};
    await fontsReady();
    onProgress(0, 'Loading photos…');
    const imgs = await Promise.all(urls.slice(0, 10).map(loadImg));
    const logo = await getLogo();
    const photos = imgs.map(preparePhoto);

    const INTRO = 2.4, PHOTO = 2.8, FADE = 0.5, OUTRO = 3.0;
    const dur = INTRO + photos.length * PHOTO + OUTRO;
    const total = Math.round(dur * FPS);
    // timeline: [start, end, draw(x, localT, len)]
    const scenes = [];
    scenes.push([0, INTRO + FADE, (x, t, d) => drawIntro(x, t, d, logo, opts.title, opts.dateText)]);
    photos.forEach((ph, i) => {
      const st = INTRO + i * PHOTO;
      scenes.push([st, st + PHOTO + FADE, (x, t, d) => drawPhotoScene(x, ph, t, d, i, logo, opts.title)]);
    });
    const os = INTRO + photos.length * PHOTO;
    scenes.push([os, dur + 0.01, (x, t, d) => drawOutro(x, t, d, logo)]);

    const canvas = document.createElement('canvas'); canvas.width = RW; canvas.height = RH;
    const x = canvas.getContext('2d');
    const layer = document.createElement('canvas'); layer.width = RW; layer.height = RH;
    const lx = layer.getContext('2d');

    const vcodec = await pickVideoCodec();
    const acodec = withMusic ? await pickAudioCodec() : null;
    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: vcodec.startsWith('avc') ? 'avc' : 'vp9', width: RW, height: RH, frameRate: FPS },
      audio: acodec ? { codec: acodec.startsWith('mp4a') ? 'aac' : 'opus', numberOfChannels: 2, sampleRate: 44100 } : undefined,
      fastStart: 'in-memory',                       // index at the front — what Instagram asks for
      firstTimestampBehavior: 'offset'
    });
    let encErr = null;
    const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { encErr = e; } });
    venc.configure({ codec: vcodec, width: RW, height: RH, bitrate: 2500000, framerate: FPS,
      ...(vcodec.startsWith('avc') ? { avc: { format: 'avc' } } : {}) });

    for (let f = 0; f < total; f++) {
      if (encErr) throw new Error('Video making failed: ' + encErr.message);
      const t = f / FPS;
      const active = scenes.filter(s => t >= s[0] && t < s[1]);
      x.globalAlpha = 1;
      if (active.length) {
        const a = active[0];
        a[2](x, t - a[0], a[1] - a[0]);
        if (active[1]) {                           // cross-fade into the next scene
          const b = active[1];
          const alpha = Math.min(1, (t - b[0]) / FADE);
          lx.globalAlpha = 1; b[2](lx, t - b[0], b[1] - b[0]);
          x.globalAlpha = alpha; x.drawImage(layer, 0, 0); x.globalAlpha = 1;
        }
      }
      const frame = new VideoFrame(canvas, { timestamp: Math.round(f * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      venc.encode(frame, { keyFrame: f % (FPS * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 5));
      if (f % 15 === 0) { onProgress(Math.round(f / total * 85), 'Making the Reel… ' + Math.round(f / total * 100) + '%'); await new Promise(r => setTimeout(r, 0)); }
    }
    await venc.flush(); venc.close();

    if (acodec) {
      onProgress(88, 'Adding music…');
      const audio = await decodeMusic(opts.music, dur);
      const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => { encErr = e; } });
      aenc.configure({ codec: acodec, sampleRate: 44100, numberOfChannels: 2, bitrate: 128000 });
      const L = audio.getChannelData(0), R = audio.getChannelData(1);
      const N = 1024;
      for (let i = 0; i < audio.length; i += N) {
        const n = Math.min(N, audio.length - i);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: 44100, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i * 1e6 / 44100), data });
        aenc.encode(ad); ad.close();
      }
      await aenc.flush(); aenc.close();
      if (encErr) throw new Error('Adding music failed: ' + encErr.message);
    }
    muxer.finalize();
    onProgress(100, 'Reel ready');
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }

  // ── 4. Class video (teacher / principal upload): shrink to Reel size, add the school logo, keep the sound ──
  // SD.clip(file, { corner, onProgress }) → { blob, frames[4 JPEG data URLs], seconds, width, height, sound }
  //   blob is null (with .reason) when this browser cannot remake videos — the page may then send the original.
  // The video plays once, hidden, at normal speed, so a 60-second video takes about a minute.
  const CLIP_MAX_SECONDS = 60, CLIP_FPS = 30, CLIP_BITRATE = 3000000;

  function clipSize(vw, vh) {
    const k = Math.min(1, 1280 / Math.max(vw, vh), 720 / Math.min(vw, vh));
    const even = n => Math.max(2, Math.round(n / 2) * 2);
    return { W: even(vw * k), H: even(vh * k) };
  }
  async function clipSupport(W, H) {
    const no = 'This browser cannot add the logo to videos';
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined' || typeof AudioEncoder === 'undefined') return { ok: false, reason: no + '.' };
    if (typeof Mp4Muxer === 'undefined') return { ok: false, reason: 'The video maker did not load. Check the internet and refresh the page.' };
    let codec = null;
    for (const c of (window.__SD_TEST_VIDEO_CODECS || VIDEO_CODECS)) {
      try { if ((await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, bitrate: CLIP_BITRATE, framerate: CLIP_FPS })).supported) { codec = c; break; } } catch (e) {}
    }
    if (!codec) return { ok: false, reason: no + ' (H.264).' };
    const acodec = await pickAudioCodec();
    if (!acodec) return { ok: false, reason: no + ' with sound.' };
    return { ok: true, codec, acodec };
  }
  // The school logo in a corner on a light badge (same look as on photos)
  function cornerLogo(x, W, H, logo, corner) {
    const side = Math.min(W, H);
    const box = Math.max(28, Math.round(side * 0.14));
    const m = Math.round(side * 0.03);
    const r = logo.width / logo.height;
    const round = r > 0.85 && r < 1.18;
    let bw = box, bh = box;
    if (!round) { if (r > 1) bh = Math.round(box / Math.min(r, 3)); else bw = Math.round(box * Math.max(r, 0.4)); }
    const pad = Math.round(box * 0.08);
    const bx = corner[1] === 'l' ? m : W - m - bw - pad * 2;
    const by = corner[0] === 't' ? m : H - m - bh - pad * 2;
    x.save();
    x.shadowColor = 'rgba(0,0,0,0.30)'; x.shadowBlur = Math.round(box * 0.12); x.shadowOffsetY = Math.round(box * 0.03);
    x.fillStyle = 'rgba(255,255,255,0.94)';
    x.beginPath();
    if (round) x.arc(bx + pad + bw / 2, by + pad + bh / 2, bw / 2 + pad, 0, Math.PI * 2);
    else if (x.roundRect) x.roundRect(bx, by, bw + pad * 2, bh + pad * 2, Math.round(box * 0.14));
    else x.rect(bx, by, bw + pad * 2, bh + pad * 2);
    x.fill();
    x.restore();
    const s = Math.min(bw / logo.width, bh / logo.height);
    const lw = logo.width * s, lh = logo.height * s;
    x.drawImage(logo, bx + pad + (bw - lw) / 2, by + pad + (bh - lh) / 2, lw, lh);
  }
  function openVideo(file) {
    return new Promise((ok, bad) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
      // Kept on the page (almost invisible) — some phones stop decoding videos that are not on the page
      v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
      const url = URL.createObjectURL(file);
      const done = (err) => { if (err) { URL.revokeObjectURL(url); v.remove(); bad(err); } else ok({ v, url }); };
      v.onloadeddata = () => done(null);
      v.onerror = () => done(new Error('This video could not be opened here. If it is from an iPhone, set Settings → Camera → Formats → "Most Compatible" and record again, or send it from an Android phone.'));
      document.body.appendChild(v);
      v.src = url;
    });
  }
  function closeVideo(o) { try { o.v.pause(); o.v.removeAttribute('src'); o.v.load(); } catch (e) {} o.v.remove(); URL.revokeObjectURL(o.url); }
  function stillFrom(v, W, H) {
    const c = document.createElement('canvas');
    const k = Math.min(1, 1280 / Math.max(W, H));
    c.width = Math.round(W * k); c.height = Math.round(H * k);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  }
  function seekTo(v, t) {
    return new Promise((ok, bad) => {
      const tm = setTimeout(() => bad(new Error('The video stopped responding.')), 8000);
      v.onseeked = () => { clearTimeout(tm); v.onseeked = null; ok(); };
      v.currentTime = t;
    });
  }
  async function stills(v, dur, W, H) {
    const out = [];
    for (const f of [0.1, 0.35, 0.6, 0.85]) { await seekTo(v, Math.max(0, Math.min(dur - 0.05, dur * f))); out.push(stillFrom(v, W, H)); }
    return out;
  }
  async function clipAudio(file, seconds) {
    try {
      const buf = await file.arrayBuffer();
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      let audio;
      try { audio = await ac.decodeAudioData(buf); } finally { try { ac.close(); } catch (e) {} }
      const len = Math.max(1, Math.ceil(seconds * 44100));
      const off = new OfflineAudioContext(2, len, 44100);
      const n = off.createBufferSource(); n.buffer = audio; n.connect(off.destination); n.start(0);
      return await off.startRendering();
    } catch (e) { return null; }     // no sound in the video, or it could not be read
  }

  async function clip(file, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    const maxS = opts.maxSeconds || CLIP_MAX_SECONDS;
    onProgress(0, 'Opening the video…');
    const o = await openVideo(file);
    const v = o.v;
    try {
      const dur = v.duration;
      if (!isFinite(dur) || dur <= 0) throw new Error('This video could not be read (its length is unknown). Please try another video.');
      if (dur > maxS + 0.5) throw new Error('This video is ' + Math.round(dur) + ' seconds long. Videos can be at most ' + maxS + ' seconds — please trim it on the phone first (open the video → Edit → trim), then choose it again.');
      if (!v.videoWidth || !v.videoHeight) throw new Error('This file has no picture. Please choose a video.');
      const { W, H } = clipSize(v.videoWidth, v.videoHeight);
      const sup = await clipSupport(W, H);
      if (!sup.ok) {
        onProgress(50, 'Taking pictures for the AI…');
        const frames = await stills(v, dur, W, H);
        return { blob: null, reason: sup.reason, frames, seconds: dur, width: W, height: H, sound: true };
      }
      const logo = opts.corner && opts.corner !== 'off' ? await getLogo() : null;
      const corner = opts.corner && opts.corner !== 'off' ? opts.corner : 'br';

      onProgress(3, 'Reading the sound…');
      const audio = await clipAudio(file, dur);

      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const x = canvas.getContext('2d');
      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: sup.codec.startsWith('avc') ? 'avc' : 'vp9', width: W, height: H, frameRate: CLIP_FPS },
        audio: audio ? { codec: sup.acodec.startsWith('mp4a') ? 'aac' : 'opus', numberOfChannels: 2, sampleRate: 44100 } : undefined,
        fastStart: 'in-memory',                     // index at the front — what Instagram asks for
        firstTimestampBehavior: 'offset'
      });
      let encErr = null;
      const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { encErr = e; } });
      venc.configure({ codec: sup.codec, width: W, height: H, bitrate: CLIP_BITRATE, framerate: CLIP_FPS,
        ...(sup.codec.startsWith('avc') ? { avc: { format: 'avc' } } : {}) });

      // Play once, hidden; every new picture → canvas → logo → encoder
      const want = [0.1, 0.35, 0.6, 0.85].map(f => f * dur);
      const frames = [];
      let lastT = -1, count = 0, lastMove = Date.now();
      const draw = (t) => {
        if (encErr || t <= lastT || (lastT >= 0 && t - lastT < 1 / CLIP_FPS - 0.004)) return;
        x.drawImage(v, 0, 0, W, H);
        while (frames.length < want.length && t >= want[frames.length]) frames.push(stillFrom(canvas, W, H));
        if (logo) cornerLogo(x, W, H, logo, corner);
        if (venc.encodeQueueSize < 40) {        // a slow phone drops a picture rather than falling behind
          const fr = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / CLIP_FPS) });
          venc.encode(fr, { keyFrame: count % (CLIP_FPS * 2) === 0 });
          fr.close();
          count++;
        }
        lastT = t; lastMove = Date.now();
        if (count % 15 === 0) onProgress(5 + Math.round(t / dur * 85), 'Adding the school logo… ' + Math.round(t / dur * 100) + '% (keep this screen open)');
      };
      await new Promise((ok, bad) => {
        let finished = false;
        const end = (err) => { if (finished) return; finished = true; clearInterval(watch); document.removeEventListener('visibilitychange', wake); err ? bad(err) : ok(); };
        const wake = () => { if (!document.hidden && v.paused && !v.ended) v.play().catch(() => {}); };
        document.addEventListener('visibilitychange', wake);
        v.onended = () => end();
        v.onerror = () => end(new Error('The video stopped while being prepared. Please try again.'));
        const watch = setInterval(() => {
          if (encErr) return end(new Error('Video making failed: ' + encErr.message));
          if (v.paused && !v.ended && !document.hidden) v.play().catch(() => {});
          if (Date.now() - lastMove > (document.hidden ? 120000 : 15000)) end(new Error('The video stopped while being prepared. Keep this screen open and try again.'));
        }, 1000);
        if (v.requestVideoFrameCallback) {
          const tick = (now, m) => { draw(m.mediaTime); if (!finished) v.requestVideoFrameCallback(tick); };
          v.requestVideoFrameCallback(tick);
        } else {
          const tick = () => { draw(v.currentTime); if (!finished) requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        }
        (v.currentTime > 0 ? seekTo(v, 0) : Promise.resolve()).catch(() => {}).then(() => v.play()).catch(e => end(new Error('The video could not be played here: ' + e.message)));
      });
      if (encErr) throw new Error('Video making failed: ' + encErr.message);
      if (count < Math.min(10, dur * 5)) throw new Error('The video could not be prepared (too few pictures came through). Keep this screen open and try again.');
      await venc.flush(); venc.close();

      if (audio) {
        onProgress(92, 'Adding the sound…');
        const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => { encErr = e; } });
        aenc.configure({ codec: sup.acodec, sampleRate: 44100, numberOfChannels: 2, bitrate: 128000 });
        const L = audio.getChannelData(0), R = audio.getChannelData(1);
        const N = 1024;
        for (let i = 0; i < audio.length; i += N) {
          const n = Math.min(N, audio.length - i);
          const data = new Float32Array(n * 2);
          data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: 44100, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i * 1e6 / 44100), data });
          aenc.encode(ad); ad.close();
        }
        await aenc.flush(); aenc.close();
        if (encErr) throw new Error('Adding the sound failed: ' + encErr.message);
      }
      muxer.finalize();
      // Pictures for the AI: any the playback skipped are taken now
      if (frames.length < want.length) {
        const more = await stills(v, dur, W, H);
        while (frames.length < want.length) frames.push(more[frames.length]);
      }
      onProgress(100, 'Video ready');
      return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), frames, seconds: dur, width: W, height: H, sound: !!audio };
    } finally { closeVideo(o); }
  }

  // ── 5. A Reel drawn by the caller, frame by frame (used by Daily Posters' animated poster) ──
  //    draw(ctx, t) paints one 720×1280 frame at time t (seconds). Same encoder and music as SD.reel.
  async function frames(seconds, draw, opts) {
    opts = opts || {};
    const withMusic = !!opts.music;
    const sup = await reelSupport(withMusic);
    if (!sup.ok) throw new Error(sup.reason);
    const onProgress = opts.onProgress || function () {};
    const total = Math.round(seconds * FPS);
    const canvas = document.createElement('canvas'); canvas.width = RW; canvas.height = RH;
    const x = canvas.getContext('2d');
    const vcodec = await pickVideoCodec();
    const acodec = withMusic ? await pickAudioCodec() : null;
    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: vcodec.startsWith('avc') ? 'avc' : 'vp9', width: RW, height: RH, frameRate: FPS },
      audio: acodec ? { codec: acodec.startsWith('mp4a') ? 'aac' : 'opus', numberOfChannels: 2, sampleRate: 44100 } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset'
    });
    let encErr = null;
    const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { encErr = e; } });
    venc.configure({ codec: vcodec, width: RW, height: RH, bitrate: 2500000, framerate: FPS,
      ...(vcodec.startsWith('avc') ? { avc: { format: 'avc' } } : {}) });
    for (let f = 0; f < total; f++) {
      if (encErr) throw new Error('Video making failed: ' + encErr.message);
      x.save(); draw(x, f / FPS); x.restore();
      const frame = new VideoFrame(canvas, { timestamp: Math.round(f * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      venc.encode(frame, { keyFrame: f % (FPS * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 5));
      if (f % 15 === 0) { onProgress(Math.round(f / total * 85), 'Making the Reel… ' + Math.round(f / total * 100) + '%'); await new Promise(r => setTimeout(r, 0)); }
    }
    await venc.flush(); venc.close();
    if (acodec) {
      onProgress(88, 'Adding music…');
      const audio = await decodeMusic(opts.music, seconds);
      const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => { encErr = e; } });
      aenc.configure({ codec: acodec, sampleRate: 44100, numberOfChannels: 2, bitrate: 128000 });
      const L = audio.getChannelData(0), R = audio.getChannelData(1);
      const N = 1024;
      for (let i = 0; i < audio.length; i += N) {
        const n = Math.min(N, audio.length - i);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: 44100, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i * 1e6 / 44100), data });
        aenc.encode(ad); ad.close();
      }
      await aenc.flush(); aenc.close();
      if (encErr) throw new Error('Adding music failed: ' + encErr.message);
    }
    muxer.finalize();
    onProgress(100, 'Reel ready');
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }

  window.SD = {
    init(o) { cfg = Object.assign(cfg, o || {}); if (o && 'logoUrl' in o) logoImg = null; },
    framed, collage, reel, reelSupport, clip, CLIP_MAX_SECONDS, frames, REEL_W: RW, REEL_H: RH,
    MUSIC: [
      { id: 'happy-morning', name: '☀️ Happy Morning (upbeat)' },
      { id: 'festival-joy', name: '🪔 Festival Joy (Indian festive)' },
      { id: 'proud-moments', name: '🏆 Proud Moments (inspiring)' },
      { id: 'calm-learning', name: '📖 Calm Learning (soft piano)' }
    ]
  };
})();
