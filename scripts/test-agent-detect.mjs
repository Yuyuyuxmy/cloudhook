/**
 * 多智能体来源识别冒烟测试（直接驱动真实模块，无需启动服务器）
 *
 * 覆盖：
 * 1. Claude Code Notification（顶层 title/message，无显式头）：形状识别 + 分类 +
 *    attention_required 正文取顶层字段（MULTI_AGENT_SUPPORT.md §9.1 的既存 bug 修复）
 * 2. Claude Code Stop：background_tasks 非空 → turn_paused，空/缺失 → task_done
 * 3. Codex PermissionRequest：形状识别 + 分类 + Bash 命令风险评级
 * 4. Codex Stop / SubagentStop 分类
 * 5. Antigravity PreToolUse：形状识别 + 事件名推断 + tool_input 字段映射 + 分类
 * 6. Antigravity Stop：fullyIdle true/false 分类分支
 * 7. 显式头（X-Agent-Type）优先于 payload 形状
 * 8. User-Agent 层：含 claude-code 命中 ua 层；curl UA 落到形状层
 * 9. 兜底：空对象 payload 且无头无 UA → unknown/fallback，标题「其他智能体 提醒」
 * 10. 零回归：classify 不传 agentId、buildMessage 不传 agentName，行为与旧版本一致
 * 11. getDefaultConfig().agents 五来源默认开启；静音判断表达式三态验证
 * 12. lib/agent-detect.js 与 functions/_shared.js 的 detectAgent 双份一致性
 *     （含 Kimi payload）
 * 13. Kimi Code PermissionRequest：client_type 一锤定音识别（带 turn_id，防 codex
 *     判据误判回归）+ 分类
 * 14. Kimi Code SessionStart：带 model 仍识别为 kimi_code（防 codex 判据误判）
 * 15. Kimi Code Stop / SubagentStop / StopFailure / PostToolUseFailure 分类
 * 16. Kimi Code Notification（后台任务状态变化语义）：task.failed / task.completed 分类
 * 17. 显式头 X-Agent-Type: kimi / kimi-code → kimi_code/header
 * 18. buildMessage 传 'Kimi Code' 显示名 → 标题 'Kimi Code 已完成'
 *
 * 运行：node scripts/test-agent-detect.mjs
 */

import * as sharedEdge from '../functions/_shared.js';
import { parseEvent, inferAgEventName } from '../functions/api/hook.js';
import { detectAgent as detectAgentLib } from '../lib/agent-detect.js';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
}

/** 构造一个满足 detectAgent 所需最小接口的 mock Request */
function mockRequest(headers = {}, url = 'https://x/api/hook') {
  return {
    headers: { get: (k) => (Object.prototype.hasOwnProperty.call(headers, k) ? headers[k] : null) },
    url
  };
}

/** 复刻 hook.js 的事件名解析链（不含 X-Hook-Event 头分支时头值传空字符串） */
function resolveEventName(rawEvent, headerEvent = '') {
  return (rawEvent && rawEvent.hook_event_name)
    || (rawEvent && rawEvent.hookEventName)
    || headerEvent
    || inferAgEventName(rawEvent)
    || 'Unknown';
}

// ---------------------------------------------------------------------------
// 用例 1：Claude Code Notification（顶层 title/message，无显式头）
// ---------------------------------------------------------------------------
const ccNotification = {
  session_id: 'abc123',
  transcript_path: '/Users/x/.claude/projects/y/00893aaf.jsonl',
  cwd: '/Users/x/project',
  hook_event_name: 'Notification',
  message: 'Claude needs your permission',
  title: 'Permission needed',
  notification_type: 'permission_prompt'
};
const reqNoHeaders = mockRequest();

const agentCcNotif = sharedEdge.detectAgent(reqNoHeaders, ccNotification);
check('[1] CC Notification detect=claude_code/shape', agentCcNotif.id === 'claude_code' && agentCcNotif.source === 'shape', JSON.stringify(agentCcNotif));

