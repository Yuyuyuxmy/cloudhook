# CloudHook 开发脚本

## 📜 脚本列表

### 🚀 启动脚本

#### `dev-mock.mjs`
**本地 Mock API 服务器**

- **端口**：8787
- **功能**：模拟所有后端 API，无需 Cloudflare Pages 和 KV 存储
- **启动**：
  ```bash
  node scripts/dev-mock.mjs
  ```

#### `dev-server.sh`
**前端开发服务器启动脚本**

- **端口**：3000
- **功能**：启动 Vite 前端开发服务器，自动代理 API 请求到 Mock 服务器
- **启动**：
  ```bash
  bash scripts/dev-server.sh
  ```

### 🧪 测试脚本

#### `test-dev-auth.mjs`
**认证配置测试**

- **功能**：验证本地开发环境的密码配置是否正确
- **运行**：
  ```bash
  node scripts/test-dev-auth.mjs
  ```
- **输出示例**：
  ```
  🔐 CloudHook 本地开发认证测试
  
  ✅ 后端验证结果:
     ✓ 密码哈希匹配！
  ```

---

## 🎯 快速启动指南

### 完整开发环境

**步骤 1：配置开发密码**

```bash
# 复制模板
cp frontend/.env.example frontend/.env.local

# 编辑 frontend/.env.local，设置密码
# 默认密码: admin
```

**步骤 2：启动 Mock API**

```bash
# 终端 1
node scripts/dev-mock.mjs
```

**步骤 3：启动前端**

```bash
# 终端 2
bash scripts/dev-server.sh
```

**步骤 4：访问应用**

- 前端：http://localhost:3000
- 登录密码：`admin`（或你在 `.env.local` 中配置的密码）

---

## 🔐 密码配置

### 生成密码哈希

```bash
node -e "console.log(require('crypto').createHash('sha256').update('your_password').digest('hex'))"
```

### 配置方式

在 `frontend/.env.local` 中：

**方式 1：预哈希（推荐）**
```env
DEV_PASSWORD_HASH=8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918
```

**方式 2：明文（开发环境可选）**
```env
DEV_PASSWORD=admin
```

Mock 服务器会自动处理两种方式。

---

## 📝 开发流程

1. **启动服务**
   - Mock API (8787) + 前端 (3000)

2. **登录测试**
   - 访问 http://localhost:3000
   - 输入密码登录

3. **功能开发**
   - 前端代码：`frontend/src/`
   - Mock API：`scripts/dev-mock.mjs`

4. **验证功能**
   - 所有操作使用单密码
   - 自动密码缓存（localStorage）

---

## 🛠️ 故障排查

### Mock API 端口冲突

修改 `dev-mock.mjs` 最后一行：

```javascript
server.listen(8788, '127.0.0.1', () => { ... });
```

同时修改 `frontend/vite.config.ts`：

```typescript
proxy: {
  '/api': {
    target: 'http://127.0.0.1:8788',
    changeOrigin: true,
  },
}
```

### 认证失败

运行测试脚本检查配置：

```bash
node scripts/test-dev-auth.mjs
```

---

## 📚 完整文档

详细开发指南请查看：[docs/LOCAL_DEVELOPMENT.md](../docs/LOCAL_DEVELOPMENT.md)
