import {sqliteD1} from './helpers/d1.mjs';
// 分享域名白名单：v.kuaishou.cn 短链要认，冒充域名要拒。运行：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../_worker.js', import.meta.url)), 'utf8');
const file = join(mkdtempSync(join(tmpdir(), 'ks-')), 'w.mjs');
writeFileSync(file, src);
const mod = (await import(file)).default;

function memKV() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => void m.set(k, String(v)), delete: async (k) => void m.delete(k), list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }) };
}
let calls = [];
globalThis.fetch = async (u) => {
  const url = String(u && u.url ? u.url : u);
  calls.push(url);
  const h = new URL(url).hostname;
  if (h === 'v.kuaishou.cn' || h === 'v.kuaishou.com')
    return new Response('', { status: 302, headers: { location: 'https://www.kuaishou.com/short-video/3xabcdefg123456?share=1' } });
  return new Response('upstream broken', { status: 500 });
};
let n = 0;
async function parse(text) {
  calls = [];
  const env = { PARSE_DB:sqliteD1(), TURNSTILE_DISABLED: '1', FEEDBACK_KV: memKV(), REDFOX_API_KEY: 'fake', ASSETS: { fetch: async () => new Response('asset') } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const req = new Request('https://kuaishoujiexi.pages.dev/api/parse?url=' + encodeURIComponent(text), { headers: { 'cf-connecting-ip': '198.51.100.' + (++n) } });
  const r = await mod.fetch(req, env, ctx);
  return { status: r.status, body: await r.text(), calls };
}
const REJECT = '这不是快手链接';

for (const link of ['https://v.kuaishou.cn/2xYzAbC', 'https://v.kuaishou.com/2xYzAbC', 'https://www.kuaishou.com/short-video/3xabcdefg123456']) {
  test('接受 ' + link, async () => {
    const r = await parse(link + ' 复制此链接，打开【快手】直接观看！');
    assert.ok(!r.body.includes(REJECT), r.status + ' ' + r.body.slice(0, 160));
  });
}

test('v.kuaishou.cn 短链会被跟随', async () => {
  const r = await parse('https://v.kuaishou.cn/2xYzAbC');
  assert.ok(r.calls.some((u) => u.startsWith('https://v.kuaishou.cn/2xYzAbC')), r.calls.join('\n'));
});

for (const link of [
  'https://v.kuaishou.cn.evil.example/x',
  'https://fakekuaishou.cn/x',
  'https://kuaishou.cn-evil.com/x',
  'https://kuaishou.co/x',
  'https://evil.example/?u=https://v.kuaishou.cn/x',
]) {
  test('拒绝冒充域名 ' + link, async () => {
    const r = await parse(link);
    assert.equal(r.status, 400, r.body.slice(0, 160));
    assert.ok(r.body.includes(REJECT), r.body.slice(0, 160));
    assert.ok(!r.calls.some((u) => /evil|kuaishou\.co\//.test(u)), '不该去抓冒充域名：' + r.calls.join(','));
  });
}

// 没写 https:// 的裸链接
for (const text of [
  'v.kuaishou.com/2xYzAbC',
  'v.kuaishou.cn/2xYzAbC 复制此链接，打开【快手】直接观看！',
  'www.kuaishou.com/short-video/3xabcdefg123456',
]) {
  test('裸链接补 https:// 后接受 ' + text.slice(0, 40), async () => {
    const r = await parse(text);
    assert.ok(!r.body.includes(REJECT) && !r.body.includes('没找到'), r.status + ' ' + r.body.slice(0, 160));
    assert.ok(r.calls.length > 0 && r.calls.every((u) => /^https:\/\/((v\.|www\.)?kuaishou\.(com|cn)|redfox\.hk)\//i.test(u)), r.calls.join('\n'));
  });
}
for (const text of [
  'v.kuaishou.cn.evil.example/x',
  'fakekuaishou.cn/x',
  'kuaishou.cn-evil.com/x',
  'evil.example/?u=v.kuaishou.cn/x',
  'evil.example/v.kuaishou.com/x',
]) {
  test('裸链接冒充域名仍拒 ' + text, async () => {
    const r = await parse(text);
    assert.equal(r.status, 400, r.body.slice(0, 160));
    assert.ok(r.body.includes(REJECT) || r.body.includes('没找到'), r.body.slice(0, 160));
    assert.equal(r.calls.length, 0, '不该去抓：' + r.calls.join(','));
  });
}