const eventNameCcNotif = resolveEventName(ccNotification);
const parsedCcNotif = parseEvent(ccNotification, eventNameCcNotif);
const classifyCcNotif = sharedEdge.classify(parsedCcNotif, agentCcNotif.id);
check('[1] CC Notification classify=permission_required（message 含 permission）', classifyCcNotif === 'permission_required', classifyCcNotif);

// 单独验证 buildMessage 的 attention_required 分支正文字段修复（§9.1）：
// 不依赖 classify 的实际结果，直接用该 payload 验证正文取顶层 title/message
const attnMsg = sharedEdge.buildMessage('attention_required', parsedCcNotif, null, null, null, '', null, 'TestDevice', agentCcNotif.name);
check('[1] buildMessage(attention_required) body 含顶层 title 文本', attnMsg.body.includes('Permission needed'), attnMsg.body);

// ---------------------------------------------------------------------------
// 用例 2：Claude Code Stop —— background_tasks 非空/空
// ---------------------------------------------------------------------------
const ccStopWithBg = {
  session_id: 'abc123',
  transcript_path: '~/.claude/projects/x/y.jsonl',
  cwd: '/Users/x/project',
  permission_mode: 'default',
  hook_event_name: 'Stop',
  stop_hook_active: true,
  last_assistant_message: "I've completed the refactoring...",
  background_tasks: [{ id: 'task-001', type: 'shell', status: 'running', description: 'tail logs', command: 'tail -f /var/log/syslog' }]
};
const ccStopNoBg = { ...ccStopWithBg, background_tasks: [] };

const parsedCcStopWithBg = parseEvent(ccStopWithBg, resolveEventName(ccStopWithBg));
check('[2] CC Stop background_tasks 非空 → turn_paused', sharedEdge.classify(parsedCcStopWithBg, 'claude_code') === 'turn_paused');

const parsedCcStopNoBg = parseEvent(ccStopNoBg, resolveEventName(ccStopNoBg));
check('[2] CC Stop background_tasks 空 → task_done', sharedEdge.classify(parsedCcStopNoBg, 'claude_code') === 'task_done');

// ---------------------------------------------------------------------------
// 用例 3：Codex PermissionRequest —— 形状识别 + 分类 + 风险评级
// ---------------------------------------------------------------------------
const codexPermission = {
  session_id: 'codex-session-1',
  transcript_path: '/home/user/.codex/sessions/1.jsonl',
  cwd: '/workspace/project',
  hook_event_name: 'PermissionRequest',
  model: 'gpt-5-codex',
  turn_id: 'turn-42',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /tmp/x' }
};

const agentCodexPerm = sharedEdge.detectAgent(reqNoHeaders, codexPermission);
check('[3] Codex PermissionRequest detect=codex/shape', agentCodexPerm.id === 'codex' && agentCodexPerm.source === 'shape', JSON.stringify(agentCodexPerm));

const parsedCodexPerm = parseEvent(codexPermission, resolveEventName(codexPermission));
check('[3] Codex PermissionRequest classify=permission_required', sharedEdge.classify(parsedCodexPerm, agentCodexPerm.id) === 'permission_required');

const riskCodexPerm = sharedEdge.getRiskLevel('permission_required', parsedCodexPerm);
check('[3] getRiskLevel(rm -rf /tmp/x) >= high', ['high', 'critical'].includes(riskCodexPerm), riskCodexPerm);

// ---------------------------------------------------------------------------
// 用例 4：Codex Stop / SubagentStop
// ---------------------------------------------------------------------------
const codexStop = {
  session_id: 'codex-session-1', hook_event_name: 'Stop', model: 'gpt-5-codex',
  turn_id: 'turn-42', stop_hook_active: false, last_assistant_message: 'Done.'
};
const codexSubagentStop = {
  session_id: 'codex-session-1', hook_event_name: 'SubagentStop', model: 'gpt-5-codex',
  turn_id: 'turn-42', agent_id: 'sub-1', agent_type: 'reviewer'
};

