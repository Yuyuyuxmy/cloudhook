/**
 * CloudHook - Bark 推送测试 API
 * POST /api/config/test - 用当前配置发一条测试通知到 Bark
 *
 * 注意：Cloudflare Pages Functions 路由按文件路径匹配，子路径 /api/config/test
 * 必须有独立文件 config/test.js，不能塞进 config.js（后者只匹配 /api/config）。
 */

import { decrypt, requireAuth, testBarkPush, getUserConfig } from '../../_shared.js';

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

/**
 * 脱敏 Bark Key（只显示前 4 位和后 4 位）
 */
function maskBarkKey(key) {
  if (!key || key.length < 8) return '***';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

// ============================================================================
// POST /api/config/test - 测试 Bark 推送
// ============================================================================
//
// 除鉴权失败外一律返回 HTTP 200，用 body 的 success 表达结果。
// 历史原因：EdgeOne 对 5xx 响应会覆盖 JSON；Cloudflare 无此问题，但保持约定不变以兼容前端。
// 导致前端拿不到 message/diagnostics，只能显示"未知错误"。返回 200 可规避。

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 统一鉴权：签名验证 + 吊销名单检查（管理端点 fail-closed）
    const auth = await requireAuth(request, env);
    if (!auth.ok) {
      return jsonResponse({ error: auth.error }, auth.status);
    }
    const userId = auth.payload.uid;

    // 读取配置（传递 env 支持环境变量回退）
    const config = await getUserConfig(auth.kv, userId, env);

    // 解密 Bark Key（如果存储的是加密版本）
    let barkKey = config.bark_key;
    if (config.bark_key_encrypted && env.ENCRYPTION_KEY) {
      try {
        barkKey = await decrypt(config.bark_key_encrypted, env.ENCRYPTION_KEY);
      } catch (error) {
        console.error('[CloudHook] Bark key decryption failed:', error);
        return jsonResponse({
          success: false,
          error: 'Decryption failed',
          message: `Bark Key 解密失败：${error.message}`
        });
      }
    }

    if (!barkKey || barkKey === 'YOUR_BARK_KEY') {
      return jsonResponse({
        success: false,
        error: 'Bark key not configured',
        message: '尚未配置 Bark Key，请先在配置页填写并保存'
      });
    }

    // 诊断信息：实际使用的 server 和 key 的脱敏形态（含长度），
    // 用于排查"Bark 返回 200 但收不到"——通常是 key 被存成了脱敏值或长度异常。
    const usedServer = config.bark_server || 'https://api.day.app';
    const diagnostics = {
      server: usedServer,
      key_preview: maskBarkKey(barkKey),
      key_length: barkKey.length,
      // 关键自检：解密出的 key 若含 '*' 说明历史上误存了脱敏值
      key_looks_masked: barkKey.includes('*')
    };

    // 测试推送
    const result = await testBarkPush(barkKey, usedServer);

    // 无论成功失败都返回 200，结果由 body.success 表达，诊断信息一并带上
    return jsonResponse({
      success: result.success === true,
      message: result.success
        ? 'Test notification sent successfully'
        : result.message,
      diagnostics
    });

  } catch (error) {
    console.error('[CloudHook] Test push error:', error);
    return jsonResponse({
      success: false,
      error: 'Internal server error',
      message: `服务端异常：${error.message}`
    });
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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-CloudHook-Token, X-Password-Hash',
      'Access-Control-Max-Age': '86400'
    }
  });
}
