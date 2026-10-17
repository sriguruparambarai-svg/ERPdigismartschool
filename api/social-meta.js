// DigiSmart ERP — Facebook & Instagram connection for Social Media Posts (Step B)
//
// Vercel environment variables (set by the DigiSmart owner):
//   META_APP_ID, META_APP_SECRET   — from the Meta app "DigiSmart Social Posts"
//   META_CONFIG_ID (optional)      — Facebook Login for Business configuration id
//   META_GRAPH_VERSION (optional)  — defaults to v25.0
//
// The page tokens are kept ONLY in social_settings (RLS on, no public access)
// and never sent to a browser.
//
// GET  /api/social-meta?code=…&state=…    ← Facebook sends the principal back here after login
// POST { token, action: 'start' }        → { ok, url }   (open this to log in with Facebook)
// POST { token, action: 'status' }       → { ok, connected, page_name, ig_username, pending:[{id,name,ig}] }
// POST { token, action: 'choose', page_id }  → save the chosen page (when you manage several)
// POST { token, action: 'disconnect' }
// POST { token, action: 'publish', id, to_fb, to_ig, ig_photos[] }  → posts an approved post

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const GRAPH_VER = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH = 'https://graph.facebook.com/' + GRAPH_VER;
const BUCKET = 'social-posts';
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts',
                'instagram_basic', 'instagram_content_publish', 'business_management'];

function getServiceKey() { return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''; }
function appId() { return process.env.META_APP_ID || ''; }
function appSecret() { return process.env.META_APP_SECRET || ''; }

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
// Only the owner / principal (social full access) may connect accounts or post
function isFull(session) {
  if (!session || session.role === 'parent') return false;
  if (session.role !== 'staff') return true;
  return (Array.isArray(session.mods) ? session.mods : []).some(m => {
    const p = String(m).split(':'); return p[0] === 'social' && p[1] !== 'upload';
  });
}

// A short-lived signed note that says which school started the Facebook login
function makeState(sid) {
  const p = Buffer.from(JSON.stringify({ sid, exp: Date.now() + 15 * 60000, n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', getServiceKey()).update('meta-state:' + p).digest('hex');
}
function readState(s) {
  try {
    const [p, sig] = String(s || '').split('.');
    if (!p || crypto.createHmac('sha256', getServiceKey()).update('meta-state:' + p).digest('hex') !== sig) return null;
    const d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return Date.now() > d.exp ? null : d;
  } catch (e) { return null; }
}

async function sb(method, path, bodyObj, extra) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' }, extra || {}),
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!r.ok) {
    const msg = (data && data.message) || ('Database error ' + r.status);
    if (/meta_|fb_post_id|ig_media_id/.test(msg) && /does not exist|schema cache|not find/i.test(msg)) {
      throw new Error('The Facebook connection is not set up yet. Please run the Step B SQL in Supabase once.');
    }
    throw new Error(msg);
  }
  return data;
}

// Graph API call: GET with query, or POST with form fields
async function graph(method, path, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const r = method === 'GET'
    ? await fetch(GRAPH + path + (qs ? '?' + qs : ''))
    : await fetch(GRAPH + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) {}
  if (!r.ok || (data && data.error)) {
    const e = (data && data.error) || {};
    throw new Error((e.error_user_msg || e.message || ('Facebook error ' + r.status)).slice(0, 300));
  }
  return data;
}

function redirectUri(req) {
  return process.env.META_REDIRECT_URI || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host) + '/api/social-meta');
}
function back(res, req, hash) {
  res.statusCode = 302;
  res.setHeader('Location', 'https://' + (req.headers['x-forwarded-host'] || req.headers.host) + '/pages/social-posts.html#' + hash);
  res.end();
}
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function isId(v) { return /^[a-zA-Z0-9-]{1,64}$/.test(String(v || '')); }
function isPhotoUrl(u, sid) {
  const marker = SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + sid + '/';
  return typeof u === 'string' && u.startsWith(marker) && !/\s|\.\./.test(u);
}

async function settingsRow(sid) {
  return ((await sb('GET', 'social_settings?school_id=eq.' + encodeURIComponent(sid) + '&select=*&limit=1')) || [])[0] || null;
}
async function saveSettings(sid, patch) {
  await sb('POST', 'social_settings?on_conflict=school_id', Object.assign({ school_id: sid, updated_at: new Date().toISOString() }, patch),
    { Prefer: 'resolution=merge-duplicates,return=representation' });
}

