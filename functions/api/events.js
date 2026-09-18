/**
 * CloudHook - 事件历史查询 API
 * 查询用户的事件日志
 */

import { requireAuth, getEvents, deleteEvents, clearEvents } from '../_shared.js';

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

// ============================================================================
// GET /api/events - 获取事件历史
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

    // 解析查询参数
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const typeFilter = url.searchParams.get('type') || null;
    const deviceFilter = url.searchParams.get('device') || null;
    const agentFilter = url.searchParams.get('agent') || null;

    // 验证参数
    if (limit < 1 || limit > 100) {
      return jsonResponse({
        error: 'Invalid limit',
        message: 'Limit must be between 1 and 100'
      }, 400);
    }

    if (offset < 0) {
      return jsonResponse({
        error: 'Invalid offset',
        message: 'Offset must be non-negative'
      }, 400);
    }

    // 获取事件：type/device 过滤在 getEvents 内部基于全量完成，分页基于过滤后集合
    const filter = {};
    if (typeFilter) filter.type = typeFilter;
    if (deviceFilter) filter.device = deviceFilter;
    if (agentFilter) filter.agent = agentFilter;
    const result = await getEvents(auth.kv, userId, limit, offset, filter);

    return jsonResponse({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('[CloudHook] Get events error:', error);
    return jsonResponse({
      error: 'Internal server error',
      message: error.message
    }, 500);
  }
}

// ============================================================================
// DELETE /api/events - 删除事件日志
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
      const result = await clearEvents(kv, userId);
      return jsonResponse({ success: result.success, ...result });
    }

    if (Array.isArray(body.indices)) {
      if (body.indices.length === 0 || body.indices.length > 100) {
        return jsonResponse({
          success: false,
          error: 'Invalid indices',
          message: 'Must provide 1-100 indices'
        });
      }
      const result = await deleteEvents(kv, userId, body.indices);
      return jsonResponse({ success: result.success, ...result });
    }

    return jsonResponse({
      success: false,
      error: 'Invalid request',
      message: 'Provide { indices: number[] } or { clear_all: true }'
    });

  } catch (error) {
    console.error('[CloudHook] Delete events error:', error);
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
