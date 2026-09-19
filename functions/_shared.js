/**
 * CloudHook - 边缘函数共享模块（自包含版）
 *
 * ⚠️ 与 lib/*.js 双份维护：此文件将所有 lib/ 中的共享代码打包在一起，
 *    供 functions/ 内的其他 API 文件使用同目录 import 引用，
 *    避免对 functions/ 目录外模块（../../lib/*.js）的运行时依赖。
 *
 * 用法（在 functions/api/*.js 中）:
 *   import { verifyAuthToken, resolveKv, ... } from '../_shared.js';
 *   import { verifyAuthToken } from '../../_shared.js';  // 子目录
 */

// ============================================================================
// security — 安全工具
// ============================================================================

export function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToArrayBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes.buffer;
}

export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 ? '='.repeat(4 - (padded.length % 4)) : '';
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(password));
  return arrayBufferToHex(hash);
}

export async function encrypt(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(key.padEnd(32, '0').slice(0, 32));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, keyMaterial, encoder.encode(plaintext)
  );
  return { iv: arrayBufferToHex(iv), ciphertext: arrayBufferToHex(encrypted) };
}

export async function decrypt(encryptedData, key) {
  const iv = hexToArrayBuffer(encryptedData.iv);
  const ciphertext = hexToArrayBuffer(encryptedData.ciphertext);
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(key.padEnd(32, '0').slice(0, 32));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, keyMaterial, ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

export async function verifyAuthToken(token, secret, options = {}) {
  try {
    if (!token || typeof token !== 'string') return null;
    const dotIndex = token.lastIndexOf('.');
    if (dotIndex <= 0) return null;
    const payloadStr = token.slice(0, dotIndex);
    const providedSig = token.slice(dotIndex + 1);
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC', key, hexToBytes(providedSig), encoder.encode(payloadStr)
    );
    if (!valid) return null;
    const payload = JSON.parse(base64UrlDecode(payloadStr));
    // exp === 0 means permanent; missing exp means invalid
    if (payload.exp === undefined || payload.exp === null) return null;
    // ignoreExp：签名照常验证，仅跳过过期检查。供 hook 链路区分
    // 「签名无效」与「签名有效但已过期」，用于访问日志与错误提示。
    if (!options.ignoreExp && payload.exp > 0) {
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) return null;
    }
    if (options.full) return payload.uid ? payload : null;
    return payload.uid || null;
  } catch { return null; }
}

export function buildTokenPayload(userId, options = {}) {
  const iat = options.iat || Math.floor(Date.now() / 1000);
  // ttlSeconds=0 → permanent (exp=0); undefined → default 30 days
  var exp;
  if (options.exp !== undefined) {
    exp = options.exp;
  } else if (options.ttlSeconds === 0) {
    exp = 0; // permanent
  } else {
    var ttl = options.ttlSeconds || 30 * 24 * 60 * 60;
    exp = iat + ttl;
  }
  return {
    uid: userId, iat, exp,
    dev: options.deviceName || 'Unknown Device',
    jti: options.jti || crypto.randomUUID()
  };
}

export async function signTokenPayload(payload, secret) {
  const payloadStr = base64UrlEncode(JSON.stringify(payload));
  const signature = await generateHmacSignature(payloadStr, secret);
  return `${payloadStr}.${signature}`;
}

export async function createAuthToken(userId, secret, options = {}) {
  const payload = buildTokenPayload(userId, options);
  return signTokenPayload(payload, secret);
}

export async function generateHmacSignature(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return arrayBufferToHex(sig);
}

