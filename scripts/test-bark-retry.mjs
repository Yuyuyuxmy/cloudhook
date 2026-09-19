/**
 * Bark 推送重试逻辑冒烟测试
 *
 * 用 mock fetch 覆盖真实网络，验证退避重试的关键契约：
 * 瞬时故障（超时 / 5xx）重试，确定性失败（无效 key / 4xx / Bark 错误码）不重试，
 * 以及总预算耗尽时不再发起新尝试——重试次数必须受 waitUntil 的 30s 窗口约束。
 *
 * 同一组用例对 lib/bark.js 与 functions/_shared.js 各跑一遍：
 * 两份副本是手工同步的（CLAUDE.md 约束 1），行为漂移必须能被测出来。
 *
 * 运行：node scripts/test-bark-retry.mjs
 */

import * as libBark from '../lib/bark.js';
import * as sharedBark from '../functions/_shared.js';

const IMPLS = [
  { name: 'lib/bark.js', mod: libBark },
  { name: 'functions/_shared.js', mod: sharedBark },
];

let pass = 0;
let fail = 0;
let impl = '';
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`✅ [${impl}] ${msg}`); }
  else { fail++; console.log(`❌ [${impl}] ${msg}`); }
};

const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
const barkOk = () => new Response(JSON.stringify({ code: 200, message: 'success' }), { status: 200 });

for (const { name, mod } of IMPLS) {
  impl = name;
  const { pushBark, testBarkPush } = mod;
  let calls = 0;
  let r;

  // 首次成功：不应产生额外请求
  calls = 0;
  globalThis.fetch = async () => { calls++; return barkOk(); };
  r = await pushBark('k', 'https://x.test', 't', 'b');
  ok(r.success === true, '首次成功 → success=true');
  ok(calls === 1, `首次成功不重试（实际 ${calls} 次）`);

  // 超时两次后成功：正是线上 Timeout 失败的场景，重试应救回
  calls = 0;
  globalThis.fetch = async () => { calls++; if (calls < 3) abort(); return barkOk(); };
  const started = Date.now();
  r = await pushBark('k', 'https://x.test', 't', 'b');
  const elapsed = Date.now() - started;
  ok(r.success === true, '超时 2 次后第 3 次成功 → success=true');
  ok(calls === 3, `共尝试 3 次（实际 ${calls} 次）`);
  ok(/3/.test(r.message), `消息标注重试次数："${r.message}"`);
  ok(elapsed >= 2700 && elapsed < 6000, `退避总耗时 ${elapsed}ms（期望约 2800ms = 800 + 2000）`);

  // Bark 业务错误码（key 无效）：确定性失败，重试无意义
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 400, message: 'key invalid' }), { status: 200 }); };
  r = await pushBark('k', 'https://x.test', 't', 'b');
  ok(r.success === false, '无效 key → success=false');
  ok(calls === 1, `确定性失败不重试（实际 ${calls} 次）`);

  // 4xx：同样是确定性失败
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('bad', { status: 404 }); };
  await pushBark('k', 'https://x.test', 't', 'b');
  ok(calls === 1, `HTTP 404 不重试（实际 ${calls} 次）`);

  // 5xx：服务端瞬时故障，应重试到上限
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('err', { status: 503 }); };
  r = await pushBark('k', 'https://x.test', 't', 'b');
  ok(calls === 3, `HTTP 503 重试到上限（实际 ${calls} 次）`);

  // 预算护栏：余量不足以完成一次有意义的尝试时必须停手
  calls = 0;
  globalThis.fetch = async () => { calls++; abort(); };
  await pushBark('k', 'https://x.test', 't', 'b', { budgetMs: 1500, maxAttempts: 3 });
  ok(calls === 1, `预算 1.5s 只够 1 次尝试（实际 ${calls} 次）`);

  // 测试推送走同步响应，预算收紧为 2 次，避免前端长时间空转
  calls = 0;
  globalThis.fetch = async () => { calls++; abort(); };
  await testBarkPush('k', 'https://x.test');
  ok(calls === 2, `testBarkPush 最多 2 次（实际 ${calls} 次）`);
}

console.log(`\n${fail === 0 ? '🎉 全部通过' : '⚠️ 存在失败'}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
