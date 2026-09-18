/**
 * CloudHook - 设备 Token 管理 API
 * DELETE /api/token/{jti} - 撤销设备（需 token + 密码）
 * GET    /api/token/{jti} - 揭示 Token 明文（需 token + 密码）
 * PATCH  /api/token/{jti} - 重命名设备（仅 token）或修改有效期（需 token + 密码）
 */

import { verifyPasswordHash, buildTokenPayload, signTokenPayload, revokeToken, removeDevice, getDevices, resolveKv, renameDevice, requireAuth } from '../../_shared.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

// ============================================================================
// DELETE /api/token/{jti} - 撤销设备
// ============================================================================

export async function onRequestDelete(context) {
  const { request, env, params } = context;

  try {
    // 密码哈希验证（写操作必须验证密码）
    const passwordResult = await verifyPasswordHash(request, env);
    if (!passwordResult.valid) {
      return jsonResponse({
        error: 'Invalid password',
        reason: passwordResult.reason
      }, 401);
    }

    // 统一鉴权：签名验证 + 吊销名单检查（管理端点 fail-closed）
    const auth = await requireAuth(request, env);
    if (!auth.ok) {
      return jsonResponse({ error: auth.error }, auth.status);
    }
    const userId = auth.payload.uid;

    // 取出要撤销的目标 jti（动态路由参数）
    const targetJti = params?.jti;
    if (!targetJti) {
      return jsonResponse({ error: 'Missing jti', message: '缺少要撤销的设备标识' }, 400);
    }

    // 计算撤销标记的 TTL：有时效 token 用剩余有效期；永久 token（exp=0）传 0，
    // revokeToken 会写不设 TTL 的永久标记（标记到期消失 = 被撤销的永久 token 复活）
    const kv = resolveKv(env);
    let ttlSeconds = 365 * 24 * 60 * 60; // exp 未知时的兜底（旧记录最长 30 天，1 年足够覆盖）
    try {
      const devices = await getDevices(kv, userId);
      const target = devices.find(d => d.jti === targetJti);
      if (target) {
        if (target.exp > 0) {
          // 有时效的 token：用剩余有效期
          const nowSec = Math.floor(Date.now() / 1000);
          const remaining = target.exp - nowSec;
          if (remaining > 0) ttlSeconds = remaining;
        } else if (target.exp === 0) {
          // 永久 token：撤销标记永久保留
          ttlSeconds = 0;
        }
        // exp 未定义时保持默认兜底值
      }
    } catch {
      // 读取失败用缺省 TTL，不阻断撤销
    }

    // 写撤销名单 + 从注册表移除
    await revokeToken(kv, targetJti, ttlSeconds);
    await removeDevice(kv, userId, targetJti);

    return jsonResponse({
      success: true,
      message: '设备已撤销'
    });

  } catch (error) {
    console.error('[CloudHook] Revoke device error:', error);
    return jsonResponse({
      error: 'Internal server error',
      message: error.message
    }, 500);
  }
}

// ============================================================================
// GET /api/token/{jti} - 揭示设备 token 明文
// ============================================================================
//
// 同样要求密码哈希验证（与撤销同等敏感）。从设备注册表读取该设备的 iat/exp，
// 用同一 payload 字段顺序重新签名，得到与签发时**完全一致**的 token 明文。
// 老设备若缺 iat/exp，则从 created_at 推导（可能与原 token 差几秒，但仍是合法 token）。

export async function onRequestGet(context) {
  const { request, env, params } = context;

  try {
    // 密码哈希验证（揭示明文属敏感读，必须验证密码）
    const passwordResult = await verifyPasswordHash(request, env);
    if (!passwordResult.valid) {
      return jsonResponse({
        error: 'Invalid password',
        reason: passwordResult.reason
      }, 401);
    }

    // 统一鉴权：签名验证 + 吊销名单检查（管理端点 fail-closed）
    const auth = await requireAuth(request, env);
    if (!auth.ok) {
      return jsonResponse({ error: auth.error }, auth.status);
    }
    const userId = auth.payload.uid;

    const targetJti = params?.jti;
    if (!targetJti) {
      return jsonResponse({ error: 'Missing jti', message: '缺少要查看的设备标识' }, 400);
    }

    // 从注册表查目标设备
    const devices = await getDevices(resolveKv(env), userId);
    const target = devices.find(d => d.jti === targetJti);
    if (!target) {
      return jsonResponse({ error: 'Not found', message: '设备不存在或已撤销' }, 404);
    }

    // 还原签发参数：优先用入库的 iat/exp；老设备缺失时从 created_at 推导
    let iat = target.iat;
    let exp = target.exp;
    if (!iat) {
      iat = target.created_at
        ? Math.floor(new Date(target.created_at).getTime() / 1000)
        : Math.floor(Date.now() / 1000);
    }
    if (exp === undefined || exp === null) {
      // 老设备未存 exp，按旧逻辑 30 天推导
      exp = iat + 30 * 24 * 60 * 60;
    }
    // exp === 0 表示永久 token，保持 0

    // 确定性重算 token（字段顺序须与 buildTokenPayload 一致）
    const payload = buildTokenPayload(userId, {
      iat,
      exp,
      deviceName: target.device_name || 'Unknown Device',
      jti: targetJti
    });
    const revealedToken = await signTokenPayload(payload, env.HMAC_SECRET);

    return jsonResponse({
      success: true,
      jti: targetJti,
      device_name: target.device_name || 'Unknown Device',
      token: revealedToken,
      expires_at: exp > 0 ? new Date(exp * 1000).toISOString() : null
    });

  } catch (error) {
    console.error('[CloudHook] Reveal device token error:', error);
    return jsonResponse({
      error: 'Internal server error',
      message: error.message
    }, 500);
  }
}

