# CloudHook 本地开发环境指南

## 🎯 概述

本地开发环境提供完整的前后端 Mock 服务，无需部署到 Cloudflare Pages 即可进行功能开发和测试。

---

## 📦 环境要求

- Node.js 18+
- npm 或 pnpm

---

## 🚀 快速启动

### 1. 安装依赖

```bash
cd frontend
npm install
```

### 2. 配置开发密码

复制环境变量模板：

```bash
cp frontend/.env.example frontend/.env.local
```

编辑 `frontend/.env.local`，配置开发密码：

```env
# 方式 1：使用预哈希（推荐，更安全）
DEV_PASSWORD_HASH=8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918

# 方式 2：使用明文（开发环境可选）
# DEV_PASSWORD=admin
```

**默认密码**：`admin`（对应上面的哈希值）

**生成自定义密码哈希**：

```bash
node -e "console.log(require('crypto').createHash('sha256').update('your_password').digest('hex'))"
```

### 3. 启动服务

#### 方式 A：使用启动脚本（推荐）

**终端 1 - 启动 Mock API 服务器**：
```bash
node scripts/dev-mock.mjs
```

**终端 2 - 启动前端开发服务器**：
```bash
bash scripts/dev-server.sh
```

#### 方式 B：手动启动

**终端 1 - Mock API**：
```bash
node scripts/dev-mock.mjs
```

**终端 2 - 前端**：
```bash
cd frontend
npm run dev
```

### 4. 访问应用

- 前端：http://localhost:3000
- Mock API：http://localhost:8787

---

## 🔐 认证流程

### 单密码架构

用户只需记住**一个密码**（配置在 `.env.local` 中的 `DEV_PASSWORD` 或 `DEV_PASSWORD_HASH`）。

### 登录流程

```
用户输入明文密码（如: admin）
    ↓
前端 SHA-256 哈希
    ↓
发送哈希到 Mock API: POST /api/token
    ↓
Mock API 比对哈希值
    ↓
签发 Mock Token
    ↓
登录成功 ✅
```

### 写操作验证

查看 Token、撤销设备、更新配置等写操作需要密码验证：

```
前端自动从 localStorage 读取 password_hash
    ↓
附加到请求头: X-Password-Hash
    ↓
Mock API 验证哈希值
    ↓
操作成功 ✅
```

如果缓存丢失（清除了 localStorage），会自动弹窗要求重新输入密码。

---

## 🧪 测试认证配置

运行测试脚本验证配置是否正确：

```bash
node scripts/test-dev-auth.mjs
```

**预期输出**：

```
🔐 CloudHook 本地开发认证测试

📋 配置信息:
   配置方式: DEV_PASSWORD_HASH（预哈希）
   哈希值: 8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918

🧪 模拟前端登录流程:
   1. 用户输入明文密码: admin
   2. 前端 SHA-256 哈希: 8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918
   3. 发送到后端: POST /api/token { master_password: "..." }

✅ 后端验证结果:
   ✓ 密码哈希匹配！
```

---

## 📋 Mock API 功能

Mock 服务器提供完整的后端 API 模拟，无需 Cloudflare Pages 和 KV 存储。

### 支持的端点