// The same post text the principal sees in "Ready to Post"
function postText(p, s) {
  const parts = [];
  if (p.caption_en) parts.push(p.caption_en);
  if (p.caption_ta) parts.push(p.caption_ta);
  const footer = s && s.footer_line != null ? s.footer_line : '📢 Admissions open! Tap the link in our bio to enquire.';
  if (footer) parts.push(footer);
  const tags = [p.hashtags, s && s.hashtags].filter(Boolean).join(' ').trim();
  if (tags) parts.push(Array.from(new Set(tags.split(/\s+/))).slice(0, 30).join(' '));
  return parts.join('\n\n').slice(0, 2200);   // Instagram's caption limit
}

async function waitReady(containerId, pageToken) {
  for (let i = 0; i < 10; i++) {
    const s = await graph('GET', '/' + containerId, { fields: 'status_code', access_token: pageToken });
    if (!s.status_code || s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Instagram could not prepare a photo.');
    await new Promise(r => setTimeout(r, 1500));
  }
}

module.exports = async (req, res) => {
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  const enc = encodeURIComponent;

  // ════════ Facebook sends the principal back here ════════
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.error) return back(res, req, 'meta_error=' + enc(str(q.error_description || q.error, 200)));
    const st = readState(q.state);
    if (!st || !q.code) return back(res, req, 'meta_error=' + enc('The Facebook login link expired. Please press Connect again.'));
    try {
      const short = await graph('GET', '/oauth/access_token', {
        client_id: appId(), client_secret: appSecret(), redirect_uri: redirectUri(req), code: String(q.code)
      });
      // Long-lived user token → the page tokens made from it do not expire
      const long = await graph('GET', '/oauth/access_token', {
        grant_type: 'fb_exchange_token', client_id: appId(), client_secret: appSecret(), fb_exchange_token: short.access_token
      });
      const pages = await graph('GET', '/me/accounts', {
        fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '50', access_token: long.access_token
      });
      const list = (pages.data || []).map(p => ({
        id: p.id, name: p.name, token: p.access_token,
        ig_id: p.instagram_business_account ? p.instagram_business_account.id : null,
        ig: p.instagram_business_account ? (p.instagram_business_account.username || '') : ''
      }));
      if (!list.length) return back(res, req, 'meta_error=' + enc('No Facebook Pages were shared. Press Connect again and tick your school page.'));
      if (list.length === 1) {
        const p = list[0];
        await saveSettings(st.sid, { meta_page_id: p.id, meta_page_name: p.name, meta_page_token: p.token,
          meta_ig_id: p.ig_id, meta_ig_username: p.ig, meta_pending: null, meta_connected_at: new Date().toISOString() });
        return back(res, req, 'meta=connected');
      }
      await saveSettings(st.sid, { meta_pending: list });
      return back(res, req, 'meta=choose');
    } catch (e) {
      return back(res, req, 'meta_error=' + enc(e.message));
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }

  const session = verifySessionToken(body.token);
  if (!session) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  if (!isFull(session)) return res.status(403).json({ ok: false, error: 'Only the principal / admin can do this.' });
  const sid = String(session.sid || '');
  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(sid)) return res.status(401).json({ ok: false, error: 'Invalid session.' });
  const action = String(body.action || '');

  try {
    const sch = ((await sb('GET', 'schools?school_id=eq.' + enc(sid) + '&select=*&limit=1')) || [])[0];
    if (!sch || sch.has_social !== true) return res.status(403).json({ ok: false, error: 'Social Media Posts is not switched on for this school.' });

    if (action === 'start') {
      if (!appId() || !appSecret()) return res.status(500).json({ ok: false, error: 'META_APP_ID / META_APP_SECRET are not set in Vercel yet.' });
      const p = { client_id: appId(), redirect_uri: redirectUri(req), state: makeState(sid), response_type: 'code' };
      if (process.env.META_CONFIG_ID) p.config_id = process.env.META_CONFIG_ID;
      else p.scope = SCOPES.join(',');
      return res.status(200).json({ ok: true, url: 'https://www.facebook.com/' + GRAPH_VER + '/dialog/oauth?' + new URLSearchParams(p).toString() });
    }

    const s = await settingsRow(sid);

    if (action === 'status') {
      const pending = Array.isArray(s && s.meta_pending) ? s.meta_pending.map(p => ({ id: p.id, name: p.name, ig: p.ig })) : [];
      return res.status(200).json({ ok: true, ready: !!(appId() && appSecret()),
        connected: !!(s && s.meta_page_token), page_name: (s && s.meta_page_name) || '',
        ig_username: (s && s.meta_ig_username) || '', has_ig: !!(s && s.meta_ig_id), pending });
    }

    if (action === 'choose') {
      const list = Array.isArray(s && s.meta_pending) ? s.meta_pending : [];
      const p = list.find(x => x.id === String(body.page_id || ''));
      if (!p) return res.status(400).json({ ok: false, error: 'Please press Connect again.' });
      await saveSettings(sid, { meta_page_id: p.id, meta_page_name: p.name, meta_page_token: p.token,
        meta_ig_id: p.ig_id, meta_ig_username: p.ig, meta_pending: null, meta_connected_at: new Date().toISOString() });
      return res.status(200).json({ ok: true, page_name: p.name, ig_username: p.ig });
    }

    if (action === 'disconnect') {
      await saveSettings(sid, { meta_page_id: null, meta_page_name: null, meta_page_token: null,
        meta_ig_id: null, meta_ig_username: null, meta_pending: null });
      return res.status(200).json({ ok: true });
    }

    if (action === 'publish') {
      if (!s || !s.meta_page_token) return res.status(400).json({ ok: false, error: 'Facebook is not connected yet. Connect it in Settings.' });
      if (!isId(body.id)) return res.status(400).json({ ok: false, error: 'Invalid post.' });
      const one = 'social_posts?id=eq.' + enc(body.id) + '&school_id=eq.' + enc(sid);
      const post = ((await sb('GET', one + '&select=*&limit=1')) || [])[0];
      if (!post) return res.status(404).json({ ok: false, error: 'Post not found.' });
      if (post.status !== 'approved') return res.status(400).json({ ok: false, error: 'Only approved posts can be posted.' });
      const photos = (post.photos || []).filter(u => isPhotoUrl(u, sid));
      if (!photos.length) return res.status(400).json({ ok: false, error: 'This post has no photos.' });

      const toFb = body.to_fb !== false && !post.fb_post_id;
      const toIg = body.to_ig !== false && !!s.meta_ig_id && !post.ig_media_id;
      const igPhotos = (Array.isArray(body.ig_photos) ? body.ig_photos : []).filter(u => isPhotoUrl(u, sid)).slice(0, 10);
      const text = postText(post, s);
      const token = s.meta_page_token;
      const out = { fb: null, ig: null, fb_error: '', ig_error: '' };

      if (toFb) {
        try {
          if (photos.length === 1) {
            const r = await graph('POST', '/' + s.meta_page_id + '/photos', { url: photos[0], caption: text, access_token: token });
            out.fb = r.post_id || r.id;
          } else {
            const ids = [];
            for (const u of photos) {
              const r = await graph('POST', '/' + s.meta_page_id + '/photos', { url: u, published: 'false', access_token: token });
              ids.push(r.id);
            }
            const p = { message: text, access_token: token };
            ids.forEach((id, i) => { p['attached_media[' + i + ']'] = JSON.stringify({ media_fbid: id }); });
            const r = await graph('POST', '/' + s.meta_page_id + '/feed', p);
            out.fb = r.id;
          }
        } catch (e) { out.fb_error = e.message; }
      }

      if (toIg) {
        try {
          const list = igPhotos.length ? igPhotos : photos;   // the browser sends Instagram-shaped copies
          let creation;
          if (list.length === 1) {
            creation = (await graph('POST', '/' + s.meta_ig_id + '/media', { image_url: list[0], caption: text, access_token: token })).id;
          } else {
            const kids = [];
            for (const u of list) {
              const k = (await graph('POST', '/' + s.meta_ig_id + '/media', { image_url: u, is_carousel_item: 'true', access_token: token })).id;
              await waitReady(k, token);
              kids.push(k);
            }
            creation = (await graph('POST', '/' + s.meta_ig_id + '/media', { media_type: 'CAROUSEL', children: kids.join(','), caption: text, access_token: token })).id;
          }
          await waitReady(creation, token);
          out.ig = (await graph('POST', '/' + s.meta_ig_id + '/media_publish', { creation_id: creation, access_token: token })).id;
        } catch (e) { out.ig_error = e.message; }
      }

      const patch = { updated_at: new Date().toISOString(),
        publish_error: [out.fb_error && ('Facebook: ' + out.fb_error), out.ig_error && ('Instagram: ' + out.ig_error)].filter(Boolean).join(' | ') || null };
      if (out.fb) patch.fb_post_id = out.fb;
      if (out.ig) patch.ig_media_id = out.ig;
      const fbDone = !!(out.fb || post.fb_post_id || body.to_fb === false);
      const igDone = !!(out.ig || post.ig_media_id || body.to_ig === false || !s.meta_ig_id);
      if ((out.fb || out.ig) && fbDone && igDone) { patch.status = 'posted'; patch.posted_at = new Date().toISOString(); }
      const saved = ((await sb('PATCH', one, patch)) || [])[0];
      return res.status(200).json({ ok: !!(out.fb || out.ig), row: saved, ...out,
        error: (!out.fb && !out.ig) ? (patch.publish_error || 'Nothing was posted.') : undefined });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
};
