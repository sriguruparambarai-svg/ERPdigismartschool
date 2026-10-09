// DigiSmart Parent App — "Install the app" help card
// Shows a card that helps parents put the Parent App on their phone's home
// screen. Hidden once the app is installed. Explains WhatsApp / iPhone steps
// in English and Tamil. Used by parent/index.html and parent/dashboard.html.
(function () {
  var deferred = null;
  var ua = navigator.userAgent || '';
  function isInstalled() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function isIphone() { return /iphone|ipad|ipod/i.test(ua); }
  function isAndroid() { return /android/i.test(ua); }
  // WhatsApp, Facebook, Instagram etc. open links inside their own small browser
  function inAppBrowser() { return /WhatsApp|FBAN|FBAV|FB_IAB|Instagram|; wv\)/i.test(ua); }
  function dismissedRecently() {
    try { var t = +localStorage.getItem('parent_install_later') || 0; return Date.now() - t < 3 * 24 * 3600 * 1000; } catch (e) { return false; }
  }
  function chromeLink() {
    var path = location.pathname;
    var q = location.search;
    if (/dashboard/.test(path)) {
      var sid = '';
      try { sid = sessionStorage.getItem('parent_school_id') || localStorage.getItem('parent_school_id') || ''; } catch (e) {}
      path = '/parent/index.html'; q = sid ? '?school=' + encodeURIComponent(sid) : '';
    }
    return 'intent://' + location.host + path + q + '#Intent;scheme=https;package=com.android.chrome;end';
  }
  var css = '.ih-card{background:#FFF8EC;border:1.5px solid #C9A84C;border-radius:14px;padding:13px 14px;margin:0 0 14px;color:#3A2A1A;font-size:13px;line-height:1.55;max-width:420px;width:100%;box-sizing:border-box}'
    + '.ih-top{display:flex;align-items:center;gap:10px}.ih-ico{width:40px;height:40px;border-radius:10px;flex-shrink:0}'
    + '.ih-t{font-weight:700;color:#6B1A1A;font-size:14px}.ih-s{font-size:12px;color:#6B6560}'
    + '.ih-btns{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}'
    + '.ih-btn{background:#6B1A1A;color:#fff;border:none;border-radius:10px;padding:9px 14px;font-weight:700;font-size:13px;cursor:pointer;text-decoration:none;display:inline-block}'
    + '.ih-later{background:none;border:none;color:#8A7F75;font-size:12px;cursor:pointer;padding:9px 6px}'
    + '.ih-steps{margin-top:10px;background:#fff;border-radius:10px;padding:9px 11px;font-size:12.5px;line-height:1.75}'
    + '.ih-ta{color:#6B6560;font-size:12px}';
  function steps() {
    if (isIphone()) {
      return '<div class="ih-steps">1. Open this page in <b>Safari</b><br>2. Tap the <b>Share</b> button (square with arrow ↑)<br>3. Tap <b>Add to Home Screen</b>, then <b>Add</b>'
        + '<div class="ih-ta">Safari-ல் திறந்து, Share (↑) பொத்தானை அழுத்தி, "Add to Home Screen" தேர்வு செய்யவும்.</div></div>';
    }
    if (inAppBrowser()) {
      return '<div class="ih-steps">You opened this inside WhatsApp. Apps can be installed only from Chrome.<br>'
        + '1. Tap the <b>Open in Chrome</b> button above (or tap <b>⋮</b> at the top → <b>Open in Chrome</b>)<br>2. In Chrome, tap <b>⋮</b> → <b>Install app</b> or <b>Add to Home screen</b>'
        + '<div class="ih-ta">WhatsApp-க்குள் app நிறுவ முடியாது. மேலே உள்ள "Open in Chrome" அழுத்தி, Chrome-ல் ⋮ → "Install app" / "Add to Home screen" தேர்வு செய்யவும்.</div></div>';
    }
    return '<div class="ih-steps">1. Tap <b>⋮</b> (three dots) at the top right of Chrome<br>2. Tap <b>Install app</b> or <b>Add to Home screen</b><br>3. Open the app from your home screen next time — not from WhatsApp'
      + '<div class="ih-ta">Chrome-ல் மேலே உள்ள ⋮ அழுத்தி "Install app" / "Add to Home screen" தேர்வு செய்யவும். அடுத்த முறை Home screen-ல் உள்ள app-ஐ திறக்கவும்.</div></div>';
  }
  function render() {
    var box = document.getElementById('install-help');
    if (!box) return;
    var old = document.getElementById('install-banner');
    if (old) old.style.display = 'none';
    if (isInstalled()) { box.innerHTML = ''; box.style.display = 'none'; return; }
    var onDash = /dashboard/.test(location.pathname);
    if (onDash && dismissedRecently() && !inAppBrowser()) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = 'block';
    var btns = '';
    if (deferred) btns += '<button class="ih-btn" id="ih-install">📲 Install app</button>';
    else if (isAndroid() && inAppBrowser()) btns += '<a class="ih-btn" href="' + chromeLink() + '">Open in Chrome</a>';
    else btns += '<button class="ih-btn" id="ih-how">Show me how</button>';
    if (onDash) btns += '<button class="ih-later" id="ih-later">Not now</button>';
    var open = inAppBrowser() && !deferred;
    box.innerHTML = '<div class="ih-card"><div class="ih-top"><img class="ih-ico" src="/assets/icons/parent-192.png" alt="">'
      + '<div><div class="ih-t">Get the Parent App on your phone</div>'
      + '<div class="ih-s">Opens in one tap from your home screen and stays logged in. செயலியை உங்கள் போனில் நிறுவுங்கள்.</div></div></div>'
      + '<div class="ih-btns">' + btns + '</div><div id="ih-steps" style="display:' + (open ? 'block' : 'none') + '">' + steps() + '</div></div>';
    var b = document.getElementById('ih-install');
    if (b) b.onclick = async function () {
      if (!deferred) return;
      deferred.prompt();
      try { var r = await deferred.userChoice; if (r && r.outcome === 'accepted') { box.style.display = 'none'; } } catch (e) {}
      deferred = null;
    };
    var h = document.getElementById('ih-how');
    if (h) h.onclick = function () { var s = document.getElementById('ih-steps'); s.style.display = s.style.display === 'none' ? 'block' : 'none'; };
    var l = document.getElementById('ih-later');
    if (l) l.onclick = function () { try { localStorage.setItem('parent_install_later', String(Date.now())); } catch (e) {} box.style.display = 'none'; };
  }
  var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; render(); });
  window.addEventListener('appinstalled', function () { var box = document.getElementById('install-help'); if (box) box.style.display = 'none'; });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
