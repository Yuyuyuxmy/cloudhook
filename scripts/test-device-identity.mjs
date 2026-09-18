/**
 * 设备身份与 Token 生命周期冒烟测试（直接驱动真实模块，无需启动服务器）
 *
 * 覆盖：
 * 1. 永久 token（exp=0）签发/验证不被默认 30 天吞掉（lib 与 _shared 双份一致）
 * 2. verifyAuthToken ignoreExp：过期 token 可解出 payload 用于诊断
 * 3. 永久 token 的撤销标记不设 TTL；有时效标记按剩余期
 * 4. 登录三层匹配：previous_jti 续接（指纹漂移免疫）→ v2 指纹跨浏览器归并
 *    → legacy 指纹迁移升级；被吊销的 jti 不复用
 * 5. hook 链路：过期/吊销请求写 denied 访问日志；推送结果如实落库（push_error）
 *
 * 运行：node scripts/test-device-identity.mjs
 */

import * as sharedEdge from '../functions/_shared.js';
import * as secLib from '../lib/security.js';
import * as kvLib from '../lib/kv-store.js';
import { onRequestPost as loginPost } from '../functions/api/token.js';
import { onRequestPost as hookPost } from '../functions/api/hook.js';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
}

function createMockKv() {
  const store = new Map();
  const ttls = new Map();
  return {
    store, ttls,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); ttls.set(key, opts?.expirationTtl); },
    async delete(key) { store.delete(key); ttls.delete(key); }
  };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const settle = (ms = 80) => new Promise(r => setTimeout(r, ms));

const SECRET = 'test-hmac-secret';
const now = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// 1. buildTokenPayload：exp=0 / ttlSeconds=0 是合法「永久」，不得回退 30 天
// ---------------------------------------------------------------------------
for (const [tag, mod] of [['_shared', sharedEdge], ['lib', secLib]]) {
  const p1 = mod.buildTokenPayload('default', { iat: now, exp: 0, deviceName: 'X', jti: 'j' });
  check(`[${tag}] exp:0 保持永久`, p1.exp === 0, `got ${p1.exp}`);
  const p2 = mod.buildTokenPayload('default', { ttlSeconds: 0, deviceName: 'X', jti: 'j' });
  check(`[${tag}] ttlSeconds:0 → exp 0`, p2.exp === 0, `got ${p2.exp}`);
  const p3 = mod.buildTokenPayload('default', { iat: now, deviceName: 'X', jti: 'j' });
  check(`[${tag}] 默认 30 天`, p3.exp === now + 30 * 86400, `got ${p3.exp}`);
}

// 双份实现对同一入参必须产出可互验的 token（字段顺序一致）
{
  const opts = { iat: now, exp: 0, deviceName: 'MacBook', jti: 'cross-check' };
  const tShared = await sharedEdge.signTokenPayload(sharedEdge.buildTokenPayload('default', opts), SECRET);
  const tLib = await secLib.signTokenPayload(secLib.buildTokenPayload('default', opts), SECRET);
  check('lib 与 _shared 签发结果一致', tShared === tLib);
  check('永久 token 验证通过', (await sharedEdge.verifyAuthToken(tShared, SECRET, { full: true }))?.exp === 0);
}

// ---------------------------------------------------------------------------
// 2. ignoreExp：过期 token 签名有效时可解出 payload
// ---------------------------------------------------------------------------
{
  const expired = await sharedEdge.signTokenPayload(
    sharedEdge.buildTokenPayload('default', { iat: now - 100, exp: now - 10, deviceName: 'Old', jti: 'expired-jti' }),
    SECRET
  );
  check('过期 token 常规验证拒绝', (await sharedEdge.verifyAuthToken(expired, SECRET, { full: true })) === null);
  const p = await sharedEdge.verifyAuthToken(expired, SECRET, { full: true, ignoreExp: true });
  check('ignoreExp 解出过期 payload', p?.jti === 'expired-jti');
  check('[lib] ignoreExp 行为一致', (await secLib.verifyAuthToken(expired, SECRET, { full: true, ignoreExp: true }))?.jti === 'expired-jti');
  check('ignoreExp 不放过伪造签名', (await sharedEdge.verifyAuthToken(expired.slice(0, -4) + 'beef', SECRET, { full: true, ignoreExp: true })) === null);
}

// ---------------------------------------------------------------------------
// 3. 撤销标记 TTL：永久 token → 无 TTL；有时效 → 有 TTL（lib 与 _shared 一致）
// ---------------------------------------------------------------------------
for (const [tag, mod] of [['_shared', sharedEdge], ['lib', kvLib]]) {
  const kv = createMockKv();
  await mod.revokeToken(kv, 'aaaa-bbbb', 0);
  const permKey = [...kv.store.keys()][0];
  check(`[${tag}] 永久撤销标记无 TTL`, kv.ttls.get(permKey) === undefined, `ttl=${kv.ttls.get(permKey)}`);
  check(`[${tag}] key 已剥离连字符`, permKey === 'revoked_aaaabbbb', permKey);
  await mod.revokeToken(kv, 'cccc', 3600);
  check(`[${tag}] 有时效标记带 TTL`, kv.ttls.get('revoked_cccc') === 3600);
  check(`[${tag}] isTokenRevoked 命中`, (await mod.isTokenRevoked(kv, 'aaaa-bbbb')).revoked === true);
}

// ---------------------------------------------------------------------------
// 4. 登录三层匹配（驱动真实 /api/token 处理函数）
// ---------------------------------------------------------------------------
const kv = createMockKv();
const env = { HMAC_SECRET: SECRET, MASTER_PASSWORD: 'admin', cloudhook_kv: kv };
const pwdHash = await sha256Hex('admin');

