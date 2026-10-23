// 快手无水印解析下载站（Cloudflare Pages 单文件 Worker）
// 根目录放 _worker.js：/api/* 走这里，其余走 env.ASSETS 静态资源
// 解析通道：RedFoxHub /story/api/parseWork/videoDownload/kuaishou（主）
//          + 快手分享页 HTML 提取 srcNoMark（兜底，无需 key）
// 需要环境变量 REDFOX_API_KEY（与其他解析站共用同一个 key）
// 反馈/限流（可选）：KV 绑定 FEEDBACK_KV，与其他站共用；未绑定时自动跳过
// 人机验证（可选）：TURNSTILE_SECRET_KEY，配了才校验

const REDFOX_BASE = 'https://redfox.hk';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DAILY_LIMIT = 20;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
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
        cur = new URL(loc, cur).toString();
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
  const pageUrl = canonicalKsUrl(finalUrl) || finalUrl;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(pageUrl, {
      headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/', Accept: 'text/html' },
      signal: ctrl.signal,
    });
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
function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
async function checkRate(env, device) {
  const kv = env.FEEDBACK_KV;
  if (!kv || !device) return { ok: true };
  try {
    const cdKey = 'cd_parse_kuaishou_' + device;
    if (await kv.get(cdKey)) return { ok: false, error: '操作太频繁，请等 60 秒后再解析' };
    const qKey = 'quota_kuaishou_' + todayStr() + '_' + device;
    const used = parseInt((await kv.get(qKey)) || '0', 10) || 0;
    if (used >= DAILY_LIMIT) return { ok: false, error: '今日解析次数已达上限（' + DAILY_LIMIT + ' 次），明天再来吧' };
    return { ok: true, used };
  } catch {
    return { ok: true };
  }
}
async function markParse(env, device) {
  const kv = env.FEEDBACK_KV;
  if (!kv) return;
  try {
    await kv.put('stats_parse_kuaishou', String((parseInt((await kv.get('stats_parse_kuaishou')) || '0', 10) || 0) + 1));
  } catch {}
  if (!device) return;
  try {
    await kv.put('cd_parse_kuaishou_' + device, '1', { expirationTtl: 60 });
    const qKey = 'quota_kuaishou_' + todayStr() + '_' + device;
    const used = parseInt((await kv.get(qKey)) || '0', 10) || 0;
    await kv.put(qKey, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  } catch {}
}

// ---------- 解析接口 ----------
async function handleParse(request, env) {
  let shareText = '';
  let tsToken = '';
  let device = '';
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      shareText = String(body.url || body.text || '');
      tsToken = String(body.tsToken || body['cf-turnstile-response'] || '');
      device = String(body.device || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    } catch {}
  }
  if (!shareText) {
    const u = new URL(request.url);
    shareText = u.searchParams.get('url') || '';
    device = (u.searchParams.get('device') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  }
  if (!shareText.trim()) return json({ ok: false, error: '请先粘贴快手分享链接' }, 400);

  const secret = (env.TURNSTILE_SECRET_KEY || '').trim();
  if (secret) {
    const ip = request.headers.get('cf-connecting-ip') || '';
    if (!(await verifyTurnstile(tsToken, secret, ip)))
      return json({ ok: false, error: '人机验证未通过，请刷新页面重试' }, 403);
  }

  const rate = await checkRate(env, device);
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
  await markParse(env, device);
  return json({ ok: true, ...result });
}

// ---------- 配额查询 ----------
async function handleQuota(request, env) {
  const kv = env.FEEDBACK_KV;
  const u = new URL(request.url);
  const device = (u.searchParams.get('device') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!kv || !device) return json({ ok: true, limited: false, limit: DAILY_LIMIT, remaining: DAILY_LIMIT });
  try {
    const used = parseInt((await kv.get('quota_kuaishou_' + todayStr() + '_' + device)) || '0', 10) || 0;
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
  const allowed =
    /(^|\.)yximgs\.com$|(^|\.)kwimgs\.com$|(^|\.)kwaicdn\.com$|(^|\.)kuaishou\.com$|(^|\.)gifshow\.com$|(^|\.)chenzhongtech\.com$|(^|\.)kuaishouapp\.com$/i;
  if (!/^https:$/.test(target.protocol) || !allowed.test(target.hostname))
    return json({ ok: false, error: '不支持的下载地址' }, 400);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const resp = await fetch(mediaUrl, {
      headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/', Accept: '*/*' },
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) return json({ ok: false, error: '下载失败（HTTP ' + resp.status + '）' }, 502);
    const h = new Headers();
    h.set('Content-Type', resp.headers.get('content-type') || 'application/octet-stream');
    const len = resp.headers.get('content-length');
    if (len) h.set('Content-Length', len);
    h.set('Content-Disposition', 'attachment; filename="' + filename + '"');
    h.set('Cache-Control', 'no-store');
    h.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: 200, headers: h });
  } catch (e) {
    return json({ ok: false, error: '下载失败：' + (e.message || '网络错误') }, 502);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 反馈（与其他站共用 FEEDBACK_KV，带 [快手站] 标记） ----------
async function handleFeedback(request, env) {
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '反馈功能暂未启用' }, 500);
  let message = '',
    contact = '',
    device = '';
  try {
    const body = await request.json();
    message = String(body.message || '').trim().slice(0, 2000);
    contact = String(body.contact || '').trim().slice(0, 120);
    device = String(body.device || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  } catch {}
  if (!message) return json({ ok: false, error: '请先写点内容再提交' }, 400);
  const kv = env.FEEDBACK_KV;
  try {
    if (device && (await kv.get('cd_feedback_' + device)))
      return json({ ok: false, error: '提交太频繁，请 10 分钟后再试' }, 429);
  } catch {}
  const id = 'fb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const rec = {
    id,
    site: '[快手站]',
    message,
    contact,
    page: 'kuaishoujiexi',
    device,
    ts: Date.now(),
    files: [],
  };
  try {
    await kv.put('feedback_' + id, JSON.stringify(rec));
    if (device) await kv.put('cd_feedback_' + device, '1', { expirationTtl: 600 });
  } catch {
    return json({ ok: false, error: '提交失败，请稍后重试' }, 500);
  }
  return json({ ok: true, id });
}

// ---------- 主路由 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/parse' && (request.method === 'POST' || request.method === 'GET'))
      return handleParse(request, env);
    if (url.pathname === '/api/quota' && request.method === 'GET') return handleQuota(request, env);
    if (url.pathname === '/api/dl' && request.method === 'GET') return handleDl(request);
    if (url.pathname === '/api/feedback' && request.method === 'POST') return handleFeedback(request, env);
    if (url.pathname === '/api/health') return json({ ok: true, redfox: !!(env.REDFOX_API_KEY || '').trim() });
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: '接口不存在' }, 404);
    return env.ASSETS.fetch(request);
  },
};