export async function verifyPasswordHash(request, env) {
  try {
    const passwordHash = request.headers.get('X-Password-Hash');
    if (!passwordHash) return { valid: false, reason: 'missing_password_hash' };
    if (env.MASTER_PASSWORD_HASH) {
      const valid = timingSafeEqual(
        passwordHash.toLowerCase().trim(),
        env.MASTER_PASSWORD_HASH.toLowerCase().trim()
      );
      return { valid, reason: valid ? 'ok' : 'password_mismatch' };
    }
    if (env.MASTER_PASSWORD) {
      const expectedHash = await hashPassword(env.MASTER_PASSWORD);
      const valid = timingSafeEqual(
        passwordHash.toLowerCase().trim(), expectedHash.toLowerCase().trim()
      );
      return { valid, reason: valid ? 'ok' : 'password_mismatch' };
    }
    return { valid: false, reason: 'server_not_configured' };
  } catch { return { valid: false, reason: 'verification_error' }; }
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export function generateToken() { return crypto.randomUUID(); }

export function generateSecureRandom(length = 32) {
  return arrayBufferToHex(crypto.getRandomValues(new Uint8Array(length)));
}

/**
 * 统一请求鉴权：签名/有效期验证 + 吊销名单检查。
 * 所有管理端点（token/config/events/access-logs）应使用此函数替代裸 verifyAuthToken，
 * 否则被撤销的 token 仍能访问管理 API。
 *
 * 返回 { ok:true, payload, kv } 或 { ok:false, status, error }；
 * 调用方用各自文件的 jsonResponse 构造错误响应：
 *   const auth = await requireAuth(request, env);
 *   if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
 *
 * options.strict（默认 true）：吊销名单不可读（KV 未绑定/异常）时 fail-closed 返回 503。
 * 安全优先——无法确认吊销状态的管理操作不应放行。hook 通知链路不走此函数，保持 fail-open。
 */
export async function requireAuth(request, env, options = {}) {
  const strict = options.strict !== false;
  const token = request.headers.get('X-CloudHook-Token');
  if (!token) return { ok: false, status: 401, error: 'Missing token' };
  const payload = await verifyAuthToken(token, env.HMAC_SECRET, { full: true });
  if (!payload) return { ok: false, status: 401, error: 'Invalid token' };
  const kv = resolveKv(env);
  const { revoked, kvError } = await isTokenRevoked(kv, payload.jti);
  if (revoked) return { ok: false, status: 401, error: 'Token revoked' };
  if (kvError && strict) return { ok: false, status: 503, error: 'Auth store unavailable' };
  return { ok: true, payload, kv };
}

// ============================================================================
// kv-store — KV 存储操作
// ============================================================================

const EVENT_LOG_CAP = 100;
const ACCESS_LOG_CAP = 200;

const KV_BINDING_NAMES = ['cloudhook_kv', 'KV', 'kv', 'my_kv'];

export function resolveKv(env) {
  const isKv = (obj) => obj && typeof obj.get === 'function' && typeof obj.put === 'function';
  // Cloudflare Pages Functions：KV 绑定注入 env
  if (env) {
    for (const name of KV_BINDING_NAMES) {
      if (isKv(env[name])) return env[name];
    }
  }
  // 兼容旧运行时（EdgeOne 以全局变量注入）
  for (const name of KV_BINDING_NAMES) {
    try { if (isKv(globalThis[name])) return globalThis[name]; } catch { /* strict mode */ }
  }
  return null;
}

export function getDefaultConfig() {
  return {
    bark_key: '', bark_server: 'https://api.day.app',
    persona: { enabled: true, user_name: 'Betsy' },
    risk_control: {
      geo: { enabled: false, allowed_countries: [], allowed_regions: [] },
      ip: { mode: 'off', allowlist: [], blocklist: [] },
      rate_limit: { enabled: true, max_per_minute: 100 }
    },
    agents: {
      claude_code: { enabled: true },
      codex: { enabled: true },
      antigravity: { enabled: true },
      kimi_code: { enabled: true },
      unknown: { enabled: true }
    }
  };
}

export async function getUserConfig(kv, userId, env = {}) {
  if (kv) {
    try {
      const json = await kv.get(`user_${userId}_config`);
      if (json) return JSON.parse(json);
    } catch { /* fall through */ }
  }
  if (env.USER_CONFIG_JSON) {
    try { return JSON.parse(env.USER_CONFIG_JSON); } catch { /* fall through */ }
  }
  return getDefaultConfig();
}

export async function saveUserConfig(kv, userId, config) {
  if (kv) {
    try {
      await kv.put(`user_${userId}_config`, JSON.stringify(config));
      return { success: true, source: 'kv', message: 'Configuration saved successfully' };
    } catch { /* fall through */ }
  }
  return { success: false, source: 'none', message: 'KV unavailable' };
}

export async function logEvent(kv, userId, event) {
  try {
    const key = `user_${userId}_events`;
    const json = await kv.get(key);
    const events = json ? JSON.parse(json) : [];
    events.unshift(event);
    if (events.length > EVENT_LOG_CAP) events.length = EVENT_LOG_CAP;
    await kv.put(key, JSON.stringify(events));
    // 累计接收计数：独立于滚动窗口，清空/删除日志不回退
    const countKey = `user_${userId}_event_count`;
    const countStr = await kv.get(countKey);
    const count = countStr ? parseInt(countStr) : 0;
    await kv.put(countKey, String((Number.isFinite(count) ? count : 0) + 1));
  } catch { /* silent */ }
}

export async function getEvents(kv, userId, limit = 20, offset = 0, filter = {}) {
  try {
    const key = `user_${userId}_events`;
    const json = await kv.get(key);
    let events = json ? JSON.parse(json) : [];
    if (filter.type) events = events.filter(e => e.event_type === filter.type);
    if (filter.device) events = events.filter(e => e.jti === filter.device);
    if (filter.agent) events = events.filter(e => e.agent === filter.agent);
    // total_received：历史累计接收数（计数器缺失时用当前日志长度兜底）
    let totalReceived = events.length;
    try {
      const countStr = await kv.get(`user_${userId}_event_count`);
      const count = countStr ? parseInt(countStr) : 0;
      if (Number.isFinite(count) && count > totalReceived) totalReceived = count;
    } catch { /* 兜底已就绪 */ }
    return {
      events: events.slice(offset, offset + limit),
      total: events.length,
      total_received: totalReceived,
      has_more: offset + limit < events.length
    };
  } catch { return { events: [], total: 0, total_received: 0, has_more: false }; }
}

export async function checkRateLimit(kv, userId, endpoint, limit = 100) {
  try {
    const minute = Math.floor(Date.now() / 60000);
    const key = `ratelimit_${userId}_${endpoint}_${minute}`;
    const countStr = await kv.get(key);
    const count = countStr ? parseInt(countStr) : 0;
    if (count >= limit) return true;
    await kv.put(key, String(count + 1), { expirationTtl: 120 });
    return false;
  } catch { return false; }
}

export async function registerDevice(kv, uid, device) {
  try {
    const key = `user_${uid}_devices`;
    const json = await kv.get(key);
    const devices = json ? JSON.parse(json) : [];
    const idx = devices.findIndex(d => d.jti === device.jti);
    if (idx >= 0) devices[idx] = { ...devices[idx], ...device };
    else devices.unshift(device);
    if (devices.length > 50) devices.length = 50;
    await kv.put(key, JSON.stringify(devices));
  } catch { /* silent */ }
}

export async function getDevices(kv, uid) {
  try {
    const json = await kv.get(`user_${uid}_devices`);
    return json ? JSON.parse(json) : [];
  } catch { return []; }
}

export async function findDeviceByFingerprint(kv, uid, fingerprint) {
  if (!fingerprint) return null;
  try {
    const devices = await getDevices(kv, uid);
    return devices.find(d => d.fingerprint === fingerprint) || null;
  } catch { return null; }
}

export async function renameDevice(kv, uid, jti, newName) {
  const key = `user_${uid}_devices`;
  const json = await kv.get(key);
  if (!json) return false;
  const devices = JSON.parse(json);
  const idx = devices.findIndex(d => d.jti === jti);
  if (idx < 0) return false;
  devices[idx].device_name = newName;
  await kv.put(key, JSON.stringify(devices));
  return true;
}

export async function removeDevice(kv, uid, jti) {
  try {
    const key = `user_${uid}_devices`;
    const json = await kv.get(key);
    if (!json) return;
    const devices = JSON.parse(json).filter(d => d.jti !== jti);
    await kv.put(key, JSON.stringify(devices));
  } catch { /* silent */ }
}

/**
 * 吊销名单 KV key。KV key 统一只用字母/数字/下划线（历史上为兼容 EdgeOne KV 的限制，
 * Cloudflare KV 无此限制但保持格式不变以兼容已有数据）：
 * jti 是带连字符的 UUID，统一剥离非法字符，写入与读取共用此函数保证一致。
 * （旧的带连字符 key 成为孤儿，随 TTL 自然过期，无需迁移）
 */
function revokedKey(jti) {
  return `revoked_${String(jti).replace(/[^A-Za-z0-9_]/g, '')}`;
}

/**
 * 写撤销标记。ttlSeconds === 0 表示撤销的是永久 token：标记不设 TTL 永久保留
 * （否则标记到期消失后，被撤销的永久 token 会重新变为可用）。
 * 其余情况按剩余有效期设置 TTL，最短 60 秒。
 */
export async function revokeToken(kv, jti, ttlSeconds) {
  if (ttlSeconds === 0) {
    await kv.put(revokedKey(jti), '1');
    return;
  }
  const ttl = Math.max(60, Math.floor(ttlSeconds || 60));
  await kv.put(revokedKey(jti), '1', { expirationTtl: ttl });
}

/**
 * 检查 Token 是否被撤销。
 * 返回 { revoked, kvError }：区分「未撤销」与「吊销名单不可读」，
 * 由调用方决定 KV 异常时放行（hook 通知链路）还是拒绝（管理端点）。
 */
export async function isTokenRevoked(kv, jti) {
  if (!jti) return { revoked: false, kvError: false };
  if (!kv) return { revoked: false, kvError: true };
  try {
    const val = await kv.get(revokedKey(jti));
    return { revoked: val !== null && val !== undefined, kvError: false };
  } catch (error) {
    console.error('[CloudHook] Revocation check failed:', error);
    return { revoked: false, kvError: true };
  }
}

export async function writeAccessLog(kv, uid, log) {
  try {
    const key = `user_${uid}_accesslog`;
    const json = await kv.get(key);
    const logs = json ? JSON.parse(json) : [];
    const randBytes = crypto.getRandomValues(new Uint8Array(4));
    const rand = Array.from(randBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    logs.unshift({ id: log.id || `${Date.now()}_${rand}`, timestamp: log.timestamp || new Date().toISOString(), ...log });
    if (logs.length > ACCESS_LOG_CAP) logs.length = ACCESS_LOG_CAP;
    await kv.put(key, JSON.stringify(logs));
  } catch { /* silent */ }
}

export async function getAccessLogs(kv, uid, limit = 20, offset = 0, filter = {}) {
  try {
    const key = `user_${uid}_accesslog`;
    const json = await kv.get(key);
    let logs = json ? JSON.parse(json) : [];
    if (filter.device) logs = logs.filter(l => l.jti === filter.device);
    if (filter.agent) logs = logs.filter(l => l.agent === filter.agent);
    return { logs: logs.slice(offset, offset + limit), total: logs.length, has_more: offset + limit < logs.length };
  } catch { return { logs: [], total: 0, has_more: false }; }
}

// ============================================================================
// 日志删除函数
// ============================================================================

export async function deleteEvents(kv, userId, indices) {
  try {
    const key = `user_${userId}_events`;
    const json = await kv.get(key);
    const events = json ? JSON.parse(json) : [];
    const totalBefore = events.length;
    const validIndices = [...new Set(indices)]
      .filter(i => Number.isInteger(i) && i >= 0 && i < totalBefore)
      .sort((a, b) => b - a);
    for (const idx of validIndices) {
      events.splice(idx, 1);
    }
    const deleted = totalBefore - events.length;
    if (events.length === 0) {
      await kv.delete(key);
    } else {
      await kv.put(key, JSON.stringify(events));
    }
    return { success: true, deleted, remaining: events.length };
  } catch { return { success: false, deleted: 0, remaining: 0 }; }
}

export async function clearEvents(kv, userId) {
  try {
    const key = `user_${userId}_events`;
    const json = await kv.get(key);
    const events = json ? JSON.parse(json) : [];
    const deleted = events.length;
    await kv.delete(key);
    return { success: true, deleted, remaining: 0 };
  } catch { return { success: false, deleted: 0, remaining: 0 }; }
}

export async function deleteAccessLogs(kv, uid, ids) {
  try {
    const key = `user_${uid}_accesslog`;
    const json = await kv.get(key);
    const logs = json ? JSON.parse(json) : [];
    const totalBefore = logs.length;
    const idSet = new Set(ids);
    const filtered = logs.filter(l => !idSet.has(l.id));
    const deleted = totalBefore - filtered.length;
    if (filtered.length === 0) {
      await kv.delete(key);
    } else {
      await kv.put(key, JSON.stringify(filtered));
    }
    return { success: true, deleted, remaining: filtered.length };
  } catch { return { success: false, deleted: 0, remaining: 0 }; }
}

export async function clearAccessLogs(kv, uid) {
  try {
    const key = `user_${uid}_accesslog`;
    const json = await kv.get(key);
    const logs = json ? JSON.parse(json) : [];
    const deleted = logs.length;
    await kv.delete(key);
    return { success: true, deleted, remaining: 0 };
  } catch { return { success: false, deleted: 0, remaining: 0 }; }
}

export async function addPendingAction(kv, userId, actionId, actionData) {
  const data = { ...actionData, created_at: new Date().toISOString(), status: 'pending' };
  await kv.put(`user_${userId}_pending_${actionId}`, JSON.stringify(data), { expirationTtl: 300 });
}

export async function getPendingAction(kv, userId, actionId) {
  try {
    const json = await kv.get(`user_${userId}_pending_${actionId}`);
    return json ? JSON.parse(json) : null;
  } catch { return null; }
}

export async function clearPendingAction(kv, userId, actionId) {
  await kv.delete(`user_${userId}_pending_${actionId}`);
}

// ============================================================================
// risk — 风控
// ============================================================================

export function getClientIp(request) {
  try {
    const directIp = request.headers.get('CF-Connecting-IP')
      || request.headers.get('X-Real-IP') || request.headers.get('X-Client-IP');
    if (directIp) return directIp.trim();
    const forwardedFor = request.headers.get('X-Forwarded-For');
    if (forwardedFor) {
      const firstIp = forwardedFor.split(',').map(s => s.trim()).find(Boolean);
      if (firstIp) return firstIp;
    }
  } catch { /* ignore */ }
  return 'unknown';
}

function _normalizeLocVal(value, uppercase) {
  if (value == null || value === '') return null;
  const n = String(value).trim();
  return uppercase ? n.toUpperCase() : n;
}

export function getRequestLocation(request) {
  try {
    // Cloudflare 在 request.cf 注入地理信息，另有 CF-IPCountry 请求头兜底
    const cf = request?.cf ?? {};
    return {
      countryCode: _normalizeLocVal(cf.country, true) || _normalizeLocVal(request.headers.get('CF-IPCountry'), true) || _normalizeLocVal(request.headers.get('X-Geo-Country'), true),
      countryName: _normalizeLocVal(cf.country, false),
      regionCode: _normalizeLocVal(cf.regionCode, true) || _normalizeLocVal(request.headers.get('X-Geo-Region'), true),
      regionName: _normalizeLocVal(cf.region, false)
    };
  } catch {
    return { countryCode: null, countryName: null, regionCode: null, regionName: null };
  }
}

function _normalizeStringList(value, uppercase = false) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(i => String(i).trim()).filter(Boolean).map(i => uppercase ? i.toUpperCase() : i))];
}

