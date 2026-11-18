// 快手无水印解析下载站（Cloudflare Pages 单文件 Worker）
// 根目录放 _worker.js：/api/* 走这里，其余走 env.ASSETS 静态资源
// 解析通道：RedFoxHub /story/api/parseWork/videoDownload/kuaishou（主）
//          + 快手分享页 HTML 提取 srcNoMark（兜底，无需 key）
// 需要环境变量 REDFOX_API_KEY（与其他解析站共用同一个 key）
// 反馈/限流（可选）：KV 绑定 FEEDBACK_KV，与其他站共用；未绑定时自动跳过
// 人机验证（可选）：TURNSTILE_SITE_KEY（公开，经 /api/turnstile-key 下发）+ TURNSTILE_SECRET_KEY（保密），配了 secret 才校验；
//   没配时只按 IP 冷却 60 秒 + 每天 20 次（IP 和设备各算一份）

const REDFOX_BASE = 'https://redfox.hk';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DAILY_LIMIT = 20;

/* ================= 安全辅助：IP 归一 / CORS 白名单 / 跳转逐跳校验 ================= */
// 限流用的 IP 键：IPv4 原样；IPv6 归一到 /64（同一用户通常独占一个 /64，换后 64 位就能拿新配额）
function ipLimitKey(ip) {
  ip = String(ip || '').trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  let s = ip.split('%')[0];
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4 && /^::(ffff:)?[\d.]+$/.test(s)) return v4[1]; // IPv4-mapped，按 IPv4 算
  if (v4) s = s.slice(0, -v4[1].length) + '0:0';
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  let parts = head;
  if (halves.length > 1) {
    const tail = halves[1] ? halves[1].split(':') : [];
    parts = head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail);
  }
  parts = parts.slice(0, 4).map((x) => (parseInt(x || '0', 16) || 0).toString(16));
  while (parts.length < 4) parts.push('0');
  return parts.join(':') + '::/64';
}
// ================= 原子频控（D1 rate_counter，和微博站共用同一张表） =================
// 冷却 60 秒 + 每 IP（IPv6 按 /64）每天（北京时间）20 次。解析之前用一条 UPSERT 原子地「判断 + 占坑」：
//   并发一批请求只有第一个能占到坑；失败的解析也算一次（不能拿坏链接无限刷上游接口）。
// D1 出错 / 超过 2 秒：直接拒绝（503「服务繁忙，请稍后再试」），不再退回 KV。
// 缺少 PARSE_DB 同样拒绝；本地测试需提供 D1，预览不再回退 KV。
const RL_COOLDOWN_SECS = 60;
const RL_DAILY_LIMIT = 20;
const RL_TIMEOUT_MS = 2000;
function rlDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function rlWithTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}
const RL_BUSY = { ok: false, status: 503, msg: '服务繁忙，请稍后再试' };
function rlDeny(now, last, used, limit = RL_DAILY_LIMIT, cooldownSecs = RL_COOLDOWN_SECS) {
  if (cooldownSecs > 0 && last && now - last < cooldownSecs * 1000) {
    const wait = Math.ceil((cooldownSecs * 1000 - (now - last)) / 1000);
    return { ok: false, status: 429, msg: '解析太频繁，请 ' + wait + ' 秒后再试' };
  }
  if (used >= limit) return { ok: false, status: 429, msg: '今日解析次数已用完（' + limit + ' 次），明天再来吧' };
  return null;
}
async function rateTake(env, site, rawIp, limit = RL_DAILY_LIMIT, cooldownSecs = RL_COOLDOWN_SECS) {
  const ip = ipLimitKey(rawIp);
  if (!ip) return RL_BUSY;
  const now = Date.now();
  const k = site + ':' + ip + ':' + rlDate();
  const db = env && env.PARSE_DB;
  if (db && typeof db.prepare === 'function') {
    try {
      const got = await rlWithTimeout(db.prepare(
        'INSERT INTO rate_counter (k, n, last, exp) VALUES (?, 1, ?, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1, last = excluded.last ' +
        'WHERE rate_counter.last <= ? AND rate_counter.n < ? RETURNING n'
      ).bind(k, now, now + 2 * 86400000, now - cooldownSecs * 1000, limit).first(), RL_TIMEOUT_MS);
      if (got) return { ok: true };
      const cur = await rlWithTimeout(db.prepare('SELECT n, last FROM rate_counter WHERE k = ?').bind(k).first(), RL_TIMEOUT_MS);
      return rlDeny(now, Number(cur && cur.last) || 0, Number(cur && cur.n) || 0, limit, cooldownSecs) || { ok: false, status: 429, msg: '解析太频繁，请稍后再试' };
    } catch (e) { return RL_BUSY; } // D1 挂了 / 超时：拒绝，不退回 KV
  }
  return RL_BUSY; // Missing D1 is a configuration failure, including public previews.
}
async function rateUsed(env, site, rawIp) {
  const ip = ipLimitKey(rawIp);
  if (!ip) return null;
  const db = env && env.PARSE_DB;
  if (db && typeof db.prepare === 'function') {
    try {
      const cur = await rlWithTimeout(db.prepare('SELECT n FROM rate_counter WHERE k = ?').bind(site + ':' + ip + ':' + rlDate()).first(), RL_TIMEOUT_MS);
      return Number(cur && cur.n) || 0;
    } catch {}
  }
  return null; // Unknown quota must not look like a fresh allowance.
}
// 人机验证 fail-closed：没配 TURNSTILE_SECRET_KEY 就拒绝解析，除非明确设了 TURNSTILE_DISABLED=1
function turnstileDisabled(env) {
  return /^(1|true|yes|on)$/i.test(String((env && env.TURNSTILE_DISABLED) || '').trim());
}
// ================= 原子频控 end =================

function clientIpKey(request) {
  return ipLimitKey(request.headers.get('cf-connecting-ip') || '');
}

