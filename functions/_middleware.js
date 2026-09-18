/**
 * CloudHook - 全局中间件
 * CORS、安全头、错误处理
 *
 * ⚠️ 修复：EdgeOne 运行时 Response.body 可能为 ReadableStream 不可变对象，
 *    直接 `new Response(response.body, ...)` 在部分运行时会导致流消费异常。
 *    改为优先尝试原地修改 headers，仅在 headers 不可变时回退重建。
 */

const SECURITY_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'X-Powered-By': 'CloudHook/1.0'
};

function applySecurityHeaders(response) {
  // 优先尝试原地修改（EdgeOne 运行时 Headers 通常可变）
  try {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(key, value);
    }
    return response;
  } catch {
    // Headers 不可变 → 回退：读取 body 并重建 Response
  }

  // 回退方案：用 arrayBuffer 读取完整 body 后重建
  try {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch {
    // 最终兜底：返回原始响应
    return response;
  }
}

export async function onRequest(context) {
  const { request, next } = context;

  // 处理 CORS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-CloudHook-Token, X-Password-Hash, X-Hook-Event, X-Agent-Type',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  try {
    const response = await next();
    return applySecurityHeaders(response);
  } catch (error) {
    console.error('[CloudHook] Middleware error:', error);

    return new Response(JSON.stringify({
      error: 'Internal server error',
      message: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