export function checkGeoRestriction(geoConfig, request) {
  const location = getRequestLocation(request);
  try {
    if (!geoConfig || !geoConfig.enabled) return { allowed: true, location, reason: 'geo_disabled' };
    const ac = _normalizeStringList(geoConfig.allowed_countries, true);
    const ar = _normalizeStringList(geoConfig.allowed_regions, true);
    const countryAllowed = ac.length === 0 || (location.countryCode && ac.includes(location.countryCode));
    const regionAllowed = ar.length === 0 || (location.regionCode && ar.includes(location.regionCode))
      || (location.regionName && ar.includes(location.regionName.toUpperCase()));
    const allowed = countryAllowed && regionAllowed;
    return { allowed, location, reason: allowed ? 'geo_allowed' : `geo_blocked country=${location.countryCode || 'unknown'}` };
  } catch { return { allowed: true, location, reason: 'geo_check_error' }; }
}

export function checkIpAccess(ipConfig, ip) {
  try {
    const mode = ipConfig?.mode || 'off';
    if (mode === 'off') return { allowed: true, reason: 'ip_off' };
    const target = String(ip || '').trim();
    if (mode === 'allowlist') {
      const al = _normalizeStringList(ipConfig.allowlist, false);
      const ok = al.includes(target);
      return { allowed: ok, reason: ok ? 'ip_allowlisted' : `ip_not_in_allowlist ip=${target}` };
    }
    if (mode === 'blocklist') {
      const bl = _normalizeStringList(ipConfig.blocklist, false);
      const blocked = bl.includes(target);
      return { allowed: !blocked, reason: blocked ? `ip_blocklisted ip=${target}` : 'ip_allowed' };
    }
    return { allowed: true, reason: 'ip_unknown_mode' };
  } catch { return { allowed: true, reason: 'ip_check_error' }; }
}

