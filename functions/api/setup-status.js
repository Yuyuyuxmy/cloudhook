/**
 * CloudHook - 服务端配置状态 API
 * 供前端判断是否已配置 MASTER_PASSWORD / HMAC_SECRET，无需任何认证，不读 KV
 */

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
// GET /api/setup-status - 查询服务端是否已配置必需环境变量
// ============================================================================

export async function onRequestGet(context) {
  const { env } = context;

  const hasPassword = Boolean(env.MASTER_PASSWORD || env.MASTER_PASSWORD_HASH);
  const hasSecret = Boolean(env.HMAC_SECRET);

  return jsonResponse({
    success: true,
    configured: hasPassword && hasSecret
  });
}

// ============================================================================
// OPTIONS - CORS 预检
// ============================================================================

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