// CORS：只给本站来源回显 Origin（同源、站点 pages.dev 域名及其预览子域、环境变量 ALLOWED_ORIGINS 里的自定义域名）
const SITE_ORIGINS = ["https://kuaishoujiexi.pages.dev"];
function originAllowed(origin, request, env) {
  if (!origin) return false;
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (origin === new URL(request.url).origin) return true;
  const extra = String((env && env.ALLOWED_ORIGINS) || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (SITE_ORIGINS.includes(origin) || extra.includes(origin)) return true;
  return o.protocol === 'https:' && SITE_ORIGINS.some((s) => o.hostname.endsWith('.' + new URL(s).hostname));
}
function applyCors(request, env, resp) {
  if (!resp || !new URL(request.url).pathname.startsWith('/api/')) return resp;
  const origin = request.headers.get('Origin') || '';
  const r = new Response(resp.body, resp);
  r.headers.delete('Access-Control-Allow-Origin');
  if (originAllowed(origin, request, env)) r.headers.set('Access-Control-Allow-Origin', origin);
  r.headers.append('Vary', 'Origin');
  return r;
}

// 代理抓取：手动跟随跳转（最多 maxHops 次），每一跳都只允许 https + 白名单域名，否则返回 null
async function fetchAllowedHops(url, init, isAllowed, maxHops = 5) {
  let cur = String(url);
  for (let hop = 0; hop <= maxHops; hop++) {
    let u;
    try { u = new URL(cur); } catch { return null; }
    if (u.protocol !== 'https:' || !isAllowed(u.hostname)) return null;
    const resp = await fetch(u.toString(), { ...init, redirect: 'manual' });
    const loc = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400 && loc) {
      try { if (resp.body) await resp.body.cancel(); } catch {}
      try { cur = new URL(loc, u).toString(); } catch { return null; }
      continue;
    }
    return resp;
  }
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// Cloudflare Turnstile：secret 配了才校验，不配则跳过
async function verifyTurnstile(token, secret, ip) {
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip || '' }),
    });
    const j = await resp.json();
    return j && j.success === true;
  } catch {
    return false;
  }
}

// ---------- RedFoxHub ----------
async function redfoxPost(path, apiKey, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(REDFOX_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        REDFOX_API_KEY: apiKey,
        'User-Agent': UA_PC,
        Accept: 'application/json',
      },
      body: JSON.stringify({ ...body, source: 'kuaishou-dl-pages' }),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error('RedFoxHub 返回了非 JSON 数据（HTTP ' + resp.status + '）');
    }
    if (resp.status === 401)
      throw new Error('RedFoxHub API Key 无效，请检查环境变量 REDFOX_API_KEY 是否正确');
    if (resp.status === 429) throw new Error('请求太频繁，请稍后重试');
    const code = j.code;
    const msg = String(j.msg || j.message || '');
    if (code && code !== 2000) {
      if (code === 401 || code === 4001) throw new Error('RedFoxHub 鉴权失败：' + msg);
      if (/余额|balance|insufficient|欠费/i.test(msg))
        throw new Error('RedFoxHub 余额不足，请前往 redfox.hk 控制台充值后再试');
      throw new Error('RedFoxHub：' + (msg || 'code=' + code));
    }
    if (!resp.ok) throw new Error('RedFoxHub 请求失败（HTTP ' + resp.status + '）' + (msg ? '：' + msg : ''));
    return j.data !== undefined ? j.data : j;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 链接处理 ----------
// 没写 https:// 的裸链接（如 v.kuaishou.com/xxx）补上 https://，再走 isKsHost 白名单。
// 链接只收 RFC3986 子集字符，遇到空白、汉字、全角标点就停
const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'*+,;=%]";
function extractKsUrl(text) {
  if (!text) return null;
  const src = String(text);
  const hit = src.match(new RegExp('https?://' + URL_CHARS + '+', 'i'));
  const bare = hit ? null : src.match(new RegExp('(?:^|[^\\w.@/=:-])((?:[a-z0-9-]+\\.)+[a-z]{2,})(?![\\w.-])([/?#]' + URL_CHARS + '*)?', 'i'));
  const raw = hit ? hit[0] : (bare ? 'https://' + bare[1] + (bare[2] || '') : null);
  return raw ? raw.replace(/[.,;!?\]]+$/, '') : null;
}

// 页面/短链域名（识别输入、跟随跳转用；下载代理另有 DL_HOSTS，不受影响）。v.kuaishou.cn 是快手的 .cn 短链
function isKsHost(hostname) {
  return /(^|\.)kuaishou\.com$|(^|\.)kuaishou\.cn$|(^|\.)gifshow\.com$|(^|\.)kuaishouapp\.com$|(^|\.)chenzhongtech\.com$/i.test(
    String(hostname || '').replace(/\.$/, '')
  );
}

async function resolveShortLink(url) {
  let cur = url;
  for (let i = 0; i < 5; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const resp = await fetch(cur, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA_MOBILE },
        signal: ctrl.signal,
      });
      const loc = resp.headers.get('location');
      await resp.arrayBuffer().catch(() => {});
      if (resp.status >= 300 && resp.status < 400 && loc) {
        const next = new URL(loc, cur).toString();
        let nh = '';
        try { nh = new URL(next).hostname; } catch {}
        if (!isKsHost(nh)) return cur; // 跳去别的域名就停，不当任意网址抓取器
        cur = next;
        continue;
      }
      return cur;
    } catch {
      return cur;
    } finally {
      clearTimeout(timer);
    }
  }
  return cur;
}

function canonicalKsUrl(finalUrl) {
  const m = String(finalUrl).match(/kuaishou\.com\/short-video\/([A-Za-z0-9_-]+)/i);
  if (m) return 'https://www.kuaishou.com/short-video/' + m[1];
  return null;
}