// ============================================================================
// bark — Bark 推送
// ============================================================================

// 推送重试预算。waitUntil 的 30s 窗口从请求进入时开始计时（不是响应返回后重新计时），
// 响应约 300ms 返回，故给推送留 25s，其余留给 logEvent 写 KV。
// 单次 12s：Cloudflare 边缘到 Bark 服务器（腾讯云）路径偶发拥塞，8s 会误杀慢但可成的请求。
const PUSH_ATTEMPT_TIMEOUT_MS = 12000;
const PUSH_BUDGET_MS = 25000;
const PUSH_MAX_ATTEMPTS = 3;
const PUSH_BACKOFF_MS = [800, 2000];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchWithTimeout(url, init, timeoutMs = PUSH_ATTEMPT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

// 单次投递。retriable 区分瞬时故障（超时/网络异常/5xx）与确定性失败
// （无效 key、4xx、Bark 业务错误码）——后者重试只是浪费预算。
async function pushBarkOnce(endpoint, payload, timeoutMs) {
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'CloudHook/1.0' },
      body: JSON.stringify(payload)
    }, timeoutMs);
    const rawText = await response.text();
    if (!response.ok) {
      return { success: false, retriable: response.status >= 500, message: `Bark HTTP ${response.status}` };
    }
    try {
      const result = JSON.parse(rawText);
      if (result.code === 200) return { success: true, message: result.message || 'OK' };
      return { success: false, retriable: false, message: `Bark code ${result.code}` };
    } catch { return { success: false, retriable: false, message: 'Non-JSON response' }; }
  } catch (error) {
    return { success: false, retriable: true, message: error.name === 'AbortError' ? 'Timeout' : error.message };
  }
}

