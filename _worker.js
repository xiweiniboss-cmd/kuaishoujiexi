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
function extractKsUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[.,;!?\]]+$/, '') : null;
}

function isKsHost(hostname) {
  return /(^|\.)kuaishou\.com$|(^|\.)gifshow\.com$|(^|\.)kuaishouapp\.com$|(^|\.)chenzhongtech\.com$/i.test(
    hostname || ''
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
  const kv = env.FEEDBACK_KV;
  if (!kv) return { ok: true };
  try {
    if (ip) {
      const lastTs = await kv.get('pcool_kuaishou_' + ipLimitKey(ip));
      if (lastTs) {
        const remain = PARSE_COOLDOWN_SECS - Math.floor((Date.now() - Number(lastTs)) / 1000);
        if (remain > 0) return { ok: false, error: '解析太频繁，请 ' + remain + ' 秒后再试' };
      }
    } else if (device && (await kv.get('cd_parse_kuaishou_' + device))) {
      return { ok: false, error: '操作太频繁，请等 60 秒后再解析' };
    }
    for (const k of quotaKeys(ip, device)) {
      const used = parseInt((await kv.get(k)) || '0', 10) || 0;
      if (used >= DAILY_LIMIT) return { ok: false, error: '今日解析次数已达上限（' + DAILY_LIMIT + ' 次），明天再来吧' };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}
async function markParse(env, request, ip, device) {
  const kv = env.FEEDBACK_KV;
  if (!kv) return;
  try {
    await kv.put('stats_parse_kuaishou', String((parseInt((await kv.get('stats_parse_kuaishou')) || '0', 10) || 0) + 1));
  } catch {}
  try {
    if (ip) await kv.put('pcool_kuaishou_' + ipLimitKey(ip), String(Date.now()), { expirationTtl: PARSE_COOLDOWN_SECS });
    if (device) await kv.put('cd_parse_kuaishou_' + device, '1', { expirationTtl: 60 });
    for (const k of quotaKeys(ip, device)) {
      const used = parseInt((await kv.get(k)) || '0', 10) || 0;
      await kv.put(k, String(used + 1), { expirationTtl: 60 * 60 * 48 });
    }
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
  if (secret) {
    if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
    if (!(await verifyTurnstile(tsToken, secret, ip)))
      return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  }

  const rate = await checkRate(env, ip, device);
  if (!rate.ok) return json({ ok: false, error: rate.error }, 429);

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
  return json({ ok: true, ...result });
}

// ---------- 配额查询 ----------
async function handleQuota(request, env) {
  const kv = env.FEEDBACK_KV;
  const u = new URL(request.url);
  const device = (u.searchParams.get('device') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const keys = quotaKeys(clientIp(request), device);
  if (!kv || !keys.length) return json({ ok: true, limited: false, limit: DAILY_LIMIT, remaining: DAILY_LIMIT });
  try {
    let used = 0;
    for (const k of keys) used = Math.max(used, parseInt((await kv.get(k)) || '0', 10) || 0);
    return json({ ok: true, limited: true, limit: DAILY_LIMIT, used, remaining: Math.max(0, DAILY_LIMIT - used) });
  } catch {
    return json({ ok: true, limited: false, limit: DAILY_LIMIT, remaining: DAILY_LIMIT });
  }
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
// ==== pf-recorder v1 BEGIN ====
// 解析失败记录器（各解析站共用同一份代码：allfeedback/shared/pf-recorder.js 是原件，改动后用 shared/pf-sync.mjs 同步到各站）
// 解析失败时按「站点 + 北京日期」聚合写进 FEEDBACK_KV 的 pf_<site>_<YYYY-MM-DD>，35 天后自动过期。
// 值：{ v:1, site, day, n:失败总数, reasons:{原因代码:次数}, msgs:{报错原文:次数}(最多 20 种), last:[最近 30 条样本], w:当天已写入次数, upd }
// 样本：{ t, url:去掉疑似令牌参数的链接, code, msg, st:本站返回的状态码, up:上游 HTTP 状态码(能识别时) }
// 省 KV 写入（免费版全账号每天约 1000 次写，而且这个 KV 和其他功能共用）：
//   - 同一个 isolate、同一站点，两次写入至少隔 PF_MIN_GAP_MS；间隔内的失败先攒在内存里，到点一起合并写一次；
//   - 当天这个键已写满 PF_SOFT_CAP 次后，改成至少隔 PF_CAP_GAP_MS 才写一次（计数继续在内存里累加，下次写时合并）。
// 读-改-写不是原子的，多个 isolate 同时写可能互相覆盖、丢几条统计，这是统计数据，可以接受。
// 全部在 waitUntil 里跑、所有异常都吞掉：绝不拖慢、也绝不影响解析接口本身的响应。
// 不记录：4xx（输入不对、人机验证、频率限制、今日次数用完等）。
const PF_TTL = 35 * 86400;
const PF_MIN_GAP_MS = 25000;
const PF_SOFT_CAP = 30;
const PF_CAP_GAP_MS = 30 * 60000;
const PF_SAMPLES = 30;
const PF_MSGS = 20;
const PF_URL_MAX = 300;
const PF_MSG_MAX = 120;
// 链接里只保留能定位作品的参数，其余（xsec_token、share_token、sign、timestamp、uid…）一律去掉
const PF_KEEP_PARAMS = new Set(['v', 'p', 'id', 'vid', 'bvid', 'aid', 'aweme_id', 'modal_id', 'item_id', 'photoid', 'list', 'index']);
// 兜底：即使是 5xx / ok:false，报错文字属于这些情况也不算解析失败
const PF_SKIP_RE = /人机验证|解析太频繁|今日解析次数|请先粘贴|只支持|不像|不是.{0,6}链接|没找到有效的链接|没有找到链接/;

function pfDay(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function pfCleanUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return '';
  const raw = m[0].replace(/[),.;!?\]}>»」』】，。；：？！）、]+$/, '');
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  u.username = '';
  u.password = '';
  u.hash = '';
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (PF_KEEP_PARAMS.has(k.toLowerCase()) && v.length <= 64) keep.append(k, v);
  const qs = keep.toString();
  u.search = qs ? '?' + qs : '';
  return u.toString().slice(0, PF_URL_MAX);
}
function pfClassify(status, msg) {
  const m = String(msg || '');
  const hm = m.match(/(?:HTTP|状态码|status)\s*[:：=]?\s*(\d{3})(?!\d)/i);
  const up = hm ? Number(hm[1]) : 0;
  let code = 'other';
  if (/未配置|not configured/i.test(m)) code = 'config';
  else if (status === 504 || /超时|timed? ?out|timeout|abort/i.test(m)) code = 'timeout';
  else if (up === 429 || up === 402 || /额度|积分|余额|quota|rate.?limit|too many requests|credit|balance/i.test(m)) code = 'upstream_quota';
  else if (up === 404 || /未找到|没找到|找不到|不存在|已删除|私密|无法获取|没有(?:找到)?(?:可下载的?)?(?:视频|图片|作品|内容|媒体)|no (?:video|media)|not found|unavailable|private/i.test(m)) code = 'no_media';
  else if (up) code = 'upstream_http';
  else if (/fetch failed|network|网络|连接|ECONN|DNS|TLS|SSL|socket/i.test(m)) code = 'network';
  else if (/JSON|Unexpected token|格式异常|返回异常|结构/i.test(m)) code = 'bad_upstream';
  return { code, up };
}
async function pfInput(request) {
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
function pfEmpty(site, day) {
  return { v: 1, site, day, n: 0, reasons: {}, msgs: {}, last: [], w: 0, upd: 0 };
}
function pfMerge(rec, p) {
  rec.n = (Number(rec.n) || 0) + p.n;
  if (!rec.reasons || typeof rec.reasons !== 'object') rec.reasons = {};
  for (const [k, c] of Object.entries(p.reasons)) rec.reasons[k] = (Number(rec.reasons[k]) || 0) + c;
  if (!rec.msgs || typeof rec.msgs !== 'object') rec.msgs = {};
  for (const [k, c] of Object.entries(p.msgs)) {
    if (k in rec.msgs || Object.keys(rec.msgs).length < PF_MSGS) rec.msgs[k] = (Number(rec.msgs[k]) || 0) + c;
  }
  rec.last = p.last.concat(Array.isArray(rec.last) ? rec.last : []).sort((a, b) => b.t - a.t).slice(0, PF_SAMPLES);
  return rec;
}
function createPfRecorder(site, opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const st = { pending: {}, lastWrite: 0, busy: 0 };

  function add(s) {
    const day = pfDay(s.t);
    const p = (st.pending[day] = st.pending[day] || pfEmpty(site, day));
    p.n++;
    p.reasons[s.code] = (p.reasons[s.code] || 0) + 1;
    if (s.msg && (s.msg in p.msgs || Object.keys(p.msgs).length < PF_MSGS)) p.msgs[s.msg] = (p.msgs[s.msg] || 0) + 1;
    p.last.unshift(s);
    if (p.last.length > PF_SAMPLES) p.last.length = PF_SAMPLES;
  }
  async function flush(kv) {
    const days = st.pending;
    st.pending = {};
    for (const day of Object.keys(days)) {
      const p = days[day];
      const key = 'pf_' + site + '_' + day;
      let rec = null;
      try { rec = JSON.parse((await kv.get(key)) || 'null'); } catch {}
      if (!rec || typeof rec !== 'object' || rec.v !== 1) rec = pfEmpty(site, day);
      const t = now();
      if ((Number(rec.w) || 0) >= PF_SOFT_CAP && t - (Number(rec.upd) || 0) < PF_CAP_GAP_MS) {
        // 今天写得够多了：先放回内存，过一阵再合并写
        const back = (st.pending[day] = st.pending[day] || pfEmpty(site, day));
        pfMerge(back, p);
        continue;
      }
      pfMerge(rec, p);
      rec.w = (Number(rec.w) || 0) + 1;
      rec.upd = t;
      try {
        await kv.put(key, JSON.stringify(rec), { expirationTtl: PF_TTL });
      } catch {}
    }
    st.lastWrite = now();
  }
  function record(env, ctx, info) {
    const kv = env && env.FEEDBACK_KV;
    if (!kv) return null;
    const t = now();
    add({
      t,
      url: pfCleanUrl(info.input),
      code: info.code || 'other',
      msg: String(info.msg || '').replace(/\s+/g, ' ').trim().slice(0, PF_MSG_MAX),
      st: Number(info.st) || 0,
      up: Number(info.up) || 0,
    });
    // 已经排好一次写入（且没有卡死）：这条会跟着那次一起写
    if (st.busy && t - st.busy < 60000) return null;
    st.busy = t;
    const wait = Math.max(0, PF_MIN_GAP_MS - (t - st.lastWrite));
    const job = (async () => {
      try {
        if (wait) await sleep(wait);
        await flush(kv);
      } catch {} finally {
        st.busy = 0;
      }
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
  function inspect(resp, input, env, ctx) {
    if (!resp || !env || !env.FEEDBACK_KV) return null;
    const status = resp.status;
    if (status >= 300 && status < 500) return null;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('json')) {
      return status >= 500 ? record(env, ctx, { input, code: 'other', msg: 'HTTP ' + status, st: status }) : null;
    }
    const clone = resp.clone();
    const job = (async () => {
      let body = null;
      try { body = await clone.json(); } catch {}
      const failed = status >= 500 || !!(body && (body.ok === false || (typeof body.code === 'number' && body.code !== 0)));
      if (!failed) return;
      const msg = body ? String(body.error || body.msg || body.message || '') : '';
      if (PF_SKIP_RE.test(msg)) return;
      const c = pfClassify(status, msg);
      await record(env, ctx, { input, code: c.code, up: c.up, msg, st: status });
    })().catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
  // 用法：return pf.wrap(request, env, ctx, () => handleParse(request, env));
  async function wrap(request, env, ctx, run) {
    let input = '';
    try { input = await pfInput(request); } catch {}
    let resp;
    try {
      resp = await run();
    } catch (e) {
      try { record(env, ctx, { input, code: 'exception', msg: (e && e.message) || String(e), st: 500 }); } catch {}
      throw e;
    }
    try { inspect(resp, input, env, ctx); } catch {}
    return resp;
  }
  return { wrap, record, inspect, flush, _state: st };
}
// ==== pf-recorder v1 END ====
const pf = createPfRecorder('kuaishou');

// ==== parse-log v1 BEGIN ====
// 解析记录 + 拉黑（各解析站共用同一份代码：allfeedback/shared/parse-log.js 是原件，改动后用 shared/pf-sync.mjs 同步）
// 存储：D1 数据库 parse_log（绑定名 PARSE_DB），表 parse_log / blocklist，建表语句见 allfeedback/shared/parse_log.sql。
// - 每次调用 /api/parse 记一行：时间、站点、链接（去掉令牌类参数）、成功与否、状态码、失败原因、IP、归属地（request.cf）、设备 ID、设备指纹、UA。
//   只记「有效链接」：站点传入的 valid(input) 返回 false（空输入 / 不是本站链接 / 链接格式不对，站点自己会直接 400）就不记。
// - 设备 ID：前端首次访问在 localStorage 生成的随机 UUID，放在请求头 X-Device-Id；格式不对就当没有。
// - 设备指纹：前端用 canvas 渲染、屏幕尺寸/色深、时区、语言、CPU 核数、平台、UA 算 SHA-256 取前 32 位十六进制，
//   放在请求头 X-Device-Fp；尽力而为（清缓存不变，但换浏览器/升级浏览器会变），格式不对就当没有。
// - 拉黑：解析前先查 blocklist（IP / 设备 ID / 指纹，每个 isolate 缓存 60 秒）；命中返回 403「访问受限」。
//   D1 没绑定 / 查询出错 / 超时一律放行（fail open），出错时沿用上一次成功读到的名单。
// - 写入全部在 waitUntil 里，出错吞掉，不影响解析响应。约 1% 的写入顺手删掉 30 天前的记录。
const PL_BLOCK_TTL_MS = 60000;
const PL_BLOCK_RETRY_MS = 10000;
const PL_BLOCK_TIMEOUT_MS = 1500;
const PL_RETENTION_MS = 30 * 86400 * 1000;
const PL_PRUNE_RATE = 0.01;
const PL_BLOCK_MSG = '访问受限';
const PL_FP_RE = /^[0-9a-f]{32}$/;
const PL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PL_KEEP_PARAMS = new Set(['v', 'p', 'id', 'vid', 'bvid', 'aid', 'aweme_id', 'modal_id', 'item_id', 'photoid', 'list', 'index']);

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
function plCleanUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return '';
  const raw = m[0].replace(/[),.;!?\]}>»」』】，。；：？！）、]+$/, '');
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
function plWithTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}
function createParseLog(site, opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const valid = typeof opts.valid === 'function' ? opts.valid : null;
  const rand = opts.random || Math.random;
  const cache = { set: null, at: 0, pending: null };
  const blockLogged = new Map(); // 被拉黑的请求：同一 IP / 设备每分钟最多记一行

  async function loadBlocklist(db) {
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
  }
  async function isBlocked(env, ip, device, fp) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function') return false;
    if (!cache.set || now() - cache.at >= PL_BLOCK_TTL_MS) {
      if (!cache.pending) cache.pending = loadBlocklist(db).finally(() => { cache.pending = null; });
      await cache.pending;
    }
    const s = cache.set;
    if (!s || !s.size) return false;
    if (ip && (s.has('ip:' + ip) || s.has('ip:' + plIp64(ip)))) return true;
    if (device && s.has('device:' + device)) return true;
    if (fp && s.has('fp:' + fp)) return true;
    return false;
  }
  function write(env, ctx, row) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function') return null;
    const job = (async () => {
      try {
        await db.prepare('INSERT INTO parse_log (ts, site, url, ok, status, reason, ip, country, region, city, device_id, fp, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(row.ts, site, row.url, row.ok ? 1 : 0, row.status, row.reason, row.ip, row.country, row.region, row.city, row.device, row.fp, row.ua).run();
        if (rand() < PL_PRUNE_RATE) await db.prepare('DELETE FROM parse_log WHERE ts < ?').bind(now() - PL_RETENTION_MS).run();
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
  const blockedResponse = () => new Response(JSON.stringify({ ok: false, code: -1, error: PL_BLOCK_MSG, msg: PL_BLOCK_MSG }), {
    status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  // 用法：return pl.wrap(request, env, ctx, () => handleParse(request, env));
  async function wrap(request, env, ctx, run) {
    let input = '';
    try { input = await plInput(request); } catch {}
    const ip = plIp(request), device = plDevice(request), fp = plFp(request);
    let blocked = false;
    try { blocked = await isBlocked(env, ip, device, fp); } catch { blocked = false; }
    if (blocked) {
      try {
        const k = ip + '|' + device + '|' + fp, t = now();
        if (!(t - (blockLogged.get(k) || 0) < 60000)) {
          if (blockLogged.size > 500) blockLogged.clear();
          blockLogged.set(k, t);
          write(env, ctx, { ...baseRow(request, input), ok: false, status: 403, reason: '已拉黑，拒绝解析' });
        }
      } catch {}
      return blockedResponse();
    }
    // 无效链接（空 / 不是本站 / 格式不对）：照常交给站点处理（它会 400），但不记
    let record = true;
    if (valid) { try { record = !!valid(input); } catch { record = false; } }
    if (!record) return run();
    let resp;
    try {
      resp = await run();
    } catch (e) {
      try { write(env, ctx, { ...baseRow(request, input), ok: false, status: 500, reason: String((e && e.message) || e).slice(0, 160) }); } catch {}
      throw e;
    }
    try {
      if (resp && env && env.PARSE_DB) {
        const row = baseRow(request, input);
        const status = resp.status;
        const isJson = (resp.headers.get('content-type') || '').toLowerCase().includes('json');
        const clone = isJson ? resp.clone() : null;
        const job = (async () => {
          let body = null;
          if (clone) { try { body = await clone.json(); } catch {} }
          // 失败：非 2xx，或 ok:false，或 code 不是 0 / 200（TikTok 成功 code=0，微博成功 code=200）
          const failed = status >= 300 || !!(body && (body.ok === false || (typeof body.code === 'number' && body.code !== 0 && body.code !== 200)));
          const msg = failed ? String((body && (body.error || body.msg || body.message)) || ('HTTP ' + status)).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
          await write(env, ctx, { ...row, ok: !failed, status, reason: msg });
        })().catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      }
    } catch {}
    return resp;
  }
  return { wrap, isBlocked, write, _cache: cache };
}
// ==== parse-log v1 END ====
// 只记有效链接：和 handleParse 开头的本地校验同一套判断（空 / 不是本站链接 → 站点自己 400，不记）
const pl = createParseLog('kuaishou', { valid: (t) => { const u = String(t).trim() && extractKsUrl(t); if (!u) return false; try { return isKsHost(new URL(u).hostname); } catch { return false; } } });

const app = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/parse' && (request.method === 'POST' || request.method === 'GET'))
      return pl.wrap(request, env, ctx, () => pf.wrap(request, env, ctx, () => handleParse(request, env)));
    if (url.pathname === '/api/quota' && request.method === 'GET') return handleQuota(request, env);
    if (url.pathname === '/api/dl' && request.method === 'GET') return handleDl(request);
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
