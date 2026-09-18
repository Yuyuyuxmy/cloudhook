/**
 * CloudHook - 核心 Webhook 处理（/api/notify 路由，hook.js 的别名副本，改动须同步）
 *
 * 接收 Claude Code hook 事件，分类、构建消息、推送 Bark 通知。
 * 依赖通过 _shared.js 同目录 import 引入。
 *
 * ⚠️ 所有响应路径返回 HTTP 200，用 body.success 表达结果。
 *    历史原因：EdgeOne 对 5xx 会覆盖 JSON；Cloudflare 无此问题，但保持约定不变以兼容前端。
 *
 * 注：'PermissionRequest' 用 fromCharCode 构建是 EdgeOne WAF 时代的遗留写法，无害保留。
 */

import {
  verifyAuthToken,
  decrypt,
  resolveKv,
  getUserConfig,
  isTokenRevoked,
  checkRateLimit,
  logEvent,
  writeAccessLog,
  getClientIp,
  checkGeoRestriction,
  checkIpAccess,
  classify,
  buildMessage,
  getRiskLevel,
  pushBark,
  safeWaitUntil,
  detectAgent
} from '../_shared.js';

// ============================================================================
// 工具函数
// ============================================================================

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

/**
 * Antigravity payload 无事件名字段（无 hook_event_name/hookEventName），
 * 按 payload 形状推断事件类型，仅作为事件名解析链的兜底层。
 */
export function inferAgEventName(rawEvent) {
  if (!rawEvent) return '';
  if (rawEvent.toolCall && typeof rawEvent.stepIdx === 'number') return 'PreToolUse';
  if (!rawEvent.toolCall && typeof rawEvent.stepIdx === 'number') return 'PostToolUse';
  if (rawEvent.terminationReason !== undefined && rawEvent.fullyIdle !== undefined) return 'Stop';
  if (typeof rawEvent.invocationNum === 'number') return 'PreInvocation';
  return '';
}

/**
 * 解析 hook 事件（Claude Code / Codex / Antigravity 通用）
 */
export function parseEvent(rawEvent, eventName) {
  var parsed = {
    timestamp: new Date().toISOString(),
    event_name: eventName,
    raw_text: '',
    tool_name: '',
    tool_input: {},
    has_error: false,
    summary: '',
    raw_event: rawEvent || {}
  };
  if (!rawEvent) return parsed;

  var strings = [];
  var totalLen = 0;
  var nodeCount = 0;

  function extractStrings(obj) {
    if (nodeCount >= 2000 || totalLen >= 8192) return;
    nodeCount++;
    if (typeof obj === 'string') {
      var remaining = 8192 - totalLen;
      if (remaining <= 0) return;
      var s = obj.length > remaining ? obj.slice(0, remaining) : obj;
      strings.push(s);
      totalLen += s.length;
    } else if (obj !== null && typeof obj === 'object') {
      if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) {
          if (nodeCount >= 2000 || totalLen >= 8192) break;
          extractStrings(obj[i]);
        }
      } else {
        var keys = Object.keys(obj);
        for (var j = 0; j < keys.length; j++) {
          if (nodeCount >= 2000 || totalLen >= 8192) break;
          extractStrings(obj[keys[j]]);
        }
      }
    }
  }

  extractStrings(rawEvent);
  parsed.raw_text = strings.join(' ');
  parsed.text_lower = parsed.raw_text.toLowerCase();

  parsed.tool_name = rawEvent.tool_name || rawEvent.tool || '';
  if (!parsed.tool_name && rawEvent.tool_use && rawEvent.tool_use.name) {
    parsed.tool_name = rawEvent.tool_use.name;
  }

  var toolInput = rawEvent.tool_input || rawEvent.input || {};
  if (typeof toolInput === 'string') {
    try { toolInput = JSON.parse(toolInput); } catch (e) { toolInput = { raw: toolInput }; }
  }
  parsed.tool_input = (typeof toolInput === 'object') ? toolInput : {};

  // Antigravity：无 tool_name/tool_input 字段，从 toolCall 映射（camelCase args → snake_case，
  // 仅映射已知字段，其余 args 原样并入，供后续风险评级等消费）
  if (!parsed.tool_name && rawEvent.toolCall && rawEvent.toolCall.name) {
    parsed.tool_name = rawEvent.toolCall.name;
    var agArgs = rawEvent.toolCall.args || {};
    var agInput = {};
    for (var agKey in agArgs) {
      if (Object.prototype.hasOwnProperty.call(agArgs, agKey)) agInput[agKey] = agArgs[agKey];
    }
    if (agArgs.CommandLine !== undefined) agInput.command = agArgs.CommandLine;
    if (agArgs.TargetFile !== undefined) agInput.file_path = agArgs.TargetFile;
    if (agArgs.Url !== undefined) agInput.url = agArgs.Url;
    parsed.tool_input = agInput;
  }

  var command = parsed.tool_input.command || '';
  var filePath = parsed.tool_input.file_path || '';
  var url = parsed.tool_input.url || '';
  if (command) parsed.summary = parsed.tool_name + ': ' + command.slice(0, 120);
  else if (filePath) parsed.summary = parsed.tool_name + ': ' + filePath;
  else if (url) parsed.summary = parsed.tool_name + ': ' + url;
  else parsed.summary = parsed.tool_name || 'Unknown';

  var errorKeywords = ['error', 'failed', 'exception', 'traceback', 'exit code'];
  parsed.has_error = errorKeywords.some(function(kw) { return parsed.text_lower.includes(kw); });

  return parsed;
}