const parsedCodexStop = parseEvent(codexStop, resolveEventName(codexStop));
check('[4] Codex Stop → task_done', sharedEdge.classify(parsedCodexStop, 'codex') === 'task_done');

const parsedCodexSubagentStop = parseEvent(codexSubagentStop, resolveEventName(codexSubagentStop));
check('[4] Codex SubagentStop → turn_paused', sharedEdge.classify(parsedCodexSubagentStop, 'codex') === 'turn_paused');

// ---------------------------------------------------------------------------
// 用例 5：Antigravity PreToolUse —— 形状识别 + 事件名推断 + 字段映射 + 分类
// ---------------------------------------------------------------------------
const agPreToolUse = {
  toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: '/workspace/project', WaitMsBeforeAsync: 5000 } },
  stepIdx: 19,
  conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587',
  workspacePaths: ['/workspace/project'],
  transcriptPath: '~/.gemini/antigravity/brain/x/.system_generated/logs/transcript.jsonl',
  artifactDirectoryPath: '~/.gemini/antigravity/brain/x'
};

const agentAgPreToolUse = sharedEdge.detectAgent(reqNoHeaders, agPreToolUse);
check('[5] Antigravity PreToolUse detect=antigravity/shape', agentAgPreToolUse.id === 'antigravity' && agentAgPreToolUse.source === 'shape', JSON.stringify(agentAgPreToolUse));

const eventNameAgPreToolUse = resolveEventName(agPreToolUse);
check("[5] inferAgEventName → 'PreToolUse'", eventNameAgPreToolUse === 'PreToolUse', eventNameAgPreToolUse);

const parsedAgPreToolUse = parseEvent(agPreToolUse, eventNameAgPreToolUse);
check('[5] parseEvent 后 tool_input.command 正确', parsedAgPreToolUse.tool_input.command === 'npm test', parsedAgPreToolUse.tool_input.command);
check('[5] Antigravity PreToolUse classify=permission_required', sharedEdge.classify(parsedAgPreToolUse, agentAgPreToolUse.id) === 'permission_required');

// ---------------------------------------------------------------------------
// 用例 6：Antigravity Stop —— fullyIdle true/false
// ---------------------------------------------------------------------------
const agStopIdle = {
  executionNum: 1, terminationReason: 'model_stop', error: '', fullyIdle: true,
  conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587', workspacePaths: ['/workspace/project'],
  transcriptPath: 'x', artifactDirectoryPath: 'y'
};
const agStopNotIdle = { ...agStopIdle, fullyIdle: false };

const parsedAgStopIdle = parseEvent(agStopIdle, resolveEventName(agStopIdle));
check('[6] Antigravity Stop fullyIdle:true → task_done', sharedEdge.classify(parsedAgStopIdle, 'antigravity') === 'task_done');

const parsedAgStopNotIdle = parseEvent(agStopNotIdle, resolveEventName(agStopNotIdle));
check('[6] Antigravity Stop fullyIdle:false → turn_paused', sharedEdge.classify(parsedAgStopNotIdle, 'antigravity') === 'turn_paused');

// ---------------------------------------------------------------------------
// 用例 7：显式头优先于 payload 形状
// ---------------------------------------------------------------------------
const reqCodexHeader = mockRequest({ 'X-Agent-Type': 'codex' });
const agentHeaderOverride = sharedEdge.detectAgent(reqCodexHeader, agPreToolUse); // antigravity 形状 payload
check('[7] 显式头 X-Agent-Type 优先于 antigravity 形状 → codex/header', agentHeaderOverride.id === 'codex' && agentHeaderOverride.source === 'header', JSON.stringify(agentHeaderOverride));

