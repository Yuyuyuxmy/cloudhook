# CloudHook 部署指南

## 前置条件

- Cloudflare 账号
- Git 仓库（GitHub/GitLab）
- 手机安装 Bark App

## 1. 创建 Cloudflare Pages 项目

1. 登录 Cloudflare Dashboard → **Workers & Pages** → **创建** → **Pages** → 连接 Git
2. 选择 `cloudhook` 仓库
3. 框架预设：**无**，构建命令：`npm run build`，输出目录：`public`（`functions/` 目录会被自动识别为 Pages Functions）

## 2. 创建 KV 命名空间并绑定

1. Dashboard → **存储和数据库** → **KV** → 创建命名空间 `cloudhook-prod`
2. Pages 项目 → **Settings** → **Bindings** → 添加 KV 绑定：变量名 `KV`，选择 `cloudhook-prod`

## 3. 配置环境变量

| 变量 | 说明 | 生成方式 |
|------|------|---------|
| `HMAC_SECRET` | 64 字符签名密钥 | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 32 字符加密密钥 | `openssl rand -hex 16` |
| `MASTER_PASSWORD_HASH` | 登录密码哈希（推荐） | `echo -n 'pwd' \| openssl dgst -sha256` |

> 也可直接设置 `MASTER_PASSWORD` 明文（不推荐）。

## 4. 部署与初始化

1. 推送代码触发自动部署（约 1-2 分钟）
2. 打开项目 URL，用 Master Password 登录
3. 在「配置」页填写 Bark Key 并测试推送

## 5. 注册 Claude Code Hook

在 `~/.claude/settings.json` 的 `hooks` 中添加：

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "https://<your-domain>/api/hook",
            "headers": { "X-CloudHook-Token": "<your-token>" }
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
            "headers": { "X-CloudHook-Token": "<your-token>" }
          }
        ]
      }
    ]
  }
}
```

重启 Claude Code，触发权限请求即可验证。

> 字段对照官方 schema：`hooks` 按事件名分组 → 数组元素 → `hooks` 子数组 → HTTP Hook（必填 `url`）。设备 Token 通过自定义请求头 `X-CloudHook-Token` 传递，为字面量字符串，无需 `allowedEnvVars`。Web 管理界面生成 Token 后会给出可直接粘贴的完整配置片段。
>
> 参考 [Claude Code Hooks 官方文档](https://code.claude.com/docs/zh-CN/hooks)

## Token 管理

- **有效期**：创建设备时可选择 7 天、30 天、90 天、1 年或永久
- **查看/撤销**：Web 界面「Token 管理」页，或 `GET/DELETE /api/token/{jti}`
- **续期**：过期后需重新登录或创建设备

## 日志管理

| 类型 | 上限 |
|------|------|
| 事件日志 | 100 条 |
| 访问日志 | 200 条 |

滚动窗口，超限自动淘汰旧记录。支持 Web 界面查看、删除、清空，以及 API 导出归档。

## KV 一致性说明

Cloudflare KV 为最终一致性存储（跨节点最长约 60 秒延迟）。Token 验证（无状态签名）和登录不受影响。配置更新后建议等待 1 分钟再验证。

## 成本

Cloudflare Pages 免费额度足够个人使用（Functions 免费版 10 万请求/天），单用户月用量 < 0.1%。

## 支持

- [GitHub Issues](https://github.com/Besty0728/cloudhook/issues)
- [Claude Code Hooks 官方文档](https://code.claude.com/docs/zh-CN/hooks)