export async function pushBark(barkKey, barkServer = 'https://api.day.app', title, body, options = {}) {
  if (!barkKey || barkKey === 'YOUR_BARK_KEY') return { success: false, message: 'Bark key not configured' };
  if (!title || !body) return { success: false, message: 'Title or body missing' };
  const server = barkServer.replace(/\/$/, '');
  const endpoint = `${server}/${encodeURIComponent(barkKey)}`;
  const payload = { title, body, group: options.group || 'CloudHook', level: options.level || 'timeSensitive' };
  if (options.sound) payload.sound = options.sound;
  if (options.icon) payload.icon = options.icon;
  if (options.url) payload.url = options.url;

  const maxAttempts = options.maxAttempts || PUSH_MAX_ATTEMPTS;
  const budget = options.budgetMs || PUSH_BUDGET_MS;
  const startedAt = Date.now();
  let attempts = 0;
  let last = { message: 'push_failed' };

  for (let i = 1; i <= maxAttempts; i++) {
    const remaining = budget - (Date.now() - startedAt);
    if (remaining < 1000) break; // 余量不足以完成一次有意义的尝试
    attempts = i;
    last = await pushBarkOnce(endpoint, payload, Math.min(PUSH_ATTEMPT_TIMEOUT_MS, remaining));
    if (last.success) {
      return i === 1 ? last : { success: true, message: `${last.message} (retry ${i})` };
    }
    if (!last.retriable) return { success: false, message: last.message };
    const backoff = PUSH_BACKOFF_MS[i - 1] || 2000;
    if (i >= maxAttempts || budget - (Date.now() - startedAt) <= backoff + 1000) break;
    await sleep(backoff);
  }
  return { success: false, message: attempts > 1 ? `${last.message} (${attempts} attempts)` : last.message };
}

export async function testBarkPush(barkKey, barkServer = 'https://api.day.app') {
  return pushBark(barkKey, barkServer, 'CloudHook 测试',
    'CloudHook Bark 推送测试\n如果你收到这条消息，说明配置正确！',
    // 测试推送走同步响应，预算收紧避免前端长时间空转
    { group: 'CloudHook', level: 'active', maxAttempts: 2, budgetMs: 12000 });
}