async function doLogin(body) {
  const request = new Request('http://local/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ master_password: pwdHash, device_name: 'Web', ...body })
  });
  const res = await loginPost({ request, env });
  const json = await res.json();
  await settle(); // registerDevice 是异步落库
  return json;
}
const devices = () => JSON.parse(kv.store.get('user_default_devices') || '[]');

// a. 首次登录建档
const login1 = await doLogin({ device_fingerprint: 'FP2_A' });
check('首次登录成功', login1.success === true && !!login1.jti);
check('注册表 1 条记录', devices().length === 1 && devices()[0].fingerprint === 'FP2_A');
const J1 = login1.jti;

// b. 同浏览器重登：指纹漂移但 previous_jti 续接，指纹自愈为新值
const login2 = await doLogin({ previous_jti: J1, device_fingerprint: 'FP2_B' });
check('previous_jti 续接同一设备', login2.jti === J1);
check('指纹漂移不新建记录', devices().length === 1);
check('记录指纹升级为新值', devices()[0].fingerprint === 'FP2_B');

// c. 同机另一浏览器：无 previous_jti，靠 v2 指纹归并
const login3 = await doLogin({ device_fingerprint: 'FP2_B' });
check('跨浏览器指纹归并同一设备', login3.jti === J1 && devices().length === 1);

// d. 迁移：旧记录是 UUID 指纹 + 永久 token，legacy 指纹命中后升级、exp/iat 保留
const legacyIat = now - 86400 * 30;
kv.store.set('user_default_devices', JSON.stringify([
  ...devices(),
  { jti: 'legacy-jti', device_name: 'MacBook', fingerprint: 'old-uuid-fingerprint',
    created_at: '2026-06-20T11:49:14.112Z', iat: legacyIat, exp: 0 }
]));
const login4 = await doLogin({
  device_fingerprint: 'FP2_C',
  legacy_fingerprints: ['v1-hash-that-misses', 'old-uuid-fingerprint']
});
check('legacy 指纹命中旧记录', login4.jti === 'legacy-jti');
const migrated = devices().find(d => d.jti === 'legacy-jti');
check('旧记录指纹升级为 v2', migrated?.fingerprint === 'FP2_C');
check('永久有效期保留（exp=0）', migrated?.exp === 0 && login4.exp === 0);
check('原 iat 保留（token 可确定性重算）', migrated?.iat === legacyIat);
check('沿用用户改过的设备名', login4.device_name === 'MacBook');
const permanentToken = login4.token;

// e. 被吊销的 jti 不复用
await sharedEdge.revokeToken(kv, J1, 0);
const login5 = await doLogin({ previous_jti: J1, device_fingerprint: 'FP2_NEW' });
check('吊销后的 jti 不复活', login5.jti !== J1 && login5.success === true);

// ---------------------------------------------------------------------------
// 5. hook 链路：denied 落访问日志；推送结果如实记录
// ---------------------------------------------------------------------------
async function doHook(token, eventBody) {
  const request = new Request('http://local/api/hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CloudHook-Token': token, 'X-Hook-Event': 'Stop' },
    body: JSON.stringify(eventBody || { hook_event_name: 'Stop' })
  });
  const res = await hookPost({ request, env });
  const json = await res.json();
  await settle(); // 日志/推送为异步
  return json;
}
const accessLogs = () => JSON.parse(kv.store.get('user_default_accesslog') || '[]');
const events = () => JSON.parse(kv.store.get('user_default_events') || '[]');

// a. 过期 token：明确报 Token expired 并留 denied 日志
const expiredToken = await sharedEdge.signTokenPayload(
  sharedEdge.buildTokenPayload('default', { iat: now - 100, exp: now - 10, deviceName: 'WinBook', jti: 'win-old' }),
  SECRET
);
const hookExpired = await doHook(expiredToken);
check('hook 过期 token 报 Token expired', hookExpired.error === 'Token expired');
const deniedLog = accessLogs().find(l => l.reason === 'token_expired');
check('过期请求写 denied 访问日志（含 jti）', deniedLog?.result === 'denied' && deniedLog?.jti === 'win-old');

// b. 有效永久 token：allowed 日志 + 事件落库；未配 Bark 时 notified=false 且注明原因
const hookOk = await doHook(permanentToken);
check('hook 有效 token 成功', hookOk.success === true && hookOk.event_type === 'task_done');
check('allowed 访问日志写入', accessLogs().some(l => l.result === 'allowed' && l.jti === 'legacy-jti'));
const evt = events()[0];
check('事件日志如实记录推送失败原因', evt?.notified === false && evt?.push_error === 'bark_key_missing');

// c. 已吊销 token（J1 撤销标记来自上文）：denied 日志
const revokedToken = login2.token;
const hookRevoked = await doHook(revokedToken);
check('hook 吊销 token 报 Token revoked', hookRevoked.error === 'Token revoked');
check('吊销请求写 denied 访问日志', accessLogs().some(l => l.reason === 'token_revoked' && l.jti === J1));

// d. turn_paused：只记日志不推送，push_error 不误标
const hookPaused = await doHook(permanentToken, { hook_event_name: 'Stop', background_tasks: [{ id: 1 }] });
check('turn_paused 不推送', hookPaused.event_type === 'turn_paused' && hookPaused.notified === false);
const pausedEvt = events()[0];
check('turn_paused 无 push_error', pausedEvt?.event_type === 'turn_paused' && pausedEvt?.push_error === undefined);

// ---------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
console.log(`\n${failed.length === 0 ? '🎉 全部通过' : `💥 ${failed.length} 项失败`}（共 ${results.length} 项）`);
process.exit(failed.length === 0 ? 0 : 1);