| 端点 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/api/setup-status` | GET | 检查服务器配置状态 | 无需 |
| `/api/token` | POST | 登录/创建设备 | 密码哈希 |
| `/api/token` | GET | 获取设备列表 | Token |
| `/api/token/{jti}` | GET | 查看设备 Token 明文 | Token + 密码哈希 |
| `/api/token/{jti}` | DELETE | 撤销设备 | Token + 密码哈希 |
| `/api/config` | GET | 获取配置 | Token |
| `/api/config` | PUT | 更新配置 | Token + 密码哈希 |
| `/api/config/test` | POST | 测试 Bark 推送 | Token |
| `/api/events` | GET | 获取事件列表 | Token |
| `/api/access-logs` | GET | 获取访问日志 | Token |

### Mock 数据

Mock 服务器提供预置的测试数据：

- **设备**：3 个模拟设备（当前设备、iPhone、MacBook）
- **事件**：5 条模拟事件（任务完成、危险命令等）
- **访问日志**：6 条模拟访问记录（包含地理位置、拦截原因等）
- **配置**：完整的 Bark、风险策略、任务边界等配置

所有数据存储在**内存**中，重启服务器会重置。

---

## 🔧 开发配置

### Vite 代理

前端开发服务器（Vite）自动将 `/api/*` 请求代理到 Mock API：

```typescript
// vite.config.ts
server: {
  port: 3000,
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:8787',
      changeOrigin: true,
    },
  },
}
```

### CORS 配置

Mock API 已配置跨域支持：

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: Content-Type, Authorization, X-Password-Hash`

---

## 📝 常见问题

### Q1: 登录失败，提示"密码不匹配"

**原因**：`.env.local` 中的密码配置与前端输入不匹配。

**解决**：

1. 检查 `.env.local` 中的 `DEV_PASSWORD_HASH` 或 `DEV_PASSWORD`
2. 运行 `node scripts/test-dev-auth.mjs` 测试配置
3. 确认前端输入的密码与配置一致

### Q2: 写操作（查看 Token）失败，提示"缺少密码验证"

**原因**：localStorage 中没有 `password_hash`。

**解决**：

1. 前端会自动弹窗要求输入密码
2. 输入主密码后会自动缓存
3. 或者退出重新登录

### Q3: Mock API 端口 8787 被占用

**解决**：

修改 `scripts/dev-mock.mjs` 最后一行：

```javascript
server.listen(8788, '127.0.0.1', () => {
  // ...
});
```

同时修改 `frontend/vite.config.ts` 代理配置：

```typescript
proxy: {
  '/api': {
    target: 'http://127.0.0.1:8788',
    changeOrigin: true,
  },
}
```

### Q4: 前端请求返回 CORS 错误

**原因**：Mock API 未启动或端口不匹配。

**解决**：

1. 确认 Mock API 已启动：http://localhost:8787
2. 检查 Vite 代理配置是否正确
3. 查看浏览器控制台的网络请求

---

## 🎉 生产环境对比

| 配置项 | 本地开发 | 生产环境 |
|--------|---------|----------|
| **密码配置** | `DEV_PASSWORD_HASH` / `DEV_PASSWORD` | `MASTER_PASSWORD_HASH` / `MASTER_PASSWORD` |
| **配置文件** | `frontend/.env.local` | Cloudflare Pages 环境变量 |
| **后端** | Mock API (Node.js) | Cloudflare Pages Functions |
| **存储** | 内存（重启丢失） | KV 存储（持久化） |
| **Token 签名** | 固定 Mock Token | `HMAC_SECRET` 签名 |
| **认证流程** | ✅ 完全一致 | ✅ 完全一致 |

**关键点**：

- 认证流程完全一致，前端代码无需修改
- 密码哈希算法一致（SHA-256）
- API 契约一致，方便测试

---

## 🚀 部署到生产

开发完成后，部署到 Cloudflare Pages：

### 1. 构建前端

```bash
cd frontend
npm run build
```

产物输出到 `public/` 目录。

### 2. 配置环境变量

在 Cloudflare Pages 项目设置中配置：

```env
MASTER_PASSWORD_HASH=your_production_password_hash
HMAC_SECRET=your_64_character_random_string
```

**不要**直接复制 `.env.local` 的内容！生产环境应使用不同的强密码。

### 3. 部署

```bash
git add .
git commit -m "feat: 更新功能"
git push
```

Cloudflare Pages 会自动触发部署。

---

## 📚 相关文档

- [部署指南](./SETUP.md)
- [项目 README](../README.md)
- [Claude Code Hooks 官方文档](https://code.claude.com/docs/zh-CN/hooks)

---

## 🤝 贡献

开发新功能时：

1. 在 Mock API 中添加对应的端点
2. 更新 Mock 数据（如果需要）
3. 前端调用 API 完成功能
4. 测试通过后再实现真实的后端逻辑

这样可以**前后端并行开发**，无需等待后端完成！
