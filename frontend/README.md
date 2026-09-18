# CloudHook 前端开发指南

## 技术栈

- **框架**: React 19 + TypeScript
- **构建工具**: Vite 8
- **路由**: React Router 7 (Hash 模式)
- **状态管理**: Zustand (轻量级)
- **UI**: Tailwind CSS + Headless UI + Framer Motion
- **图标**: lucide-react
- **HTTP 客户端**: Axios + SWR
- **工具库**: date-fns, clsx

## 目录结构

```
frontend/
├── src/
│   ├── api/           # API 调用层
│   │   ├── client.ts  # Axios 实例 + HMAC 签名
│   │   ├── auth.ts    # 认证 API
│   │   ├── config.ts  # 配置 API
│   │   ├── events.ts  # 事件 API
│   │   └── tokens.ts  # Token API
│   ├── components/    # 通用组件
│   │   ├── Layout.tsx
│   │   ├── LoadingSpinner.tsx
│   │   └── Toast.tsx
│   ├── hooks/         # 自定义 Hooks
│   │   └── useToast.ts
│   ├── pages/         # 页面组件
│   │   ├── Login.tsx
│   │   ├── Dashboard.tsx
│   │   ├── ConfigPage.tsx
│   │   ├── EventsPage.tsx
│   │   ├── HooksPage.tsx
│   │   └── TokensPage.tsx
│   ├── store/         # Zustand 状态
│   │   └── authStore.ts
│   ├── types/         # TypeScript 类型
│   │   └── api.ts
│   ├── utils/         # 工具函数
│   │   ├── hmac.ts
│   │   └── format.ts
│   ├── App.tsx        # 根组件 + 路由配置
│   ├── main.tsx       # 应用入口
│   └── index.css      # 全局样式
├── public/            # 构建输出目录（git ignored）
├── vite.config.ts     # Vite 配置
├── tailwind.config.js # Tailwind CSS 配置
├── tsconfig.json      # TypeScript 配置
└── package.json       # 依赖管理
```

## 开发环境设置

### 1. 安装依赖

```bash
cd frontend
npm install
```

### 2. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

### 3. 构建生产版本

```bash
npm run build
```

输出到 `../public/` 目录。

## API 集成

### 认证流程

1. 用户登录 → 生成 Token (POST /api/token)
2. Token 存储到 localStorage
3. 所有请求自动添加 `X-CloudHook-Token` header
4. 401 错误自动跳转到登录页

### HMAC 签名

敏感操作（PUT /api/config, DELETE /api/token）需要 HMAC 签名：

```typescript
import { signedRequest } from '@/api/client';

// 更新配置
await signedRequest('PUT', '/api/config', { bark_key: 'new_key' });

// 撤销 Token
await signedRequest('DELETE', `/api/token/${tokenId}`);
```

### API 调用示例

```typescript
import { getConfig, updateConfig, testBarkPush } from '@/api/config';

// 获取配置
const config = await getConfig();

// 更新配置（自动签名）
await updateConfig({ bark_key: 'new_key' });

// 测试推送
await testBarkPush();
```

## 状态管理

使用 Zustand 管理全局认证状态：

```typescript
import { useAuthStore } from '@/store/authStore';

const { token, isLoggedIn, setToken, logout } = useAuthStore();

// 登录
setToken(token, hmacSecret);

// 登出
logout();
```

## Toast 通知

```typescript
import { useToast } from '@/hooks/useToast';

const { success, error, info, warning } = useToast();

success('操作成功！');
error('操作失败');
```

## 路由配置

使用 Hash 模式（兼容静态部署）：

```
/#/login         - 登录页
/#/dashboard     - 仪表板
/#/config        - 配置页
/#/hooks         - Hooks 管理
/#/events        - 事件流
/#/tokens        - Token 管理
```

## 样式规范

使用 Tailwind CSS：

```tsx
<div className="bg-white rounded-lg shadow p-6">
  <h1 className="text-3xl font-bold text-gray-900 mb-6">标题</h1>
  <button className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
    按钮
  </button>
</div>
```

## 环境变量

创建 `.env` 文件：

```bash
# API 基础 URL（生产环境留空）
VITE_API_URL=
```

## 部署流程

### 开发部署

```bash
# 1. 构建前端
cd frontend
npm run build

# 2. 提交到 Git
cd ..
git add public/
git commit -m "build: update frontend"
git push
```

### Cloudflare Pages 自动部署

Push 到 Git 后，Cloudflare Pages 会自动检测并部署。

## 常见问题

### Q: API 请求 CORS 错误？

A: 前端和后端部署在同一域名下，不存在跨域问题。开发环境使用 Vite proxy。

### Q: 如何调试 HMAC 签名？

A: 
1. 检查 localStorage 中的 `hmac_secret`
2. 查看浏览器 Network 面板的请求 headers
3. 对比后端日志中的签名计算过程

### Q: Token 过期如何处理？

A: Axios 拦截器会自动捕获 401 错误，清除 Token 并跳转到登录页。

## 待实现功能

- [x] 配置页完整实现
- [x] 事件流筛选和批量管理
- [x] Token 管理完整功能
- [ ] 深色模式
- [ ] 响应式优化
- [ ] 错误边界处理

## 技术债务

- date-fns locale 打包优化
- 图标按需加载
- 代码分割优化

## 参考资源

- [Vite 文档](https://vite.dev/)
- [React Router 文档](https://reactrouter.com/)
- [Tailwind CSS 文档](https://tailwindcss.com/)
- [Zustand 文档](https://zustand-demo.pmnd.rs/)