// ============================================================================
// 主处理函数
// ============================================================================

export async function onRequestPost(context) {
  var request = context.request;
  var env = context.env;
  var startTime = Date.now();

  try {
    var kv = resolveKv(env);
    var clientIp = getClientIp(request);
    var userAgent = request.headers.get('User-Agent') || '';
    var headerEvent = request.headers.get('X-Hook-Event') || '';
    // 来源预判：此时 body 尚未解析，仅凭请求头/UA 判定，命中层级至多到 'ua'
    var preAgent = detectAgent(request, null);

    // 被拒绝的请求也写访问日志（异步、不阻塞响应）。此前只有成功请求留痕，
    // token 过期/被吊销时 hook 静默失败（HTTP 仍是 200），完全无从诊断。
    // 单用户系统，uid 恒为 default，签名未通过时也归入该用户的日志。
    var denyLog = function(reason, extra) {
      extra = extra || {};
      safeWaitUntil(context, writeAccessLog(kv, extra.uid || 'default', {
        ip: clientIp,
        user_agent: userAgent,
        result: extra.result || 'denied',
        reason: reason,
        event_name: headerEvent || undefined,
        jti: extra.jti || undefined,
        agent: preAgent.id,
        agent_source: preAgent.source
      }));
    };

    // 1. 安全验证
    var token = request.headers.get('X-CloudHook-Token');
    if (!token) {
      denyLog('missing_token');
      return jsonResponse({ success: false, error: 'Missing token' });
    }

    // 先只验签名（ignoreExp），过期单独判——日志与响应区分「签名无效」和「已过期」
    var payload = await verifyAuthToken(token, env.HMAC_SECRET, { full: true, ignoreExp: true });
    if (!payload) {
      denyLog('invalid_token');
      return jsonResponse({ success: false, error: 'Invalid token' });
    }
    if (payload.exp > 0 && payload.exp < Math.floor(Date.now() / 1000)) {
      denyLog('token_expired', { uid: payload.uid, jti: payload.jti });
      return jsonResponse({ success: false, error: 'Token expired' });
    }
    var userId = payload.uid;

    // kvError 时放行：通知可用性优先，吊销名单不可读不应阻断告警推送（内部已记日志）
    var revokeCheck = await isTokenRevoked(kv, payload.jti);
    if (revokeCheck.revoked) {
      denyLog('token_revoked', { uid: userId, jti: payload.jti });
      return jsonResponse({ success: false, error: 'Token revoked' });
    }

    // 2. 读取用户配置
    var config = await getUserConfig(kv, userId, env);
    var riskControl = config.risk_control || {};

    // 3. 风控：IP 检查
    var ipResult = checkIpAccess(riskControl.ip, clientIp);
    if (!ipResult.allowed) {
      denyLog(ipResult.reason || 'ip_denied', { uid: userId, jti: payload.jti });
      return jsonResponse({ success: false, error: 'Access denied', reason: ipResult.reason });
    }

    // 4. 风控：地理检查
    var geoResult = checkGeoRestriction(riskControl.geo, request);
    if (!geoResult.allowed) {
      denyLog(geoResult.reason || 'geo_denied', { uid: userId, jti: payload.jti });
      return jsonResponse({ success: false, error: 'Access denied', reason: geoResult.reason });
    }

    // 5. 速率限制
    var rateLimitConfig = riskControl.rate_limit || {};
    var rateLimitEnabled = rateLimitConfig.enabled !== false;
    var maxPerMinute = rateLimitConfig.max_per_minute || 100;

    if (rateLimitEnabled) {
      var isRateLimited = await checkRateLimit(kv, userId, 'hook', maxPerMinute);
      if (isRateLimited) {
        denyLog('rate_limit_exceeded', { uid: userId, jti: payload.jti, result: 'rate_limited' });
        return jsonResponse({ success: false, error: 'Rate limit exceeded' });
      }
    }

    // 6. 解析事件
    var rawEvent = await request.json();
    var agentInfo = detectAgent(request, rawEvent);
    var eventName = (rawEvent && rawEvent.hook_event_name)
      || (rawEvent && rawEvent.hookEventName)
      || request.headers.get('X-Hook-Event')
      || inferAgEventName(rawEvent)
      || 'Unknown';
    var parsed = parseEvent(rawEvent, eventName);

    // 7. 事件分类（_shared.js classify 已用 fromCharCode 绕过 WAF）
    var eventType = classify(parsed, agentInfo.id);
    // 旧配置无 agents 段时必须默认启用，不得因缺字段静音
    var agentEnabled = ((config.agents || {})[agentInfo.id] || {}).enabled !== false;
    // turn_paused：本轮结束但仍有后台任务（subagent 等）——只记日志，不推送
    var shouldNotify = eventType !== 'turn_paused' && agentEnabled;

    // 8. 构建消息
    var message = buildMessage(eventType, parsed, null, null, null, parsed.summary, config, payload.dev, agentInfo.name);

    // 9. 异步推送 & 记录（不阻塞响应）。三步各自隔离：任一步失败不吞掉其余步骤
    //    ——此前 pushBark 抛异常会连事件日志一起丢，事件像从未发生过一样无法排查。
    safeWaitUntil(context, (async function() {
      try {
        await writeAccessLog(kv, userId, {
          ip: clientIp,
          country_code: geoResult.location.countryCode || undefined,
          country_name: geoResult.location.countryName || undefined,
          user_agent: userAgent,
          result: 'allowed',
          event_name: eventName,
          jti: payload.jti,
          agent: agentInfo.id,
          agent_source: agentInfo.source
        });
      } catch (logErr) { /* 忽略，不影响推送 */ }

      // 推送结果如实记录：notified = 真实送达 Bark，而非「打算推送」。
      // 失败原因写入 push_error（Bark HTTP 错误 / 超时 / key 未配置等），事件页可见。
      var pushed = false;
      var pushError = '';
      if (!agentEnabled && eventType !== 'turn_paused') {
        // 该来源被静音：不进推送分支，仅记录静音原因
        pushError = 'agent_muted';
      } else if (shouldNotify) {
        try {
          var barkKey = config.bark_key;
          if (config.bark_key_encrypted && env.ENCRYPTION_KEY) {
            try {
              barkKey = await decrypt(config.bark_key_encrypted, env.ENCRYPTION_KEY);
            } catch (e) {
              barkKey = null;
              pushError = 'bark_key_decrypt_failed';
            }
          }
          if (barkKey) {
            var pushResult = await pushBark(
              barkKey,
              config.bark_server || 'https://api.day.app',
              message.title, message.body,
              {
                group: 'CloudHook',
                level: (config.notifier && config.notifier.level) || 'timeSensitive'
              }
            );
            pushed = !!(pushResult && pushResult.success);
            if (!pushed && !pushError) {
              pushError = (pushResult && pushResult.message) || 'push_failed';
            }
          } else if (!pushError) {
            pushError = 'bark_key_missing';
          }
        } catch (pushErr) {
          pushError = (pushErr && pushErr.message) || 'push_exception';
        }
      }

      try {
        await logEvent(kv, userId, {
          timestamp: parsed.timestamp,
          event_type: eventType,
          event_name: eventName,
          title: message.title,
          body: message.body,
          risk_level: getRiskLevel(eventType, parsed),
          notified: pushed,
          push_error: (!pushed && pushError) ? pushError : undefined,
          token_id: token.slice(0, 8),
          jti: payload.jti,
          agent: agentInfo.id
        });
      } catch (logErr) { /* 忽略 */ }
    })());

    // 10. 快速返回
    var latency = Date.now() - startTime;
    return jsonResponse({
      success: true,
      event_type: eventType,
      notified: shouldNotify,
      latency_ms: latency
    });

  } catch (error) {
    return jsonResponse({
      success: false,
      error: 'hook_error',
      message: error.message,
      stack: error.stack ? error.stack.slice(0, 300) : undefined
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
      'Access-Control-Allow-Headers': 'Content-Type, X-CloudHook-Token, X-Timestamp, X-Signature, X-Hook-Event, X-Agent-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
