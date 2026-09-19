/**
 * CloudHook - Bark 推送封装
 * 发送通知到 Bark API
 *
 * 采用官方推荐的 POST JSON 方式（POST /{key}，参数放 body）：
 * 相比路径式 GET /{key}/{title}/{body}，JSON body 对中文、换行、特殊字符
 * 无需 URL 编码，避免内容被服务端误处理（返回 200 却实际未送达）。
 * 参考：https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md
 *       https://github.com/Finb/bark-server/blob/master/docs/API_V2.md
 */

/**
 * 推送重试预算。
 *
 * waitUntil 的 30s 窗口从请求进入时开始计时（不是响应返回后重新计时），
 * 响应约 300ms 返回，故给推送留 25s，其余留给 logEvent 写 KV。
 * 单次 12s：Cloudflare 边缘到 Bark 服务器（腾讯云）的路径偶发拥塞，
 * 原先的 8s 会误杀「慢但本可成功」的请求。
 */
const PUSH_ATTEMPT_TIMEOUT_MS = 12000;
const PUSH_BUDGET_MS = 25000;
const PUSH_MAX_ATTEMPTS = 3;
const PUSH_BACKOFF_MS = [800, 2000];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带超时的 fetch（不依赖 AbortSignal.timeout，兼容性更好）
 */
async function fetchWithTimeout(url, init, timeoutMs = PUSH_ATTEMPT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单次投递尝试。
 * 返回的 retriable 区分两类失败：
 *   - 瞬时故障（超时 / 网络异常 / 5xx）→ 值得重试
 *   - 确定性失败（无效 key / 4xx / Bark 业务错误码 / 非 JSON）→ 重试只是浪费预算
 */
async function pushBarkOnce(endpoint, payload, timeoutMs) {
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'CloudHook/1.0'
      },
      body: JSON.stringify(payload)
    }, timeoutMs);

    // 无论 2xx 与否，都读出文本用于诊断（Bark 错误信息在 body 里）
    const rawText = await response.text();

    if (!response.ok) {
      console.error(`[CloudHook] Bark API error (${response.status}):`, rawText);
      return {
        success: false,
        retriable: response.status >= 500,
        message: `Bark 返回 HTTP ${response.status}：${rawText || '(空响应)'}`
      };
    }

    // 解析 JSON 响应；Bark 成功时返回 { code: 200, message: "success", ... }
    let result;
    try {
      result = JSON.parse(rawText);
    } catch {
      return {
        success: false,
        retriable: false,
        message: `Bark 返回非预期响应：${rawText || '(空响应)'}`
      };
    }

    if (result.code === 200) {
      return { success: true, message: result.message || 'Notification sent successfully' };
    }

    console.error('[CloudHook] Bark API returned error:', result);
    return {
      success: false,
      retriable: false,
      message: `Bark 错误（code ${result.code}）：${result.message || '未知错误'}`
    };

  } catch (error) {
    console.error('[CloudHook] Bark push failed:', error);
    if (error.name === 'AbortError') {
      return { success: false, retriable: true, message: 'Bark 请求超时' };
    }
    return { success: false, retriable: true, message: error.message || 'Network error' };
  }
}

/**
 * 推送通知到 Bark（带退避重试）
 * @param {string} barkKey - Bark Key
 * @param {string} barkServer - Bark 服务器地址
 * @param {string} title - 通知标题
 * @param {string} body - 通知内容
 * @param {object} options - 额外选项（另支持 maxAttempts / budgetMs 覆盖重试预算）
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function pushBark(
  barkKey,
  barkServer = 'https://api.day.app',
  title,
  body,
  options = {}
) {
  // 验证参数
  if (!barkKey || barkKey === 'YOUR_BARK_KEY') {
    console.warn('[CloudHook] Bark key not configured, skipping push');
    return { success: false, message: 'Bark key not configured' };
  }

  if (!title || !body) {
    console.warn('[CloudHook] Title or body missing, skipping push');
    return { success: false, message: 'Title or body missing' };
  }

  const server = barkServer.replace(/\/$/, ''); // 移除末尾斜杠
  const endpoint = `${server}/${encodeURIComponent(barkKey)}`;

  // 组装 JSON body（参数名遵循 Bark API：title/body/group/level/sound/icon/url）
  const payload = {
    title,
    body,
    group: options.group || 'CloudHook',
    level: options.level || 'timeSensitive'
  };
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
      return i === 1 ? last : { success: true, message: `${last.message}（第 ${i} 次尝试成功）` };
    }
    if (!last.retriable) {
      return { success: false, message: last.message };
    }

    const backoff = PUSH_BACKOFF_MS[i - 1] || 2000;
    if (i >= maxAttempts || budget - (Date.now() - startedAt) <= backoff + 1000) break;
    await sleep(backoff);
  }

  return {
    success: false,
    message: attempts > 1 ? `${last.message}（共尝试 ${attempts} 次）` : last.message
  };
}

/**
 * 测试 Bark 推送
 * 走同步响应路径，预算收紧避免前端长时间空转。
 * @param {string} barkKey - Bark Key
 * @param {string} barkServer - Bark 服务器地址
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testBarkPush(barkKey, barkServer = 'https://api.day.app') {
  return pushBark(
    barkKey,
    barkServer,
    'CloudHook 测试',
    'CloudHook Bark 推送测试\n如果你收到这条消息，说明配置正确！',
    { group: 'CloudHook', level: 'active', maxAttempts: 2, budgetMs: 12000 }
  );
}
