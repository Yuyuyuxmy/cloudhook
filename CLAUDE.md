# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

CloudHook — Claude Code 云端监控通知系统。Cloudflare Pages 全栈部署：Pages Functions 接收 Claude Code 的 HTTP Hook 事件，分类/评级后经 Bark 推送到 iPhone / Apple Watch，附带 React SPA 管理界面。单用户系统（userId 固定 `'default'`）。

## 常用命令

```bash
npm run dev          # 一键本地开发：Mock API(:8787) + Vite(:3000)，自动清理占用端口
npm run mock         # 仅启动 Mock API 服务器（scripts/dev-mock.mjs）
npm run build        # 构建前端到 public/（即 Cloudflare Pages 部署的产物目录）
cd frontend && npm run lint   # ESLint
```

- 本地开发默认密码 `admin`，可在 `frontend/.env.local` 用 `DEV_PASSWORD_HASH` / `DEV_PASSWORD` 覆盖
- `scripts/test-*.mjs` 为手动冒烟脚本（API 流程、Bark 推送、开发登录）
- 无自动化测试框架（`npm test` 是占位）

## 关键架构约束

### 1. 共享代码双份维护（最重要的坑）

- `lib/*.js` — 本地 Mock 服务器（`scripts/dev-mock.mjs`）import 的源模块
- `functions/_shared.js` — 部署用的**自包含打包版**，避免对 `functions/` 目录外模块的运行时依赖
- **修改 `lib/` 中任何共享逻辑，必须同步改 `_shared.js` 对应段落**（security / kv-store / risk / bark / classifier / message-builder 六段），否则本地与线上行为不一致

### 2. 平台约束与历史遗留（原 EdgeOne 时代的 workaround，现部署于 Cloudflare Pages）

- **KV 绑定通过 `env` 注入**（Cloudflare 方式，变量名 `KV` 或 `cloudhook_kv`）；一律通过 `resolveKv(env)` 获取（env 优先，globalThis 候选名兜底以兼容旧运行时）
- **KV key 只用字母/数字/下划线**（原 EdgeOne 限制，Cloudflare 无此限制，但保持格式以兼容已有数据），所有 key 用 `user_{uid}_xxx` 格式
- **API 一律返回 HTTP 200，用 `body.success` 表达结果**（原 EdgeOne 5xx 被 HTML 错误页覆盖的 workaround；前端依赖此约定，勿改）
- **`PermissionRequest` 字面量在后端用 `String.fromCharCode` 构建、前端用 `atob('UGVybWlzc2lvblJlcXVlc3Q=')` 构建**——原 EdgeOne WAF 绕过写法，Cloudflare 无此限制但无害保留，两份实现便于逐行 diff 对照
- `context.waitUntil` 行为有运行时差异 → 用 `safeWaitUntil()` 封装
- 客户端 IP 取 `CF-Connecting-IP` 头；地理信息取 `request.cf`（country/regionCode/region），兜底 `CF-IPCountry` 头（见 `getClientIp` / `getRequestLocation`）

### 3. 认证与设备模型

- Token 为**无状态 HMAC-SHA256 签名**：`base64url(payload).hex(sig)`，`verifyAuthToken` 只验签名 + exp（exp=0 为永久），不查 KV；`{ ignoreExp: true }` 可只验签跳过过期检查（hook 链路区分「无效」与「过期」用）
- 吊销靠 KV 黑名单 `revoked_{jti}`（key 经 `revokedKey()` 剥离连字符等非法字符）；**撤销永久 token（exp=0）时标记不设 TTL**，否则标记到期后 token 复活
- **管理端点一律用 `requireAuth(request, env)` 鉴权**（验签 + 吊销检查）：吊销名单不可读时 fail-closed 返回 503；hook/notify 通知链路直接调 `isTokenRevoked`，KV 异常时 fail-open 保推送可用性
- 敏感写操作（撤销设备、改配置、揭示 Token）额外要求 `X-Password-Hash` 头（前端已对密码做 SHA-256）
- **Token 是确定性可重算的**：注册表存 `iat/exp/jti/device_name`，用相同字段重签即得原文——这是「查看 Token」功能的原理，也意味着改设备名不影响已签发 Token；`buildTokenPayload` 中 exp/ttlSeconds 的 **0 是合法值（永久）**，不得用 `||` 短路
- **改 TTL 会重签 token，签发参数必须落库、前端必须回写**：`PATCH /api/token/{jti}` 用新 exp 重签时，固化后的 iat（老记录从 `created_at` 推导）要连同 exp 一并写回注册表，且签名用落库后的最终设备名——否则 reveal/重登复现不出本次返回的 token；前端 TokensPage 拿到**当前设备**的新 token 后必须回写 authStore（Hook 指引页与 apiClient 都读这份快照，不回写就永远展示旧 token）
- **登录设备匹配三层线索**（`frontend/src/utils/deviceId.ts` + `api/token.js`），按优先级：① `previous_jti`——本浏览器上次绑定的设备 jti（localStorage `cloudhook_device_jti`，logout 不清除），同浏览器重登无条件续接、指纹漂移免疫，已吊销的 jti 不复用；② `device_fingerprint`（v2）——仅由 platform/时区/min(CPU 核数,8) 哈希而成的跨浏览器稳定指纹（screen/DPR/languages/deviceMemory 均随环境或浏览器而变，不得加入）；③ `legacy_fingerprints`——历史 v1 属性哈希与更早的随机 UUID，仅迁移期兜底。命中任意一层即复用 jti 并把注册表指纹升级为当前 v2 值（自愈）。权衡：同平台同时区同核数的两台机器会被视为同一设备