// ---------------------------------------------------------------------------
// 用例 8：User-Agent 层
// ---------------------------------------------------------------------------
const reqUaClaudeCode = mockRequest({ 'User-Agent': 'claude-code/2.1.145 (darwin; x64)' });
const agentUaClaudeCode = sharedEdge.detectAgent(reqUaClaudeCode, null);
check("[8] UA 含 'claude-code' → claude_code/ua", agentUaClaudeCode.id === 'claude_code' && agentUaClaudeCode.source === 'ua', JSON.stringify(agentUaClaudeCode));

const reqUaCurl = mockRequest({ 'User-Agent': 'curl/8.0' });
const agentUaCurl = sharedEdge.detectAgent(reqUaCurl, ccStopWithBg); // curl UA 无法判定，落到 payload 形状层
check("[8] UA 'curl/8.0' 落形状层 → claude_code/shape", agentUaCurl.id === 'claude_code' && agentUaCurl.source === 'shape', JSON.stringify(agentUaCurl));

// ---------------------------------------------------------------------------
// 用例 9：兜底 —— 空对象 payload，无头无 UA
// ---------------------------------------------------------------------------
const reqEmpty = mockRequest();
const agentFallback = sharedEdge.detectAgent(reqEmpty, {});
check('[9] 空 payload + 无头无 UA → unknown/fallback', agentFallback.id === 'unknown' && agentFallback.source === 'fallback', JSON.stringify(agentFallback));

const fallbackMsg = sharedEdge.buildMessage('info', null, null, null, null, '', null, 'Dev', sharedEdge.AGENT_NAMES.unknown);
check("[9] buildMessage 标题为「其他智能体 提醒」", fallbackMsg.title === '其他智能体 提醒', fallbackMsg.title);

// ---------------------------------------------------------------------------
// 用例 10：零回归 —— classify 不传 agentId / buildMessage 不传 agentName
// ---------------------------------------------------------------------------
check('[10] classify 不传 agentId 与 claude_code 行为一致', sharedEdge.classify(parsedCcStopNoBg) === 'task_done');

const regressionMsg = sharedEdge.buildMessage('task_done', parsedCcStopNoBg, null, null, null, '', null, 'Dev');
check("[10] buildMessage 不传 agentName → 标题 'Claude Code 已完成'", regressionMsg.title === 'Claude Code 已完成', regressionMsg.title);

// ---------------------------------------------------------------------------
// 用例 11：getDefaultConfig().agents 默认值 + 静音判断表达式三态
// ---------------------------------------------------------------------------
const defaultConfig = sharedEdge.getDefaultConfig();
check('[11] getDefaultConfig().agents 五来源默认 enabled:true',
  defaultConfig.agents?.claude_code?.enabled === true &&
  defaultConfig.agents?.codex?.enabled === true &&
  defaultConfig.agents?.antigravity?.enabled === true &&
  defaultConfig.agents?.kimi_code?.enabled === true &&
  defaultConfig.agents?.unknown?.enabled === true,
  JSON.stringify(defaultConfig.agents));

const muteExpr = (cfg) => ((cfg.agents || {})['codex'] || {}).enabled !== false;
check('[11] 静音表达式：无 agents 段 → 未静音(true)', muteExpr({}) === true);
check('[11] 静音表达式：agents.codex.enabled=true → 未静音(true)', muteExpr({ agents: { codex: { enabled: true } } }) === true);
check('[11] 静音表达式：agents.codex.enabled=false → 静音(false)', muteExpr({ agents: { codex: { enabled: false } } }) === false);

// ---------------------------------------------------------------------------
// 用例 12：lib/agent-detect.js 与 _shared.js 的 detectAgent 双份一致性
// ---------------------------------------------------------------------------
// Kimi Code PermissionRequest payload（用例 13 复用同一对象做详细断言）：
// 带 turn_id 但**无 transcript_path**，若 client_type 判据不在 codex 判据之前，
// 会命中「hook_event_name + turn_id」被误判为 Codex
const kimiPermission = {
  hook_event_name: 'PermissionRequest',
  session_id: 'kimi-session-1',
  session_title: 'Refactor utils',
  client_type: 'kimi_code_cli',
  cwd: '/workspace/project',
  turn_id: 'turn-7',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /tmp/x' }
};