// ============================================================================
// agent-detect — 来源识别
// ============================================================================

export const AGENT_NAMES = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  kimi_code: 'Kimi Code',
  unknown: '其他智能体'
};

// 显式标记归一化：trim → 小写 → 空格/连字符转下划线，再映射到内置 agent id
function _normalizeAgentId(raw) {
  try {
    const v = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (v === 'claude' || v === 'claudecode' || v === 'claude_code') return 'claude_code';
    if (v === 'codex' || v === 'codex_cli') return 'codex';
    if (v === 'antigravity' || v === 'agy' || v === 'gemini') return 'antigravity';
    if (v === 'kimi' || v === 'kimicode' || v === 'kimi_code' || v === 'kimi_code_cli') return 'kimi_code';
    return null;
  } catch { return null; }
}

// 第 1 层：显式标记（请求头 X-Agent-Type，取不到再取 query ?agent=）
function _detectByHeader(request) {
  try {
    let raw = request?.headers?.get?.('X-Agent-Type');
    if (!raw) {
      try { raw = new URL(request.url).searchParams.get('agent'); } catch { raw = null; }
    }
    if (!raw) return null;
    const id = _normalizeAgentId(raw) || 'unknown';
    return { id, name: AGENT_NAMES[id], source: 'header' };
  } catch { return null; }
}

// 第 2 层：User-Agent 规则表。curl / 空 UA 无法区分来源，不判定，落下一层
function _detectByUa(request) {
  try {
    const ua = (request?.headers?.get?.('User-Agent') || '').toLowerCase();
    if (!ua || ua.includes('curl')) return null;
    if (ua.includes('claude')) return { id: 'claude_code', name: AGENT_NAMES.claude_code, source: 'ua' };
    if (ua.includes('codex')) return { id: 'codex', name: AGENT_NAMES.codex, source: 'ua' };
    if (ua.includes('antigravity') || ua.includes('gemini')) return { id: 'antigravity', name: AGENT_NAMES.antigravity, source: 'ua' };
    if (ua.includes('kimi')) return { id: 'kimi_code', name: AGENT_NAMES.kimi_code, source: 'ua' };
    return null;
  } catch { return null; }
}

// 第 3 层：payload 形状推断。Codex/Antigravity 只能 curl 转发，UA 恒为 curl/x.y，
// 只能靠字段形状区分；顺序即优先级，命中即返回
function _detectByShape(rawEvent) {
  try {
    if (!rawEvent || typeof rawEvent !== 'object') return null;

    // Kimi Code：hooks runner 给每个 payload 注入 client_type，一锤定音。
    // 必须先于 codex 判据——Kimi 的 TurnStarted/PermissionRequest 带 turn_id、
    // SessionStart 带 model，落到 codex 判据会被误判为 Codex
    if (rawEvent.client_type === 'kimi_code_cli') {
      return { id: 'kimi_code', name: AGENT_NAMES.kimi_code, source: 'shape' };
    }

    if (rawEvent.conversationId !== undefined && (
      rawEvent.toolCall !== undefined ||
      rawEvent.terminationReason !== undefined ||
      rawEvent.invocationNum !== undefined ||
      rawEvent.stepIdx !== undefined
    )) {
      return { id: 'antigravity', name: AGENT_NAMES.antigravity, source: 'shape' };
    }
    // 注意：不用 agent_type 作为 codex 判据 —— Claude Code 的 SubagentStop 事件
    // 也带 agent_type 字段，用它判断会把 Claude Code 误判为 Codex
    if (rawEvent.hook_event_name !== undefined && (
      rawEvent.turn_id !== undefined || rawEvent.model !== undefined
    )) {
      return { id: 'codex', name: AGENT_NAMES.codex, source: 'shape' };
    }
    // Codex 旧版 notify 通道
    if (rawEvent.type === 'agent-turn-complete') {
      return { id: 'codex', name: AGENT_NAMES.codex, source: 'shape' };
    }
    if (rawEvent.hook_event_name !== undefined || rawEvent.transcript_path !== undefined || rawEvent.session_id !== undefined) {
      return { id: 'claude_code', name: AGENT_NAMES.claude_code, source: 'shape' };
    }
    return null;
  } catch { return null; }
}

/**
 * 多信号来源识别：显式头 → UA → payload 形状 → 兜底。
 * rawEvent 可能为 null（body 尚未解析时的降级调用），全程容错，不抛异常。
 * @param {Request} request - Fetch API Request 对象
 * @param {object|null} rawEvent - 已解析的请求体（可能为 null）
 * @returns {{id: string, name: string, source: 'header'|'ua'|'shape'|'fallback'}}
 */
export function detectAgent(request, rawEvent) {
  try {
    const byHeader = _detectByHeader(request);
    if (byHeader) return byHeader;
  } catch { /* 降级到下一层 */ }
  try {
    const byUa = _detectByUa(request);
    if (byUa) return byUa;
  } catch { /* 降级到下一层 */ }
  try {
    const byShape = _detectByShape(rawEvent);
    if (byShape) return byShape;
  } catch { /* 降级到兜底 */ }
  return { id: 'unknown', name: AGENT_NAMES.unknown, source: 'fallback' };
}

