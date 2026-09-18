/**
 * 登录页（浅色统一风）
 *
 * 与主界面同一套设计语言：柔和灰白渐变背景 + 浮动光斑 + 毛玻璃白卡 + 黑色主按钮。
 * 浮动标签用 Tailwind peer 变体实现（placeholder-shown / focus），无需独立 CSS。
 * 登录逻辑（预哈希、setup-status 检查、密码显隐）与旧版完全一致，仅改呈现层。
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { login, getSetupStatus } from '@/api/auth';
import { useToast } from '@/hooks/useToast';
import Toast from '@/components/Toast';
import { hashPassword } from '@/utils/passwordHash';

// 静态背景光斑（rendering-hoist-jsx：无状态依赖，提升到组件外避免重建）
const backgroundBlobs = (
  <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
    <div className="absolute -top-24 -left-24 w-96 h-96 bg-stone-200/70 rounded-full blur-3xl animate-blob" />
    <div className="absolute top-1/3 -right-32 w-[28rem] h-[28rem] bg-slate-200/70 rounded-full blur-3xl animate-blob animation-delay-2000" />
    <div className="absolute -bottom-32 left-1/4 w-96 h-96 bg-gray-300/50 rounded-full blur-3xl animate-blob animation-delay-4000" />
  </div>
);

const logoMark = (
  <div className="w-14 h-14 bg-black rounded-2xl flex items-center justify-center shadow-lg shadow-gray-900/15 mb-4">
    <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  </div>
);

export default function Login() {
  const navigate = useNavigate();
  const { setToken } = useAuthStore();
  const { toasts, removeToast, success, error } = useToast();

  const [masterPassword, setMasterPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // 服务端是否已配置 MASTER_PASSWORD；false 时提示部署者先配置环境变量
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    getSetupStatus().then((status) => setConfigured(status.configured));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!masterPassword.trim()) {
      error('请输入 Master Password');
      return;
    }

    setIsLoading(true);

    try {
      // 前端预哈希密码，防止明文传输
      const passwordHash = await hashPassword(masterPassword);

      const response = await login(passwordHash);
      // 无状态签名 token 签发后立即有效，无需等待 KV 同步
      // 存储密码哈希用于后续的写操作验证
      setToken(response.token, passwordHash);
      success('登录成功！');
      navigate('/dashboard');
    } catch (err) {
      console.error('Login error:', err);
      const e = err as { response?: { data?: { message?: string; error?: string } }; message?: string };
      const message = e.response?.data?.message || e.response?.data?.error || e.message || '登录失败';
      error(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-gradient-to-br from-slate-50 via-gray-50 to-stone-50 flex items-center justify-center p-6">
      {backgroundBlobs}

      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          onClose={() => removeToast(toast.id)}
        />
      ))}

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="relative w-full max-w-md"
      >
        <div className="bg-white/80 backdrop-blur-xl rounded-3xl shadow-xl border border-gray-200/80 p-8 sm:p-10">
          {/* 品牌区 */}
          <div className="flex flex-col items-center mb-8">
            {logoMark}
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">CloudHook</h1>
            <p className="text-sm text-gray-500 mt-1 tracking-wide">AI Agent 云端监控哨兵</p>
          </div>

          {/* 服务端未配置提示 */}
          {configured === false ? (
            <div className="mb-6 flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <AlertTriangle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-amber-800 leading-relaxed tracking-wide">
                服务端尚未配置 MASTER_PASSWORD，请先在 Cloudflare Pages 项目设置中配置环境变量后重新部署
              </p>
            </div>
          ) : null}

          <form onSubmit={handleSubmit}>
            {/* 浮动标签密码输入 */}
            <div className="relative">
              <input
                id="master-password"
                required
                type={showPassword ? 'text' : 'password'}
                value={masterPassword}
                onChange={(e) => setMasterPassword(e.target.value)}
                disabled={isLoading}
                placeholder="Master Password"
                className="peer w-full h-12 px-4 pr-12 rounded-xl border border-gray-300 bg-white/70 text-gray-900 text-[15px] placeholder-transparent outline-none transition-all duration-200 focus:border-gray-900 focus:ring-4 focus:ring-gray-900/5 disabled:opacity-60 disabled:cursor-not-allowed"
              />
              <label
                htmlFor="master-password"
                className="absolute left-3 -top-2 px-1.5 bg-white rounded text-xs text-gray-600 tracking-wide pointer-events-none transition-all duration-200 peer-placeholder-shown:top-3.5 peer-placeholder-shown:left-4 peer-placeholder-shown:px-0 peer-placeholder-shown:bg-transparent peer-placeholder-shown:text-[15px] peer-placeholder-shown:text-gray-400 peer-focus:-top-2 peer-focus:left-3 peer-focus:px-1.5 peer-focus:bg-white peer-focus:text-xs peer-focus:text-gray-700"
              >
                Master Password
              </label>
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors duration-200"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>

            {/* 登录按钮 */}
            <button
              type="submit"
              disabled={isLoading}
              className="mt-6 w-full h-12 rounded-xl bg-gray-900 text-white text-sm font-medium tracking-widest shadow-lg shadow-gray-900/15 hover:bg-black hover:shadow-xl hover:shadow-gray-900/20 active:scale-[0.99] transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  登录中...
                </>
              ) : (
                '登 录'
              )}
            </button>
          </form>

          <p className="mt-8 text-center text-xs text-gray-400 tracking-wide">
            登录即签发本设备的访问 Token
          </p>
        </div>
      </motion.div>
    </div>
  );
}