// ---------- 结果提取 ----------
function ensureHttps(u) {
  if (typeof u !== 'string') return u;
  if (u.startsWith('//')) return 'https:' + u;
  return u.replace(/^http:\/\//i, 'https://');
}
function pickUrl(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return null;
  return item.url || item.downloadUrl || item.download_url || item.playUrl || item.play_url || item.src || null;
}
function isVideoUrl(u) {
  return typeof u === 'string' && (/\.mp4(\?|$)/i.test(u) || /yximgs|kwaicdn|video/i.test(u));
}

// 从 RedFoxHub 返回里宽容地提取（字段名多路兜底）
function extractKsMedia(data) {
  const videos = [];
  const images = [];
  const seen = new Set();
  const pushV = (u) => {
    const h = ensureHttps(pickUrl(u) || u);
    if (typeof h === 'string' && /^https:\/\//i.test(h) && !seen.has(h)) {
      seen.add(h);
      videos.push(h);
    }
  };
  const pushI = (u) => {
    const h = ensureHttps(pickUrl(u) || u);
    if (typeof h === 'string' && /^https:\/\//i.test(h) && !seen.has(h)) {
      seen.add(h);
      images.push(h);
    }
  };
  if (!data || typeof data !== 'object') return { videos, images };
  // 快手特有字段优先
  if (data.srcNoMark) pushV(data.srcNoMark);
  if (data.noWatermarkUrl) pushV(data.noWatermarkUrl);
  if (Array.isArray(data.mainMvUrls)) for (const it of data.mainMvUrls) pushV(it);
  // 通用资源数组
  const resources = data.resources || data.resource || data.medias || [];
  if (Array.isArray(resources)) {
    for (const r of resources) {
      const t = String((r && r.type) || '').toLowerCase();
      if (t === 'video') pushV(r);
      else if (t === 'image' || t === 'pic' || t === 'photo') pushI(r);
      else if (pickUrl(r)) {
        if (isVideoUrl(pickUrl(r))) pushV(r);
        else pushI(r);
      }
    }
  }
  for (const k of ['videoUrl', 'video_url', 'downloadUrl', 'download_url', 'playUrl', 'play_url'])
    if (data[k]) pushV(data[k]);
  if (Array.isArray(data.images)) for (const it of data.images) pushI(it);
  if (Array.isArray(data.imageList)) for (const it of data.imageList) pushI(it);
  if (Array.isArray(data.photos)) for (const it of data.photos) pushI(it);
  return { videos, images };
}

function ksMeta(data) {
  const d = data || {};
  const author =
    (d.author && (d.author.name || d.author.nickname)) ||
    d.userName ||
    d.authorName ||
    d.nickname ||
    d.user_name ||
    '';
  return {
    title: String(d.title || d.caption || d.desc || d.content || '').slice(0, 200),
    cover: ensureHttps(d.cover || d.coverUrl || d.cover_url || d.poster || d.thumbnail || ''),
    author: String(author).slice(0, 60),
  };
}

async function parseViaRedFox(shareText, apiKey) {
  const rawUrl = extractKsUrl(shareText);
  if (!rawUrl) throw new Error('没找到有效的链接，请粘贴快手分享链接');
  let host = '';
  try {
    host = new URL(rawUrl).hostname;
  } catch {}
  if (!isKsHost(host)) throw new Error('这不是快手链接，请检查后重试');

  const finalUrl = await resolveShortLink(rawUrl);
  const canonical = canonicalKsUrl(finalUrl);
  const routes = [];
  if (canonical) routes.push(canonical);
  if (finalUrl && finalUrl !== canonical) routes.push(finalUrl);
  if (!routes.includes(rawUrl)) routes.push(rawUrl);

  let lastErr = null;
  for (const url of routes) {
    try {
      const data = await redfoxPost('/story/api/parseWork/videoDownload/kuaishou', apiKey, { url });
      const { videos, images } = extractKsMedia(data || {});
      if (videos.length || images.length) {
        return { ...ksMeta(data), videos, images, type: images.length && !videos.length ? 'image' : 'video', source: 'redfox' };
      }
      lastErr = new Error('解析到了内容，但没找到可下载的地址');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('解析失败，请稍后重试');
}

// ---------- 兜底：分享页 HTML 提取 srcNoMark ----------
function jsonStr(html, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
  const m = html.match(re);
  if (!m) return '';
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch {
    return m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  }
}

function unescapePage(html) {
  return html.replace(/\\"/g, '"').replace(/\\\//g, '/');
}
// 在 key 出现的位置往后一小段里找第一个 "url":"..."（应对 mainMvUrls/coverUrls 这类数组对象）
function firstUrlIn(html, key) {
  const i = html.indexOf('"' + key + '"');
  if (i < 0) return '';
  const seg = html.slice(i, i + 6000);
  const m = seg.match(/"url"\s*:\s*"(https?:\/\/[^"]+)"/);
  return m ? m[1].replace(/&amp;/g, '&') : '';
}

async function parseViaScrape(shareText) {
  const rawUrl = extractKsUrl(shareText);
  if (!rawUrl) throw new Error('没找到有效的链接，请粘贴快手分享链接');
  let host = '';
  try {
    host = new URL(rawUrl).hostname;
  } catch {}
  if (!isKsHost(host)) throw new Error('这不是快手链接，请检查后重试');
  const finalUrl = await resolveShortLink(rawUrl);
  const pageUrl = ensureHttps(canonicalKsUrl(finalUrl) || finalUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    // 手动跟随跳转，每一跳都只允许 https + 快手域名（以前自动跟随，可能被带去任意地址）
    const resp = await fetchAllowedHops(pageUrl, {
      headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/', Accept: 'text/html' },
      signal: ctrl.signal,
    }, isKsHost, 5);
    if (!resp) throw new Error('快手页面跳转到了不支持的地址');
    if (!resp.ok) throw new Error('快手页面打开失败（HTTP ' + resp.status + '）');
    const html = await resp.text();
    const un = unescapePage(html); // 页面数据多为 \" 转义过的 JSON，先解一层再提取
    let video = jsonStr(html, 'srcNoMark') || jsonStr(un, 'srcNoMark');
    if (!video) video = firstUrlIn(un, 'mainMvUrls') || firstUrlIn(html, 'mainMvUrls');
    if (!video) {
      const m = un.match(/https?:\/\/[a-z0-9.-]*(?:kwaicdn|kwimgs|yximgs)\.com\/[^"\s]+\.mp4[^"\s]*/i);
      if (m) video = m[0].replace(/&amp;/g, '&');
    }
    if (!video) throw new Error('页面里没找到无水印地址（可能需要登录或链接已失效）');
    const ogTitle = (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) || [])[1] || '';
    const ogCover = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i) || [])[1] || '';
    return {
      title: String(jsonStr(html, 'caption') || jsonStr(un, 'caption') || ogTitle || '').slice(0, 200),
      cover: ensureHttps(
        jsonStr(html, 'coverUrl') || firstUrlIn(un, 'coverUrls') || firstUrlIn(html, 'coverUrls') || ogCover || ''
      ),
      author: String(jsonStr(html, 'userName') || jsonStr(un, 'userName') || jsonStr(html, 'name') || '').slice(0, 60),
      videos: [ensureHttps(video)],
      images: [],
      type: 'video',
      source: 'scrape',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 频控 / 配额（KV 可选） ----------
// 以 IP 为准（cf-connecting-ip，前端改不了），设备号只作为附加维度：
//   - 冷却：同一 IP 60 秒内只能成功解析一次
//   - 日限额：同一 IP 每天 20 次；带了设备号时该设备也各算 20 次（两者任一用完就拦）
// 键名都带 kuaishou 前缀，不和其他站共用（以前各站共用 pcool_<IP> 会互相误伤）
const PARSE_COOLDOWN_SECS = 60;
function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || '';
}
// 所有按 IP 的限流键都用 ipLimitKey：IPv6 按 /64 归一，换地址后 64 位拿不到新配额
function quotaKeys(ip, device) {
  const keys = [];
  if (ip) keys.push('dlimit_kuaishou_ip_' + ipLimitKey(ip) + '_' + todayStr());
  if (device) keys.push('quota_kuaishou_' + todayStr() + '_' + device);
  return keys;
}
async function checkRate(env, ip, device) {
  // 原子频控（D1）：解析前占坑，并发打不穿，失败也算一次；设备号前端可改，不再作为依据
  const r = await rateTake(env, 'kuaishou', ip);
  return r.ok ? { ok: true } : { ok: false, error: r.msg, status: r.status };
}
async function markParse(env, request, ip, device) {
  const kv = env.FEEDBACK_KV;
  if (!kv) return;
  try {
    await kv.put('stats_parse_kuaishou', String((parseInt((await kv.get('stats_parse_kuaishou')) || '0', 10) || 0) + 1));
  } catch {}
  // 数据总览：地区分布 + 最近解析（与其他站同一套键名，统一后台能看到快手）
  const cf = request.cf || {};
  const cc = String(cf.country || 'XX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'XX';
  try {
    const gk = 'geoparse_kuaishou_' + cc;
    await kv.put(gk, String((Number(await kv.get(gk)) || 0) + 1));
  } catch {}
  try {
    let hist = [];
    try { hist = JSON.parse((await kv.get('parsehist_kuaishou')) || '[]'); } catch {}
    if (!Array.isArray(hist)) hist = [];
    hist.unshift({ t: Date.now(), ip, dev: device || '', cc, region: cf.region || '', city: cf.city || '' });
    await kv.put('parsehist_kuaishou', JSON.stringify(hist.slice(0, 20)));
  } catch {}
}

// ---------- 解析接口 ----------
async function handleParse(request, env) {
  let shareText = '';
  let tsToken = '';
  let device = '';
  const u = new URL(request.url);
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      shareText = String(body.url || body.text || '');
      tsToken = String(body.tsToken || body.turnstile || body['cf-turnstile-response'] || '');
      device = String(body.device || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    } catch {}
  }
  if (!shareText) {
    shareText = u.searchParams.get('url') || '';
    device = (u.searchParams.get('device') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  }
  if (!tsToken) tsToken = u.searchParams.get('turnstile') || '';
  if (!shareText.trim()) return json({ ok: false, error: '请先粘贴快手分享链接' }, 400);
  // 先在本地判断链接，明显不对的直接 400，不去碰上游
  const rawUrl = extractKsUrl(shareText);
  if (!rawUrl) return json({ ok: false, error: '没找到有效的链接，请粘贴快手分享链接' }, 400);
  let host = '';
  try { host = new URL(rawUrl).hostname; } catch {}
  if (!isKsHost(host)) return json({ ok: false, error: '这不是快手链接，请检查后重试' }, 400);

  // 人机验证：配了 TURNSTILE_SECRET_KEY 才校验（没配就只走 IP 频控）
  const secret = (env.TURNSTILE_SECRET_KEY || '').trim();
  const ip = clientIp(request);
  if (!secret && !turnstileDisabled(env)) return json({ ok: false, error: '人机验证未配置，暂停解析' }, 503);
  if (secret) {
    if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
    if (!(await verifyTurnstile(tsToken, secret, ip)))
      return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  }

  const rate = await checkRate(env, ip, device);
  if (!rate.ok) return json({ ok: false, error: rate.error }, rate.status || 503);
  plPass(request); // 人机验证 + 频控都过了：这次解析才记进 D1 parse_log

  const apiKey = (env.REDFOX_API_KEY || '').trim();
  let result = null;
  let redfoxErr = null;
  if (apiKey) {
    try {
      result = await parseViaRedFox(shareText, apiKey);
    } catch (e) {
      redfoxErr = e;
    }
  }
  if (!result) {
    try {
      result = await parseViaScrape(shareText);
    } catch (e) {
      const msg =
        (redfoxErr && redfoxErr.message) || e.message || '解析失败，请稍后重试';
      return json({ ok: false, error: msg }, 502);
    }
  }
  await markParse(env, request, ip, device);
  // 预览卡片（allfeedback「解析记录」）：封面 / 标题 / 类型。图集没有封面时用第一张图
  const ksImgs = Array.isArray(result.images) ? result.images : [];
  const ksImg0 = typeof ksImgs[0] === 'string' ? ksImgs[0] : (ksImgs[0] && ksImgs[0].url) || '';
  plMeta(request, {
    cover: result.cover || ksImg0,
    title: result.title,
    media: result.type === 'image' && ksImgs.length > 1 ? 'images' : result.type,
  });
  return json({ ok: true, ...result });
}

// ---------- 配额查询 ----------
async function handleQuota(request, env) {
  const used = await rateUsed(env, 'kuaishou', clientIp(request));
  if (used === null) return json({ok:false,error:RL_BUSY.msg},503);
  return json({ ok: true, limited: true, limit: DAILY_LIMIT, used, remaining: Math.max(0, DAILY_LIMIT - used) });
}

// ---------- 媒体下载代理 ----------
async function handleDl(request) {
  const u = new URL(request.url);
  const mediaUrl = u.searchParams.get('url') || '';
  const filename = (u.searchParams.get('filename') || 'kuaishou_media').replace(/["\r\n]/g, '').slice(0, 80) || 'kuaishou_media';
  let target = null;
  try {
    target = new URL(mediaUrl);
  } catch {
    return json({ ok: false, error: '无效的下载地址' }, 400);
  }
  const DL_HOSTS = ['yximgs.com', 'kwimgs.com', 'kwaicdn.com', 'kuaishou.com', 'gifshow.com', 'chenzhongtech.com', 'kuaishouapp.com'];
  const th = target.hostname.toLowerCase();
  if (!/^https:$/.test(target.protocol) || !DL_HOSTS.some((d) => th === d || th.endsWith('.' + d)))
    return json({ ok: false, error: '不支持的下载地址' }, 400);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    // redirect: 'manual' 逐跳校验：最多 5 跳，每一跳都必须 https 且在 DL_HOSTS 白名单里（以前自动跟随，CDN 302 到哪就代理到哪）
    const okHost = (h) => { h = String(h || '').toLowerCase(); return DL_HOSTS.some((d) => h === d || h.endsWith('.' + d)); };
    const resp = await fetchAllowedHops(mediaUrl, {
      headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/', Accept: '*/*' },
      signal: ctrl.signal,
    }, okHost, 5);
    if (!resp) return json({ ok: false, error: '下载地址跳转到了不支持的域名' }, 400);
    if (!resp.ok || !resp.body) return json({ ok: false, error: '下载失败（HTTP ' + resp.status + '）' }, 502);
    const h = new Headers();
    h.set('Content-Type', resp.headers.get('content-type') || 'application/octet-stream');
    const len = resp.headers.get('content-length');
    if (len) h.set('Content-Length', len);
    h.set('Content-Disposition', 'attachment; filename="' + filename + '"');
    h.set('Cache-Control', 'no-store');
    h.set('X-Content-Type-Options', 'nosniff');
    return new Response(resp.body, { status: 200, headers: h });
  } catch (e) {
    return json({ ok: false, error: '下载失败：' + (e.message || '网络错误') }, 502);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 反馈（与其他站共用 FEEDBACK_KV，键名 fb_<id>，字段与其他站一致，统一后台 /admin 可见） ----------
async function handleFeedback(request, env) {
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '反馈功能暂未启用' }, 500);
  let message = '',
    contact = '',
    device = '',
    page = '',
    kind = '',
    link = '',
    tsToken = '';
  try {
    const body = await request.json();
    message = String(body.message || '').trim();
    // 问题类型、当前输入的链接单独存（以前拼进 message 再截到 2000 字，链接会被悄悄截掉）
    kind = String(body.kind || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 20);
    link = String(body.link || '').trim().slice(0, 800);
    contact = String(body.contact || '').trim().slice(0, 120);
    device = String(body.device || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    page = String(body.page || '').slice(0, 200);
    tsToken = String(body.tsToken || body['cf-turnstile-response'] || '');
  } catch {}
  if (!message && kind) message = '（未写具体描述）';
  if (!message) return json({ ok: false, error: '请先写点内容再提交' }, 400);
  // 2000 字只算用户自己写的内容；旧前端把类型和链接拼进 message，没带 kind/link 时放宽到 3000
  if (message.length > (kind || link ? 2000 : 3000)) return json({ ok: false, error: '内容太长，请精简到 2000 字以内' }, 400);
  const secret = (env.TURNSTILE_SECRET_KEY || '').trim();
  const ip = clientIp(request);
  if (secret) {
    if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
    if (!(await verifyTurnstile(tsToken, secret, ip))) return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  }
  const kv = env.FEEDBACK_KV;
  const cdKey = ip ? 'cool_kuaishou_' + ipLimitKey(ip) : device ? 'cd_feedback_' + device : '';
  try {
    if (cdKey && (await kv.get(cdKey))) return json({ ok: false, error: '提交太频繁，请 10 分钟后再试' }, 429);
  } catch {}
  const id = 'fb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  try {
    const pu = new URL(page);
    if (pu.protocol !== 'https:' && pu.protocol !== 'http:') page = '';
  } catch { page = ''; }
  if (!page) page = 'https://kuaishoujiexi.pages.dev/';
  const cf = request.cf || {};
  const rec = {
    id,
    message,
    kind,
    link,
    contact,
    page,
    attachments: [],
    device,
    ua: (request.headers.get('user-agent') || '').slice(0, 200),
    ip,
    geo: { country: cf.country || '', region: cf.region || '', city: cf.city || '' },
    time: new Date().toISOString(),
  };
  try {
    await kv.put(id, JSON.stringify(rec));
    if (cdKey) await kv.put(cdKey, '1', { expirationTtl: 600 });
  } catch {
    return json({ ok: false, error: '提交失败，请稍后重试' }, 500);
  }
  return json({ ok: true, id });
}

// ---------- 主路由 ----------
// ==== parse-log v3 BEGIN ====
// 解析记录 + 拉黑 + 预览信息（各解析站共用同一份代码：allfeedback/shared/parse-log.js 是原件，改动后用 shared/pf-sync.mjs 同步）
// 存储：D1 数据库 parse_log（绑定名 PARSE_DB），表 parse_log / blocklist，建表语句见 allfeedback/shared/parse_log.sql。
// - 每次解析记一行：时间、站点、链接（去掉令牌类参数）、成功与否、状态码、失败原因（里面的链接也去令牌）、IP、归属地（request.cf）、
//   设备 ID、设备指纹、UA。失败行（ok=0）同时就是 allfeedback「解析失败」的数据来源，所以接了本模块的站不再需要 pf-recorder。
// - 只在「人机验证 + 频控都通过之后」才记：站点在 handleParse 里过了这两关时调用 plPass(request)，没调用的请求一律不记
//   （没过人机验证的刷接口请求不会写 D1，不会把每天的免费写入额度刷光）。
// - 只记「有效链接」：站点传入的 valid(input) 返回 false（空输入 / 不是本站链接 / 链接格式不对）就不记。
// - 设备 ID：前端首次访问在 localStorage 生成的随机 UUID，放在请求头 X-Device-Id；格式不对就当没有。
// - 设备指纹：前端用 canvas 渲染、屏幕尺寸/色深、时区、语言、CPU 核数、平台、UA 算 SHA-256 取前 32 位十六进制，
//   放在请求头 X-Device-Fp；尽力而为，格式不对就当没有。同型号同浏览器的设备常常算出同一个指纹。
// - 拉黑：最先查 blocklist（IP / IPv6 /64 / 设备 ID / 指纹）；命中返回 403「访问受限」，不调上游。
//   名单在每个 isolate 里缓存 60 秒；过期后先用旧名单放行/拦截，同时在后台（waitUntil）刷新，不让用户干等。
//   只有刚启动、手里还没有名单时才等一次（最多 1.5 秒）。D1 没绑定 / 查询出错 / 超时一律放行（fail open）。
//   被拉黑的请求按命中的名单项每分钟最多记一行（换设备头也不会多写）。
// - 下载 / 媒体代理用 pl.guard(...) 包一层：只查黑名单，不记。
// - 写入全部在 waitUntil 里、最多等 10 秒、出错吞掉，不影响解析响应。保留 30 天：由微博 Worker 的每日定时任务分批删除。
// - 预览卡片（v3）：解析成功处调用 plMeta(request, { cover, title, media })，成功行一起存 cover / title / media 三列：
//   cover 只收 https 图片链接（// 开头补 https:，http: 升成 https:），超过 500 字丢弃；title 去控制字符、合并空白、≤120 字；
//   media 只收 video / image / images / mix / audio / live。三列由 shared/migrations/2026-11-19-preview.sql 加上；
//   迁移前写入会报「没有这一列」，此时退回旧列再写一次（本 isolate 10 分钟内直接写旧列），记录不会丢。
// - 开关：PARSE_LOG_OFF=1 时不写记录（黑名单照常检查）。
// - 预览部署（<分支或哈希>.<项目>.pages.dev）不提供解析：直接 403。确实要测，给预览环境加 PARSE_ON_PREVIEW=1。
const PL_BLOCK_TTL_MS = 60000;
const PL_BLOCK_RETRY_MS = 10000;
const PL_BLOCK_TIMEOUT_MS = 1500;
const PL_WRITE_TIMEOUT_MS = 10000;
const PL_RETENTION_MS = 30 * 86400 * 1000;
const PL_BLOCK_MSG = '访问受限';
const PL_FP_RE = /^[0-9a-f]{32}$/;
const PL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PL_KEEP_PARAMS = new Set(['v', 'p', 'id', 'vid', 'bvid', 'aid', 'aweme_id', 'modal_id', 'item_id', 'photoid', 'list', 'index']);
const PL_URL_RE = /https?:\/\/[^\s"'<>\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/gi;
const PL_PASSED = new WeakSet();
const PL_META = new WeakMap();
const PL_MEDIA = new Set(['video', 'image', 'images', 'mix', 'audio', 'live']);
const PL_NOCOL_RETRY_MS = 600000;
const PL_COLS = 'ts, site, url, ok, status, reason, ip, country, region, city, device_id, fp, ua';

// 站点在人机验证 + 频控都通过后调用：之后这次解析才会被记录
function plPass(request) {
  try { if (request && typeof request === 'object') PL_PASSED.add(request); } catch {}
}
// 去掉控制字符、零宽 / 方向控制符，合并空白
function plText(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
}
// 预览信息白名单：{ cover, title, media }，不合格的字段给空串
function plCleanMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  let cover = typeof m.cover === 'string' ? plText(m.cover) : '';
  if (/^\/\//.test(cover)) cover = 'https:' + cover;
  else if (/^http:\/\//i.test(cover)) cover = 'https://' + cover.slice(7);
  if (cover) {
    try {
      const u = new URL(cover);
      cover = u.protocol === 'https:' && !u.username && !u.password && u.hostname ? u.toString() : '';
    } catch { cover = ''; }
  }
  if (cover.length > 500) cover = '';
  const title = Array.from(typeof m.title === 'string' || typeof m.title === 'number' ? plText(m.title) : '').slice(0, 120).join('');
  const media = String(m.media == null ? '' : m.media).trim().toLowerCase();
  return { cover, title, media: PL_MEDIA.has(media) ? media : '' };
}
// 站点在解析成功、拿到结果后调用：这次成功记录会带上封面 / 标题 / 类型。出错一律吞掉，不影响解析
function plMeta(request, meta) {
  try {
    if (!request || typeof request !== 'object') return;
    const m = plCleanMeta(meta);
    if (m.cover || m.title || m.media) PL_META.set(request, m);
  } catch {}
}
function plDevice(request) {
  const v = String(request.headers.get('x-device-id') || '').trim().toLowerCase();
  return PL_UUID_RE.test(v) ? v : '';
}
function plFp(request) {
  const v = String(request.headers.get('x-device-fp') || '').trim().toLowerCase();
  return PL_FP_RE.test(v) ? v : '';
}
function plIp(request) {
  return String(request.headers.get('cf-connecting-ip') || '').trim().toLowerCase().slice(0, 64);
}
// IPv6 按 /64 归一（同一用户的 IPv6 后半段经常变）；IPv4 原样
function plIp64(ip) {
  ip = String(ip || '').trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  let s = ip.split('%')[0];
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4 && /^::(ffff:)?[\d.]+$/.test(s)) return v4[1];
  if (v4) s = s.slice(0, -v4[1].length) + '0:0';
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  let parts = head;
  if (halves.length > 1) {
    const tail = halves[1] ? halves[1].split(':') : [];
    parts = head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail);
  }
  parts = parts.slice(0, 4).map((x) => (parseInt(x || '0', 16) || 0).toString(16));
  while (parts.length < 4) parts.push('0');
  return parts.join(':') + '::/64';
}
function plCleanOne(raw) {
  raw = String(raw || '').replace(/[),.;!?\]}>»」』】，。；：？！）、]+$/, '');
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  u.username = '';
  u.password = '';
  u.hash = '';
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (PL_KEEP_PARAMS.has(k.toLowerCase()) && v.length <= 64) keep.append(k, v);
  const qs = keep.toString();
  u.search = qs ? '?' + qs : '';
  return u.toString().slice(0, 300);
}
function plCleanUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? plCleanOne(m[0]) : '';
}
// 失败原因里出现的链接也去掉令牌（上游报错经常把请求地址连同令牌一起带出来）
function plScrub(text, max) {
  const s = String(text == null ? '' : text).replace(PL_URL_RE, (m) => {
    const tail = (m.match(/[),.;!?\]}>»」』】，。；：？！）、]+$/) || [''])[0];
    return (plCleanOne(m) || '[链接]') + tail;
  });
  return s.replace(/\s+/g, ' ').trim().slice(0, max || 160);
}
async function plInput(request) {
  const u = new URL(request.url);
  let s = u.searchParams.get('url') || u.searchParams.get('text') || '';
  if (!s && request.method === 'POST' && Number(request.headers.get('content-length') || 0) <= 65536) {
    try {
      const b = await request.clone().json();
      if (b && typeof b === 'object') s = String(b.url || b.link || b.text || '');
    } catch {}
  }
  return String(s).slice(0, 2000);
}
function plFlag(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}
function plIsPreview(request, env) {
  if (env && plFlag(env.PARSE_ON_PREVIEW)) return false;
  let h = '';
  try { h = new URL(request.url).hostname.toLowerCase(); } catch { return false; }
  return /\.pages\.dev$/.test(h) && h.split('.').length > 3;
}
function plJson(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function plPreviewResponse() {
  const msg = '预览环境不提供解析，请到正式站使用';
  return plJson({ ok: false, code: -1, error: msg, msg }, 403);
}
function plWithTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}
function createParseLog(site, opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const valid = typeof opts.valid === 'function' ? opts.valid : null;
  const cache = { set: null, at: 0, pending: null };
  let noMetaAt = -Infinity; // 上次发现 parse_log 还没有 cover/title/media 列的时间（迁移前）
  const blockLogged = new Map(); // 命中的名单项 → 上次记录时间（每分钟最多记一行）

  function refresh(db) {
    if (cache.pending) return cache.pending;
    cache.pending = (async () => {
      try {
        const r = await plWithTimeout(db.prepare('SELECT type, value FROM blocklist LIMIT 5000').all(), PL_BLOCK_TIMEOUT_MS);
        const set = new Set();
        for (const x of (r && r.results) || []) set.add(String(x.type) + ':' + String(x.value));
        cache.set = set;
        cache.at = now();
      } catch {
        // 读失败：放行，10 秒后再试；有旧名单就继续用旧的
        if (!cache.set) cache.set = new Set();
        cache.at = now() - PL_BLOCK_TTL_MS + PL_BLOCK_RETRY_MS;
      }
    })().finally(() => { cache.pending = null; });
    return cache.pending;
  }
  // 命中返回名单项（如 'ip:1.2.3.4'），没命中返回 ''
  async function blockedBy(env, ctx, ip, device, fp) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function') return '';
    if (!cache.set) await refresh(db); // 刚启动：等一次（最多 1.5 秒）
    else if (now() - cache.at >= PL_BLOCK_TTL_MS && !cache.pending) {
      const job = refresh(db); // 过期：先用旧名单，后台刷新
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    }
    const s = cache.set;
    if (!s || !s.size) return '';
    if (ip && s.has('ip:' + ip)) return 'ip:' + ip;
    if (ip && ip.includes(':') && s.has('ip:' + plIp64(ip))) return 'ip:' + plIp64(ip);
    if (device && s.has('device:' + device)) return 'device:' + device;
    if (fp && s.has('fp:' + fp)) return 'fp:' + fp;
    return '';
  }
  async function isBlocked(env, ip, device, fp, ctx) {
    try { return !!(await blockedBy(env, ctx, ip, device, fp)); } catch { return false; }
  }
  function write(env, ctx, row) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function' || plFlag(env.PARSE_LOG_OFF)) return null;
    const job = (async () => {
      try {
        const vals = [row.ts, site, row.url, row.ok ? 1 : 0, row.status, row.reason, row.ip, row.country, row.region, row.city, row.device, row.fp, row.ua];
        const meta = row.meta;
        const legacy = () => plWithTimeout(
          db.prepare('INSERT INTO parse_log (' + PL_COLS + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(...vals).run(), PL_WRITE_TIMEOUT_MS);
        if (!meta || !(meta.cover || meta.title || meta.media) || now() - noMetaAt < PL_NOCOL_RETRY_MS) { await legacy(); return; }
        try {
          await plWithTimeout(
            db.prepare('INSERT INTO parse_log (' + PL_COLS + ', cover, title, media) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .bind(...vals, meta.cover, meta.title, meta.media).run(),
            PL_WRITE_TIMEOUT_MS);
        } catch (e) {
          // 迁移前没有这三列：退回旧列再写一次（只在明确是「缺列」时重试，超时等别的错误不重试，避免重复写）
          if (!/no column named|no such column|has no column/i.test(String((e && e.message) || e))) throw e;
          noMetaAt = now();
          await legacy();
        }
      } catch {}
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
  function baseRow(request, input) {
    const cf = request.cf || {};
    const s = (v, n) => String(v == null ? '' : v).slice(0, n);
    return {
      ts: now(), url: plCleanUrl(input), ip: plIp(request), device: plDevice(request), fp: plFp(request),
      country: s(cf.country, 8).toUpperCase().replace(/[^A-Z]/g, ''), region: s(cf.region, 60), city: s(cf.city, 60),
      ua: s(request.headers.get('user-agent'), 200),
    };
  }
  const blockedResponse = () => plJson({ ok: false, code: -1, error: PL_BLOCK_MSG, msg: PL_BLOCK_MSG }, 403);
  async function check(request, env, ctx) {
    let hit = '';
    try { hit = await blockedBy(env, ctx, plIp(request), plDevice(request), plFp(request)); } catch { hit = ''; }
    return hit;
  }
  // 下载 / 媒体代理：只查黑名单，不记
  async function guard(request, env, ctx, run) {
    if (await check(request, env, ctx)) return blockedResponse();
    return run();
  }
  // 用法：return pl.wrap(request, env, ctx, () => handleParse(request, env));  handleParse 里过了人机验证和频控后调 plPass(request)，
  // 解析成功拿到结果后调 plMeta(request, { cover, title, media })
  async function wrap(request, env, ctx, run) {
    if (plIsPreview(request, env)) return plPreviewResponse();
    let input = '';
    try { input = await plInput(request); } catch {}
    const hit = await check(request, env, ctx);
    if (hit) {
      try {
        const t = now();
        if (!(t - (blockLogged.get(hit) || 0) < 60000)) {
          if (blockLogged.size > 500) blockLogged.clear();
          blockLogged.set(hit, t);
          write(env, ctx, { ...baseRow(request, input), ok: false, status: 403, reason: '已拉黑，拒绝解析' });
        }
      } catch {}
      return blockedResponse();
    }
    // 无效链接（空 / 不是本站 / 格式不对）：照常交给站点处理（它会 400），但不记
    let record = !!(env && env.PARSE_DB) && !plFlag(env && env.PARSE_LOG_OFF);
    if (record && valid) { try { record = !!valid(input); } catch { record = false; } }
    if (!record) return run();
    let resp;
    try {
      resp = await run();
    } catch (e) {
      try { if (PL_PASSED.has(request)) write(env, ctx, { ...baseRow(request, input), ok: false, status: 500, reason: plScrub((e && e.message) || e) }); } catch {}
      throw e;
    }
    try {
      if (resp && PL_PASSED.has(request)) {
        const row = baseRow(request, input);
        const status = resp.status;
        const isJson = (resp.headers.get('content-type') || '').toLowerCase().includes('json');
        const clone = isJson ? resp.clone() : null;
        const job = (async () => {
          let body = null;
          if (clone) { try { body = await clone.json(); } catch {} }
          // 失败：非 2xx，或 ok:false，或 code 不是 0 / 200（TikTok 成功 code=0，微博成功 code=200）；
          // 微博 code=200 但 msg='empty'（没有图片 / 视频）也算失败（v3 起并入原件，以前只在微博站的副本里）
          const empty = !!(body && body.code === 200 && body.msg === 'empty');
          const failed = empty || status >= 300 || !!(body && (body.ok === false || (typeof body.code === 'number' && body.code !== 0 && body.code !== 200)));
          const msg = empty ? '没有解析到图片或视频' : failed ? plScrub((body && (body.error || body.msg || body.message)) || ('HTTP ' + status)) : '';
          const meta = failed ? null : PL_META.get(request) || null;
          await write(env, ctx, { ...row, ok: !failed, status, reason: msg, meta });
        })().catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      }
    } catch {}
    return resp;
  }
  return { wrap, guard, isBlocked, write, _cache: cache };
}
// ==== parse-log v3 END ====
// 只记有效链接：和 handleParse 开头的本地校验同一套判断（空 / 不是本站链接 → 站点自己 400，不记）
const pl = createParseLog('kuaishou', { valid: (t) => { const u = String(t).trim() && extractKsUrl(t); if (!u) return false; try { return isKsHost(new URL(u).hostname); } catch { return false; } } });

const app = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/parse' && (request.method === 'POST' || request.method === 'GET'))
      return pl.wrap(request, env, ctx, () => handleParse(request, env));
    if (url.pathname === '/api/quota' && request.method === 'GET') return handleQuota(request, env);
    if (url.pathname === '/api/dl' && request.method === 'GET') return pl.guard(request, env, ctx, () => handleDl(request));
    if (url.pathname === '/api/feedback' && request.method === 'POST') return handleFeedback(request, env);
    // Turnstile 公开 site key（没配就返回空，前端据此跳过人机验证）
    if (url.pathname === '/api/turnstile-key')
      return json({ ok: true, siteKey: (env.TURNSTILE_SITE_KEY || '').trim(), required: !!(env.TURNSTILE_SECRET_KEY || '').trim() });
    if (url.pathname === '/api/stats') {
      if (!env.FEEDBACK_KV) return json({ ok: true, bound: false, parseCount: null, error: '未绑定 KV' });
      let n = null;
      try { n = Number((await env.FEEDBACK_KV.get('stats_parse_kuaishou')) || 0); } catch {}
      return json({ ok: true, bound: true, parseCount: n });
    }
    if (url.pathname === '/api/health') return json({ ok: true });
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: '接口不存在' }, 404);
    return env.ASSETS.fetch(request);
  },
};

// CORS 不再是 *：/api/* 只给本站来源（同源、kuaishoujiexi.pages.dev 及预览子域、ALLOWED_ORIGINS 里的自定义域名）回显 Origin，并带 Vary: Origin
export default {
  async fetch(request, env, ctx) {
    return applyCors(request, env, await app.fetch(request, env, ctx));
  },
};
