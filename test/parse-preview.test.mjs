// 解析记录预览卡片（parse-log v3）：成功解析时把封面 / 标题 / 类型写进 D1 parse_log；线上库没迁移时照样能写。运行：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const src = readFileSync(fileURLToPath(new URL('../_worker.js', import.meta.url)), 'utf8');
const file = join(mkdtempSync(join(tmpdir(), 'pv-')), 'w.mjs');
writeFileSync(file, src);
const worker = (await import(file)).default;

const BASE = `CREATE TABLE parse_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, site TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '', fp TEXT NOT NULL DEFAULT '');
CREATE TABLE blocklist (type TEXT NOT NULL, value TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY (type, value));
CREATE TABLE rate_counter (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL DEFAULT 0, exp INTEGER NOT NULL DEFAULT 0);`;
const MIGRATION = `ALTER TABLE parse_log ADD COLUMN cover TEXT DEFAULT ''; ALTER TABLE parse_log ADD COLUMN title TEXT DEFAULT ''; ALTER TABLE parse_log ADD COLUMN media TEXT DEFAULT '';`;
function fakeD1(migrated) {
  const db = new DatabaseSync(':memory:');
  db.exec(BASE); if (migrated) db.exec(MIGRATION);
  return { db, prepare(sql) {
    let args = [];
    const st = { bind(...a) { args = a; return st; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; } };
    return st;
  } };
}
let ipN = 10;
async function run(d1, data) {
  const jobs = []; const ctx = { waitUntil: (p) => jobs.push(p) };
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => String(u && u.url ? u.url : u).includes('/story/api/') ? new Response(JSON.stringify({ code: 2000, data })) : new Response('', { status: 404 });
  try {
    const r = new Request('https://example-site.pages.dev/api/parse?url=' + encodeURIComponent(LINK), { headers: { 'cf-connecting-ip': '198.51.100.' + (ipN++), 'x-device-id': '11111111-2222-4333-8444-555555555555' } });
    Object.defineProperty(r, 'cf', { value: { country: 'CN' } });
    const resp = await worker.fetch(r, { TURNSTILE_DISABLED: '1', PARSE_DB: d1, REDFOX_API_KEY: 'fake' }, ctx);
    while (jobs.length) await jobs.shift();
    return resp;
  } finally { globalThis.fetch = orig; }
}
const LINK = 'https://www.kuaishou.com/short-video/3xabcdefghijk';

test('快手视频：caption 当标题，coverUrl 当封面', async () => {
  const d1 = fakeD1(true);
  const r = await run(d1, { caption: '快手', coverUrl: 'https://p2.a.yximgs.com/c.jpg', srcNoMark: 'https://v2.kwaicdn.com/a.mp4' });
  assert.equal(r.status, 200, await r.clone().text());
  const row = d1.db.prepare('SELECT ok, cover, title, media FROM parse_log').get();
  assert.deepEqual({ ...row }, { ok: 1, cover: 'https://p2.a.yximgs.com/c.jpg', title: '快手', media: 'video' });
});

test('线上库还没迁移：照样记一行（退回旧列），解析响应不受影响', async () => {
  const d1 = fakeD1(false);
  const r = await run(d1, { caption: 't', srcNoMark: 'https://v2.kwaicdn.com/a.mp4' });
  assert.equal(r.status, 200);
  const rows = d1.db.prepare('SELECT ok FROM parse_log').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, 1);
});
