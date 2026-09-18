# CloudHook

Claude Code 云端监控通知系统。基于 Cloudflare Pages 部署，通过 [HTTP Hook](https://code.claude.com/docs/zh-CN/hooks) 接收 Claude Code 事件，实时推送 Bark 通知到 iPhone / Apple Watch。

```
Claude Code  →  HTTP Hook  →  Cloudflare Pages Functions  →  Bark  →  iPhone / Watch
```

## 功能

- **实时通知** — PermissionRequest（权限请求）、Stop（任务完成）事件自动分类推送
- **智能风险评级** — 根据工具类型和命令内容判定 low / medium / high / critical
- **安全认证** — HMAC-SHA256 无状态 Token + AES-256-GCM 加密存储 Bark Key
- **风险控制** — IP 黑白名单、地理位置限制、速率限制（100 次/分钟）
- **Web 管理界面** — 配置、事件流、Token 管理、访问日志，React SPA 一站式操作
- **多设备支持** — 每台设备独立 Token，可单独撤销
- **免费运行** — Cloudflare Pages 免费额度完全够用

## 快速开始

### 1. 部署

详细步骤见 [部署指南](docs/SETUP.md)，简要流程：

1. Cloudflare Dashboard → Workers & Pages 创建 Pages 项目，连接 Git 仓库，构建命令 `npm run build`，输出目录 `public`
2. 创建 KV 命名空间，在项目设置中绑定，变量名 `KV`
3. 配置环境变量：

| 变量 | 说明 | 生成 |
|------|------|------|
| `HMAC_SECRET` | 签名密钥 | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 加密密钥 | `openssl rand -hex 16` |
| `MASTER_PASSWORD_HASH` | 登录密码 | `echo -n 'pwd' \| openssl dgst -sha256` |

### 2. 配置

打开部署后的 Web 地址，用 Master Password 登录，配置 Bark Key 并测试推送。

### 3. 注册 Hook

编辑 `~/.claude/settings.json`，添加 HTTP Hook：

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "https://<your-domain>/api/hook",
            "headers": {
              "X-CloudHook-Token": "<your-token>"
            }
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "https://<your-domain>/api/hook",
            "headers": {
              "X-CloudHook-Token": "<your-token>"
            }
          }
        ]
      }
    ]
  }
}
```

> 字段说明（对照 [Claude Code Hooks 官方 schema](https://code.claude.com/docs/zh-CN/hooks)）：`hooks` 按事件名分组，每个事件是一个数组，数组元素含 `hooks` 子数组；HTTP Hook 必填 `url`，CloudHook 通过自定义请求头 `X-CloudHook-Token` 携带设备 Token。Token 为字面量字符串（非 `$VAR`），无需配置 `allowedEnvVars`。Web 管理界面生成 Token 后会直接给出可粘贴的完整片段。

重启 Claude Code，触发一次权限请求即可验证。

## 项目结构

```
cloudhook/
├── functions/                 # Cloudflare Pages Functions
│   ├── _shared.js             # 核心模块（安全、分类、风险、Bark、KV）
│   ├── _middleware.js          # 全局中间件
│   └── api/
│       ├── hook.js             # Webhook 处理（主）
│       ├── notify.js           # Webhook 处理（备用别名）
│       ├── token.js            # 设备与 Token 管理
│       ├── config.js           # 配置读写
│       ├── events.js           # 事件日志
│       └── access-logs.js      # 访问日志
├── frontend/                   # React 前端
├── public/                     # 构建产物
├── scripts/                    # 开发 & 部署脚本
└── docs/
    ├── SETUP.md                # 部署指南
    └── LOCAL_DEVELOPMENT.md    # 本地开发
```

## Hook 事件

| 事件 | 触发时机 | 通知分类 |
|------|---------|---------|
| `PermissionRequest` | Claude Code 请求授权 | permission_required / attention_required |
| `Stop`（无后台任务） | 任务真正完成 | task_done |
| `Stop`（有后台任务） | 一轮响应结束，subagent 等仍在运行 | turn_paused（只记日志，不推送） |

> `Stop` 事件每轮响应结束都会触发，并非任务完成。CloudHook 通过 hook 输入中的 `background_tasks` 数组（Claude Code v2.1.145+）区分两种情况：非空 → `turn_paused`，为空或缺失（旧版本兼容）→ `task_done`。

风险评级由 `getRiskLevel()` 根据 `tool_name` 和命令内容智能判定，而非统一标记高风险。

## 本地开发

```bash
cd frontend && npm install

npm run dev
```

访问 http://localhost:3000，默认密码 `admin`。详见 [本地开发指南](docs/LOCAL_DEVELOPMENT.md)。

## 技术栈

**后端** — Cloudflare Pages Functions、Cloudflare KV、Web Crypto API

**前端** — React 19、Vite 8、React Router 7、Zustand、Tailwind CSS

## 日志策略

事件日志保留 100 条，访问日志保留 200 条，滚动窗口自动淘汰旧记录。支持前端单条/批量删除和清空。

另有独立的累计计数器（KV key `user_{uid}_event_count`）记录历史累计接收事件数，仪表板"总事件数"显示该值；清空/删除日志不影响累计数。

## 许可证

MIT