// ============================================================================
// classifier — 事件分类
// ============================================================================

const PERM_KW_EN = ['permission','permissions','allow','approve','approval','confirm','confirmation',
  'needs your attention','waiting for input','waiting for user','requires user','user action required','permission_prompt'];
const PERM_KW_ZH = ['权限','允许','批准','确认','等待用户','需要你','需要用户','需要操作','是否继续','请确认'];

// 'PermissionRequest' 事件名（历史上因 EdgeOne WAF 拦截字面量而用 fromCharCode 构建，
// Cloudflare 无此限制，保留写法以与 lib/classifier.js 逐行对照）
var _PERM_EVT = String.fromCharCode(80,101,114,109,105,115,115,105,111,110,82,101,113,117,101,115,116);

export function classify(parsed, agentId) {
  const eventName = parsed.event_name || '';

  if (agentId === 'codex') {
    if (eventName === _PERM_EVT) return 'permission_required';
    if (eventName === 'Stop') return 'task_done';
    if (eventName === 'SubagentStop') return 'turn_paused';
    return 'info';
  }

  if (agentId === 'kimi_code') {
    if (eventName === _PERM_EVT) return 'permission_required';
    if (eventName === 'Stop') return 'task_done';
    if (eventName === 'SubagentStop') return 'turn_paused';
    if (eventName === 'StopFailure' || eventName === 'PostToolUseFailure') return 'attention_required';
    if (eventName === 'Notification') {
      // Kimi 的 Notification 是后台任务状态变化（task.completed/task.failed 等），
      // 语义与 Claude Code 的 Notification（权限/空闲提醒）完全不同，不走关键词扫描
      const nt = String((parsed.raw_event && parsed.raw_event.notification_type) || '');
      if (nt.includes('failed')) return 'attention_required';
      if (nt.includes('completed')) return 'task_done';
      return 'info';
    }
    return 'info';
  }

  if (agentId === 'antigravity') {
    if (eventName === 'PreToolUse') return 'permission_required';
    if (eventName === 'Stop') {
      return (parsed.raw_event && parsed.raw_event.fullyIdle === false) ? 'turn_paused' : 'task_done';
    }
    return 'info';
  }

  // claude_code / unknown / 未传 agentId：现状完全不变
  if (eventName === _PERM_EVT) return 'permission_required';
  if (eventName === 'Notification') {
    const t = (parsed.text_lower || parsed.raw_text || '').toLowerCase();
    for (const kw of PERM_KW_EN) if (t.includes(kw)) return 'permission_required';
    for (const kw of PERM_KW_ZH) if (t.includes(kw)) return 'permission_required';
    return 'attention_required';
  }
  if (eventName === 'Stop') {
    // Claude Code v2.1.145+：background_tasks 非空 = 本轮结束但仍有后台任务（subagent 等），
    // 不是任务真正完成；字段缺失（旧版本）时保持 task_done 兼容
    const bg = parsed.raw_event && parsed.raw_event.background_tasks;
    if (Array.isArray(bg) && bg.length > 0) return 'turn_paused';
    return 'task_done';
  }
  return 'info';
}

// ============================================================================
// message-builder — 消息构建
// ============================================================================

const RISK_MAP = {
  'permission_required': 'high',
  'attention_required': 'medium',
  'task_done': 'low',
  'turn_paused': 'low',
  'info': 'low'
};

// 只读 Bash 命令（低风险）
const SAFE_CMDS = ['ls','cat','head','tail','find','grep','wc','which','echo','printf',
  'date','pwd','whoami','uname','hostname','env','printenv','df','du','file','stat',
  'git status','git log','git diff','git show','git branch','git remote','git tag',
  'npm list','npm ls','npm view','node -v','python --version','pip list'];

// 中等风险命令（修改但不破坏性）
const MEDIUM_CMDS = ['cp','mkdir','touch','ln','rename','sort','uniq','tee','xargs',
  'chmod','chown','chgrp','pip install','npm install','apt install','yum install',
  'brew install','mv','git checkout','git switch','git merge','git rebase',
  'git stash','git add','git commit','docker run','docker build',
  'docker compose up','systemctl restart','systemctl reload',
  'tar','gzip','gunzip','zip','unzip','curl','wget','ssh','scp','rsync'];