// ============================================================================
// PATCH /api/token/{jti} - 重命名设备
// ============================================================================
//
// 仅修改设备显示名，属低敏感操作，校验 Token 即可（无需密码二次验证）。
// 设备名仅用于列表展示，不参与 token 签名，因此改名不影响已签发 token 的有效性。

export async function onRequestPatch(context) {
  const { request, env, params } = context;

  try {
    // 统一鉴权：签名验证 + 吊销名单检查（管理端点 fail-closed）
    const auth = await requireAuth(request, env);
    if (!auth.ok) {
      return jsonResponse({ error: auth.error }, auth.status);
    }
    const userId = auth.payload.uid;

    const targetJti = params?.jti;
    if (!targetJti) {
      return jsonResponse({ error: 'Missing jti', message: '缺少设备标识' }, 400);
    }

    const body = await request.json();
    const newName = typeof body?.device_name === 'string' ? body.device_name.trim() : '';
    const hasTtl = body?.ttl !== undefined && body?.ttl !== null;
    const ttl = hasTtl ? Number(body.ttl) : 0;

    if (!newName && !hasTtl) {
      return jsonResponse({ error: 'Bad request', message: '请提供 device_name 或 ttl' }, 400);
    }

    // TTL 修改是敏感操作，需要密码验证
    if (hasTtl) {
      const passwordResult = await verifyPasswordHash(request, env);
      if (!passwordResult.valid) {
        return jsonResponse({ error: 'Invalid password', reason: passwordResult.reason }, 401);
      }

      if (ttl < 0) {
        return jsonResponse({ error: 'Invalid TTL', message: '有效期不能为负数' }, 400);
      }

      const kv = resolveKv(env);
      const devices = await getDevices(kv, userId);
      const idx = devices.findIndex(d => d.jti === targetJti);
      if (idx === -1) {
        return jsonResponse({ error: 'Not found', message: '设备不存在或已撤销' }, 404);
      }

      const device = devices[idx];
      // 新有效期：永久=0，否则从当前时间计算
      const newExp = ttl === 0 ? 0 : Math.floor(Date.now() / 1000) + ttl;

      // 固化 iat：规则与 onRequestGet（reveal）完全一致——优先入库 iat，缺失时
      // 从 created_at 推导，再缺失用当前时间。iat 必须落库，否则 reveal/重登按
      // 注册表重算时复现不出本次返回的 token（同一设备发散出多个合法 token）
      let iat = device.iat;
      if (!iat) {
        iat = device.created_at
          ? Math.floor(new Date(device.created_at).getTime() / 1000)
          : Math.floor(Date.now() / 1000);
      }

      // 改名判定提前：如果同时传了 device_name，先落库再签名——签名必须用
      // 落库后的最终设备名，否则 reveal 会用新名重算出另一个 token
      if (newName && newName.length <= 50) {
        devices[idx].device_name = newName;
      }
      const finalName = devices[idx].device_name || 'Unknown Device';

      // exp/iat/改名合并为一次写入
      devices[idx].exp = newExp;
      devices[idx].iat = iat;
      await kv.put('user_' + userId + '_devices', JSON.stringify(devices));

      // 用落库后的 iat/exp/设备名重新签发 token（与 reveal 的重算规则一致）
      const payload = buildTokenPayload(userId, {
        iat,
        exp: newExp,
        deviceName: finalName,
        jti: targetJti
      });
      const newToken = await signTokenPayload(payload, env.HMAC_SECRET);

      return jsonResponse({
        success: true,
        jti: targetJti,
        device_name: finalName,
        token: newToken,
        exp: newExp,
        expires_at: newExp > 0 ? new Date(newExp * 1000).toISOString() : null,
        message: '有效期已更新，请使用新 Token 替换 settings.json 中的旧 Token'
      });
    }

    // 仅重命名（低敏感，无需密码）
    if (newName.length > 50) {
      return jsonResponse({ error: 'Invalid name', message: '设备名称不能超过 50 个字符' }, 400);
    }

    const ok = await renameDevice(resolveKv(env), userId, targetJti, newName);
    if (!ok) {
      return jsonResponse({ error: 'Not found', message: '设备不存在或已撤销' }, 404);
    }

    return jsonResponse({
      success: true,
      jti: targetJti,
      device_name: newName,
      message: '设备已重命名'
    });

  } catch (error) {
    console.error('[CloudHook] Patch device error:', error);
    return jsonResponse({
      error: 'Internal server error',
      message: error.message
    }, 500);
  }
}

// ============================================================================
// OPTIONS - CORS 预检
// ============================================================================

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-CloudHook-Token, X-Password-Hash',
      'Access-Control-Max-Age': '86400'
    }
  });
}
