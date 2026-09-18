/**
 * CloudHook - 访问日志查询 API
 * GET /api/access-logs - 查询风控访问日志（分页）
 */

import { requireAuth, getAccessLogs, deleteAccessLogs, clearAccessLogs } from '../_shared.js';

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
// GET /api/access-logs - 获取访问日志
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

    // 解析分页参数
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const deviceFilter = url.searchParams.get('device') || null;
    const agentFilter = url.searchParams.get('agent') || null;

    if (isNaN(limit) || limit < 1 || limit > 200) {
      return jsonResponse({
        error: 'Invalid limit',
        message: 'Limit must be between 1 and 200'
      }, 400);
    }

    if (isNaN(offset) || offset < 0) {
      return jsonResponse({
        error: 'Invalid offset',
        message: 'Offset must be non-negative'
      }, 400);
    }

    const filter = {};
    if (deviceFilter) filter.device = deviceFilter;
    if (agentFilter) filter.agent = agentFilter;
    const result = await getAccessLogs(auth.kv, userId, limit, offset, filter);

    return jsonResponse({
      success: true,
      logs: result.logs,
      total: result.total,
      has_more: result.has_more
    });

  } catch (error) {
    console.error('[CloudHook] Get access logs error:', error);
    return jsonResponse({
      error: 'Internal server error',
      message: error.message
    }, 500);
  }
}

// ============================================================================
// DELETE /api/access-logs - 删除访问日志
// ============================================================================

export async function onRequestDelete(context) {
  const { request, env } = context;

  try {
    // 统一鉴权：签名验证 + 吊销名单检查（管理端点 fail-closed）
    const auth = await requireAuth(request, env);
    if (!auth.ok) {
      return jsonResponse({ error: auth.error }, auth.status);
    }
    const userId = auth.payload.uid;

    const body = await request.json();
    const kv = auth.kv;

    if (body.clear_all === true) {
      const result = await clearAccessLogs(kv, userId);
      return jsonResponse({ success: result.success, ...result });
    }

    if (Array.isArray(body.ids)) {
      if (body.ids.length === 0 || body.ids.length > 200) {
        return jsonResponse({
          success: false,
          error: 'Invalid ids',
          message: 'Must provide 1-200 ids'
        });
      }
      const result = await deleteAccessLogs(kv, userId, body.ids);
      return jsonResponse({ success: result.success, ...result });
    }

    return jsonResponse({
      success: false,
      error: 'Invalid request',
      message: 'Provide { ids: string[] } or { clear_all: true }'
    });

  } catch (error) {
    console.error('[CloudHook] Delete access logs error:', error);
    return jsonResponse({
      success: false,
      error: 'Internal server error',
      message: error.message
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
      'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-CloudHook-Token',
      'Access-Control-Max-Age': '86400'
    }
  });
}
