// 前端的域名判断要和后端 isKsHost 一致：chenzhongtech.com / kuaishouapp.com 这类真快手域名不能在前端就被拦掉
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const worker = readFileSync(fileURLToPath(new URL('../_worker.js', import.meta.url)), 'utf8');
function grab(src, re) { const m = src.match(re); assert.ok(m, '没找到 ' + re); return m[0]; }
const isKsUrl = new Function(grab(html, /const KS_HOSTS = [^\n]+\n/) + grab(html, /function isKsUrl\(u\) \{[\s\S]*?\n\}\n/) + 'return isKsUrl;')();
const isKsHost = new Function(grab(worker, /function isKsHost\(hostname\) \{[\s\S]*?\n\}\n/) + 'return isKsHost;')();
const both = (u) => [isKsUrl(u), isKsHost(new URL(u).hostname)];

for (const u of [
  'https://v.kuaishou.com/2xYzAbC', 'https://v.kuaishou.cn/2xYzAbC', 'https://www.kuaishou.com/short-video/3xabc',
  'https://v.m.chenzhongtech.com/fw/photo/3xabc', 'https://www.kuaishouapp.com/short-video/3xabc', 'https://www.gifshow.com/s/abc',
  'https://V.KUAISHOU.COM./abc',
]) test('前后端都接受 ' + u, () => assert.deepEqual(both(u), [true, true]));

for (const u of [
  'https://kuaishou.com.evil.example/x', 'https://fakekuaishou.com/x', 'https://chenzhongtech.com-evil.com/x',
  'https://evilchenzhongtech.com/x', 'https://kuaishouapp.co/x', 'https://evil.example/?u=https://v.kuaishou.com/x',
  'https://evil.example/kuaishou/gifshow',
]) test('前后端都拒绝 ' + u, () => assert.deepEqual(both(u), [false, false]));