const crossCheckCases = [
  ['用例1 CC Notification', reqNoHeaders, ccNotification],
  ['用例3 Codex PermissionRequest', reqNoHeaders, codexPermission],
  ['用例5 Antigravity PreToolUse', reqNoHeaders, agPreToolUse],
  ['用例7 显式头优先', reqCodexHeader, agPreToolUse],
  ['用例9 空 payload 兜底', reqEmpty, {}],
  ['用例13 Kimi PermissionRequest', reqNoHeaders, kimiPermission]
];
for (const [label, req, raw] of crossCheckCases) {
  const fromShared = sharedEdge.detectAgent(req, raw);
  const fromLib = detectAgentLib(req, raw);
  check(`[12] 双份一致 - ${label}`, JSON.stringify(fromShared) === JSON.stringify(fromLib),
    `_shared=${JSON.stringify(fromShared)} lib=${JSON.stringify(fromLib)}`);
}

// ---------------------------------------------------------------------------
// 用例 13：Kimi Code PermissionRequest —— client_type 一锤定音（防 codex 误判回归）
// ---------------------------------------------------------------------------
// 关键回归用例：payload 带 hook_event_name + turn_id（命中 codex 形状判据的组合）
// 且无 transcript_path，唯一能正确区分的信号是 client_type:'kimi_code_cli'。
// detectByShape 中 kimi 判据若未放在 codex 判据之前，此处会得到 codex 而非 kimi_code
const agentKimiPerm = sharedEdge.detectAgent(reqNoHeaders, kimiPermission);
check('[13] Kimi PermissionRequest detect=kimi_code/shape（而非 codex）',
  agentKimiPerm.id === 'kimi_code' && agentKimiPerm.source === 'shape', JSON.stringify(agentKimiPerm));

const parsedKimiPerm = parseEvent(kimiPermission, resolveEventName(kimiPermission));
check('[13] Kimi PermissionRequest classify=permission_required',
  sharedEdge.classify(parsedKimiPerm, agentKimiPerm.id) === 'permission_required');

// ---------------------------------------------------------------------------
// 用例 14：Kimi Code SessionStart —— 带 model 仍不落 codex 判据
// ---------------------------------------------------------------------------
// 同样是防误判用例：SessionStart 带 model（命中 codex 「hook_event_name + model」判据），
// 必须由 client_type 抢先识别为 kimi_code
const kimiSessionStart = {
  hook_event_name: 'SessionStart',
  session_id: 'kimi-session-1',
  session_title: 'Refactor utils',
  client_type: 'kimi_code_cli',
  cwd: '/workspace/project',
  model: 'kimi-k2'
};
const agentKimiSessionStart = sharedEdge.detectAgent(reqNoHeaders, kimiSessionStart);
check('[14] Kimi SessionStart（带 model）detect=kimi_code/shape（而非 codex）',
  agentKimiSessionStart.id === 'kimi_code' && agentKimiSessionStart.source === 'shape', JSON.stringify(agentKimiSessionStart));

// ---------------------------------------------------------------------------
// 用例 15：Kimi Code Stop / SubagentStop / StopFailure / PostToolUseFailure 分类
// ---------------------------------------------------------------------------
const kimiBase = { session_id: 'kimi-session-1', session_title: 'Refactor utils', client_type: 'kimi_code_cli', cwd: '/workspace/project' };
const kimiStop = { ...kimiBase, hook_event_name: 'Stop', stop_hook_active: false };
const kimiSubagentStop = { ...kimiBase, hook_event_name: 'SubagentStop' };
const kimiStopFailure = { ...kimiBase, hook_event_name: 'StopFailure', error_type: 'network', error_message: 'connection reset' };
const kimiPostToolUseFailure = { ...kimiBase, hook_event_name: 'PostToolUseFailure', error_type: 'tool', error_message: 'exit 1' };