export function assessBashRisk(cmd) {
  var c = cmd.trim().toLowerCase();
  // sudo → critical
  if (/\bsudo\b/.test(c)) return 'critical';
  // rm -rf 危险路径 → critical
  if (/rm\s+.*-[a-z]*r[a-z]*f/.test(c) && /\/\s|\/\.\.\s|\*\s|\.\.\//.test(c)) return 'critical';
  // 危险操作 → high
  if (/\b(rm|kill|killall|pkill|dd|mkfs|fdisk|shutdown|reboot|halt|poweroff)\b/.test(c)) return 'high';
  // curl/wget 管道到 sh → high
  if (/(curl|wget).*\|\s*(ba)?sh/.test(c)) return 'high';
  // git push --force → high
  if (/git\s+push.*--force/.test(c)) return 'high';
  // npm publish → high
  if (/npm\s+publish/.test(c)) return 'high';
  // 中等风险命令
  for (var i = 0; i < MEDIUM_CMDS.length; i++) {
    if (c.startsWith(MEDIUM_CMDS[i])) return 'medium';
  }
  // 只读命令 → low
  for (var j = 0; j < SAFE_CMDS.length; j++) {
    if (c.startsWith(SAFE_CMDS[j])) return 'low';
  }
  // 未知命令 → medium（保守估计）
  return 'medium';
}

export function getRiskLevel(eventType, parsed) {
  if (eventType === 'permission_required' && parsed) {
    var tool = (parsed.tool_name || '').toLowerCase();
    // Bash 命令类（Antigravity 的 run_command 同路）
    if (tool === 'bash' || tool === 'run_command') {
      var cmd = (parsed.tool_input && parsed.tool_input.command) || '';
      return assessBashRisk(cmd);
    }
    // 文件读取类工具（含 Antigravity 只读工具）
    if (tool === 'read' || tool === 'glob' || tool === 'grep' || tool === 'list' ||
      tool === 'view_file' || tool === 'list_dir' || tool === 'find_by_name' || tool === 'grep_search') return 'low';
    // 文件写入类工具（含 Antigravity 写入工具）
    if (tool === 'write' || tool === 'edit' || tool === 'multiedit' || tool === 'notebookedit' ||
      tool === 'write_to_file' || tool === 'replace_file_content' || tool === 'multi_replace_file_content' || tool === 'apply_patch') return 'medium';
    // WebFetch / WebSearch（含 Antigravity 网络工具）
    if (tool === 'webfetch' || tool === 'websearch' || tool === 'search_web' || tool === 'read_url_content') return 'low';
    // 其他未知工具 → medium
    return 'medium';
  }
  return RISK_MAP[eventType] || 'low';
}

export function buildMessage(eventType, parsed = null, _d1 = null, _d2 = null, _d3 = null,
  extraSummary = '', config = null, deviceName = null, agentName = 'Claude Code') {
  const personaEnabled = config?.persona?.enabled !== false;
  const userName = personaEnabled ? (config?.persona?.user_name || 'Betsy') : '';
  const device = deviceName || 'Unknown Device';
  let title;
  if (eventType === 'permission_required') title = `${agentName} 需要权限`;
  else if (eventType === 'attention_required') title = `${agentName} 需要你`;
  else if (eventType === 'task_done') title = `${agentName} 已完成`;
  else if (eventType === 'turn_paused') title = `${agentName} 本轮结束`;
  else title = `${agentName} 提醒`;
  let body = '';
  switch (eventType) {
    case 'permission_required': {
      const summary = extraSummary || parsed?.summary || '等待用户允许操作';
      const prefix = userName ? `${userName}，${device} 上的 ${agentName} ` : `${device} 上的 ${agentName} `;
      const fixedText = '需要你允许操作\n操作：';
      const maxLen = 80 - prefix.length - fixedText.length - 3;
      body = `${prefix}${fixedText}${summary.length > maxLen ? summary.slice(0, maxLen) + '...' : summary}`;
      break;
    }
    case 'attention_required': {
      // Claude Code 的 Notification payload 中 title/message 是顶层字段，不在 notification 子对象里；
      // 兼容保留 notification.title/message 以防其他来源用了嵌套结构
      const t = parsed?.raw_event?.title || parsed?.raw_event?.message ||
        parsed?.raw_event?.notification?.title || parsed?.raw_event?.notification?.message || '请求你的注意';
      body = userName ? `${userName}，${device} 上的 ${agentName} ${t}` : `${device} 上的 ${agentName} ${t}`;
      if (body.length > 80) body = body.slice(0, 77) + '...';
      break;
    }
    case 'task_done': {
      body = userName ? `${userName}，${device} 上的 ${agentName} 已经完成了任务` : `${device} 上的 ${agentName} 已经完成了任务`;
      break;
    }
    case 'turn_paused': {
      const bg = parsed?.raw_event?.background_tasks;
      const n = Array.isArray(bg) ? bg.length : 0;
      const suffix = n > 0 ? `本轮结束，仍有 ${n} 个后台任务运行中` : '本轮结束，后台任务运行中';
      body = userName ? `${userName}，${device} 上的 ${agentName} ${suffix}` : `${device} 上的 ${agentName} ${suffix}`;
      break;
    }
    default:
      body = userName ? `${userName}，${device} 上的 ${agentName} 事件` : `${device} 上的 ${agentName} 事件`;
  }
  return { title, body };
}

// ============================================================================
// waitUntil 安全封装
// ============================================================================

export function safeWaitUntil(context, promise) {
  if (typeof context.waitUntil === 'function') {
    try { context.waitUntil(promise); return; } catch { /* 降级 */ }
  }
  promise.catch(() => {});
}