### 4. Hook 事件处理流水线（hook.js）

解析（`parseEvent` 限量提取字符串，2000 节点/8KB 上限）→ `classify` 分类（permission_required / attention_required / task_done / turn_paused / info）→ `getRiskLevel` 风险评级 → `buildMessage` 构建文案 → `safeWaitUntil` 异步推 Bark + 写日志 → 立即返回 200。

- `Stop` 事件按 `background_tasks` 数组（Claude Code v2.1.145+）区分：非空 → `turn_paused`（只记日志不推送），空/缺失 → `task_done`
- **被拒绝的 hook 请求也写访问日志**（result=denied/rate_limited + reason：missing_token/invalid_token/token_expired/token_revoked/ip/geo/rate），响应仍为 HTTP 200 + `success:false`；事件日志的 `notified` 记录**真实推送结果**，失败时附 `push_error`（hook.js 与 notify.js 是双份副本，改动须同步）
- 事件日志滚动保留 100 条、访问日志 200 条；`user_{uid}_event_count` 是独立累计计数器，清空日志不影响它

**多来源识别（Codex / Antigravity / Kimi Code 支持）**

- `detectAgent(request, rawEvent)` 在 `_shared.js` 与 `lib/agent-detect.js` 双份存在，按「`X-Agent-Type` 头 → UA 规则 → payload 形状 → 兜底」四层识别，返回 `{ id, name, source }`；id 取值 `claude_code` / `codex` / `antigravity` / `kimi_code` / `unknown`。Codex / Antigravity / Kimi Code 只支持 command 类型 hook（即 curl 转发），UA 恒为 `curl/x.y`，单靠 UA 无法区分。
- payload 形状判据用于 codex 识别时明确不检查 `agent_type` 字段——Claude Code 的 `SubagentStop` 事件也带 `agent_type`，容易误判，故以 `hook_event_name` + (`turn_id` | `model`) 双层判定。Antigravity payload 本身无事件名，由 `inferAgEventName` 按 `toolCall`、`terminationReason` 等形状推断；若转发脚本提供 `X-Hook-Event` 头则优先使用。
- Kimi Code（`~/.kimi-code/config.toml` 的 `[[hooks]]`，stdin JSON，字段模仿 Claude Code）靠每个 payload 注入的 `client_type: 'kimi_code_cli'` 一锤定音；**该判据必须排在 codex 形状判据之前**——Kimi 的 `TurnStarted`/`PermissionRequest` 带 `turn_id`、`SessionStart` 带 `model`，落到 codex 判据会被误判。
- `classify(parsed, agentId)` 按来源分派分类规则映射：Claude Code 走现状规则（`Notification` 关键词扫描、`Stop` 按 `background_tasks` 分支），Codex / Antigravity / Kimi Code 各有专属规则；unknown 来源兜底用 Claude Code 规则。注意 Kimi 的 `Notification` 语义是后台任务状态变化（按 `notification_type` 的 failed/completed 分类），与 Claude Code 的 `Notification`（权限/空闲提醒）完全不同，不走关键词扫描。
- 通知文案由 `buildMessage(..., agentName)` 新增末位参数控制，显示名内置五个：`Claude Code` / `Codex` / `Antigravity` / `Kimi Code` / `其他智能体`；config 新增 `agents.{id}.enabled` 段按来源独立开关（false 时仅记日志不推送，事件标记 `push_error:'agent_muted'`）；**旧配置无 agents 段视为全启用**，消费侧一律判 `!== false` / 前端 `?? true`，缺字段绝不能静音。
- 事件日志与访问日志新增 `agent` 字段（访问日志另有 `agent_source` 记命中层级）；`GET /api/events?agent=` 与 `GET /api/access-logs?agent=` 支持按来源过滤。

### 5. 目录结构

```
functions/          # 后端（Cloudflare Pages Functions，onRequest{Get,Post,...} 导出）
  _middleware.js    # 全局 CORS/安全头/错误兜底
  _shared.js        # 自包含共享模块（见约束 1）
  api/hook.js       # 主 Webhook（notify.js 是备用别名）
  api/token.js + api/token/[jti].js   # 登录签发 / 设备管理（动态路由）
  api/config.js + api/config/test.js  # 配置读写 / Bark 测试推送
  api/events.js, api/access-logs.js   # 日志查询与删除
lib/                # 共享模块源码（本地 mock 用）
frontend/           # React 19 + Vite 8 + Zustand + Tailwind，构建到 public/
public/             # 构建产物 = Cloudflare Pages 输出目录（勿手改）
scripts/            # dev/mock/冒烟脚本
```

### 6. 部署

Cloudflare Pages 连接 Git 仓库，构建命令 `npm run build`，输出目录 `public`，函数目录 `functions`（自动识别）。必需环境变量：`HMAC_SECRET`（签名）、`ENCRYPTION_KEY`（Bark Key 加密存储）、`MASTER_PASSWORD_HASH` 或 `MASTER_PASSWORD`（登录）。KV 命名空间绑定变量名须为 `KV` 或 `cloudhook_kv`；绑定后须重新部署才生效。详见 `docs/SETUP.md`。

**不要在仓库中添加 `wrangler.toml`**：Cloudflare 会将其视为唯一事实来源，仪表板里的环境变量与 KV 绑定随即变为只读并被文件覆盖，导致 `resolveKv` 拿不到绑定、管理端点 fail-closed 返回 503。