check('[15] Kimi Stop → task_done',
  sharedEdge.classify(parseEvent(kimiStop, resolveEventName(kimiStop)), 'kimi_code') === 'task_done');
check('[15] Kimi SubagentStop → turn_paused',
  sharedEdge.classify(parseEvent(kimiSubagentStop, resolveEventName(kimiSubagentStop)), 'kimi_code') === 'turn_paused');
check('[15] Kimi StopFailure → attention_required',
  sharedEdge.classify(parseEvent(kimiStopFailure, resolveEventName(kimiStopFailure)), 'kimi_code') === 'attention_required');
check('[15] Kimi PostToolUseFailure → attention_required',
  sharedEdge.classify(parseEvent(kimiPostToolUseFailure, resolveEventName(kimiPostToolUseFailure)), 'kimi_code') === 'attention_required');

// ---------------------------------------------------------------------------
// 用例 16：Kimi Code Notification —— 后台任务状态变化语义（不走关键词扫描）
// ---------------------------------------------------------------------------
const kimiNotifFailed = {
  ...kimiBase,
  hook_event_name: 'Notification',
  notification_type: 'task.failed',
  title: 'Background task failed',
  body: 'npm test exited with code 1'
};
const kimiNotifCompleted = {
  ...kimiBase,
  hook_event_name: 'Notification',
  notification_type: 'task.completed',
  title: 'Background task completed',
  body: 'npm test passed'
};

check("[16] Kimi Notification 'task.failed' → attention_required",
  sharedEdge.classify(parseEvent(kimiNotifFailed, resolveEventName(kimiNotifFailed)), 'kimi_code') === 'attention_required');
check("[16] Kimi Notification 'task.completed' → task_done",
  sharedEdge.classify(parseEvent(kimiNotifCompleted, resolveEventName(kimiNotifCompleted)), 'kimi_code') === 'task_done');

// ---------------------------------------------------------------------------
// 用例 17：显式头 X-Agent-Type: kimi / kimi-code → kimi_code/header
// ---------------------------------------------------------------------------
const agentKimiHeader = sharedEdge.detectAgent(mockRequest({ 'X-Agent-Type': 'kimi' }), null);
check("[17] X-Agent-Type: 'kimi' → kimi_code/header",
  agentKimiHeader.id === 'kimi_code' && agentKimiHeader.source === 'header', JSON.stringify(agentKimiHeader));

const agentKimiCodeHeader = sharedEdge.detectAgent(mockRequest({ 'X-Agent-Type': 'kimi-code' }), null);
check("[17] X-Agent-Type: 'kimi-code' → kimi_code/header",
  agentKimiCodeHeader.id === 'kimi_code' && agentKimiCodeHeader.source === 'header', JSON.stringify(agentKimiCodeHeader));

// ---------------------------------------------------------------------------
// 用例 18：buildMessage 传 'Kimi Code' 显示名
// ---------------------------------------------------------------------------
check("[18] AGENT_NAMES.kimi_code === 'Kimi Code'",
  sharedEdge.AGENT_NAMES.kimi_code === 'Kimi Code', sharedEdge.AGENT_NAMES.kimi_code);

const kimiDoneMsg = sharedEdge.buildMessage('task_done', null, null, null, null, '', null, 'Dev', 'Kimi Code');
check("[18] buildMessage(task_done, ..., 'Kimi Code') 标题 'Kimi Code 已完成'",
  kimiDoneMsg.title === 'Kimi Code 已完成', kimiDoneMsg.title);

// ---------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
console.log(`\n${failed.length === 0 ? '🎉 全部通过' : `💥 ${failed.length} 项失败`}（共 ${results.length} 项）`);
process.exit(failed.length === 0 ? 0 : 1);
