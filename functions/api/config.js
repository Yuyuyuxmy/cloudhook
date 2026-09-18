/**
 * CloudHook - 配置管理 API
 * 读取、更新用户配置，测试 Bark 推送
 */

import { encrypt, decrypt, verifyPasswordHash, requireAuth, getUserConfig, saveUserConfig } from '../_shared.js';

// ============================================================================
// 工具函数
// ============================================================================

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
// GET /api/config - 获取配置
// ============================================================================

export async function onRequestGet(context) {
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
        barkKey = 'DECRYPTION_FAILED';
      }
    }

    // 脱敏敏感信息
    const safeConfig = {
      ...config,
      bark_key: maskBarkKey(barkKey),
      bark_server: config.bark_server
    };
    delete safeConfig.bark_key_encrypted; // 不返回加密数据

    return jsonResponse({
      success: true,
      config: safeConfig
    });

  } catch (error) {
    console.error('[CloudHook] Get config error:', error);
    return jsonResponse({
      error: 'Internal server error',
      message: error.message
    }, 500);
  }
}

// ============================================================================
// PUT /api/config - 更新配置
// ============================================================================

export async function onRequestPut(context) {
  const { request, env } = context;

  try {
    // 密码哈希验证（更新配置需要密码验证）
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

    // 解析请求体
    const updates = await request.json();

    // 读取当前配置（传递 env 支持环境变量回退）
    const kv = auth.kv;
    const currentConfig = await getUserConfig(kv, userId, env);

    // 合并配置
    const newConfig = {
      ...currentConfig,
      ...updates
    };

    // 如果更新了 Bark Key，进行加密存储
    if (updates.bark_key && updates.bark_key !== maskBarkKey(currentConfig.bark_key)) {
      if (!env.ENCRYPTION_KEY) {
        return jsonResponse({
          error: 'Encryption not configured',
          message: 'ENCRYPTION_KEY environment variable is required for secure storage'
        }, 500);
      }

      try {
        const encrypted = await encrypt(updates.bark_key, env.ENCRYPTION_KEY);
        newConfig.bark_key_encrypted = encrypted;
        delete newConfig.bark_key; // 删除明文，只存加密后的数据
      } catch (error) {
        console.error('[CloudHook] Bark key encryption failed:', error);
        return jsonResponse({
          error: 'Encryption failed',
          message: 'Failed to encrypt Bark key'
        }, 500);
      }
    }

    // 保存配置（传递 env，返回保存结果）
    const saveResult = await saveUserConfig(kv, userId, newConfig, env);

    // 返回时需要显示脱敏的 bark_key（可能来自原配置或新更新）
    const returnBarkKey = updates.bark_key
      ? maskBarkKey(updates.bark_key)
      : maskBarkKey(currentConfig.bark_key);

    return jsonResponse({
      success: saveResult.success,
      message: saveResult.message || 'Configuration updated successfully',
      source: saveResult.source, // 'kv' 或 'cache'
      config: {
        ...newConfig,
        bark_key: returnBarkKey,
        bark_key_encrypted: undefined // 不返回加密数据
      }
    });

  } catch (error) {
    console.error('[CloudHook] Update config error:', error);
    return jsonResponse({
      error: 'Internal server error',
      message: error.message
    }, 500);
  }
}

// ============================================================================
// OPTIONS - CORS 预检
// ============================================================================
//
// 注意：测试推送端点已迁出到 config/test.js（对应 /api/config/test）。
// Cloudflare Pages Functions 路由按文件路径匹配，config.js 仅响应 /api/config，
// 子路径 /api/config/test 必须由独立文件处理，否则会落到 SPA fallback 返回 HTML。

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-CloudHook-Token, X-Password-Hash',
      'Access-Control-Max-Age': '86400'
    }
  });
}
