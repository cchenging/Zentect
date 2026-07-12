// 📁 路径: src/renderer/src/components/AuthModal.tsx
// 登录/注册模态框组件 - v3 设计系统风格
import React, { useState } from 'react';
import { X, Eye, EyeOff, Loader2, LogIn, UserPlus } from 'lucide-react';
import { useUserStore } from '../store/useUserStore';

/**
 * 认证模态框组件
 * 支持登录/注册标签页切换，v3 深空紫蓝设计风格
 */
export const AuthModal: React.FC = () => {
  const {
    isAuthModalOpen, authModalTab, isLoading, error,
    closeAuthModal, login, register, clearError,
    openAuthModal,
  } = useUserStore();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  /** 处理登录 */
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;
    await login(username.trim(), password);
  };

  /** 处理注册 */
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;
    if (password !== confirmPassword) {
      useUserStore.setState({ error: '两次输入的密码不一致' });
      return;
    }
    if (password.length < 6) {
      useUserStore.setState({ error: '密码长度至少 6 位' });
      return;
    }
    await register(username.trim(), password);
  };

  /** 切换标签页时清除状态 */
  const switchTab = (tab: 'login' | 'register') => {
    openAuthModal(tab);
    setUsername('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    clearError();
  };

  if (!isAuthModalOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* 毛玻璃遮罩 */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={closeAuthModal}
      />

      {/* 模态框主体 */}
      <div className="relative w-[400px] rounded-2xl border border-white/10 bg-[#141428]/95 backdrop-blur-xl shadow-2xl shadow-black/40 animate-in fade-in zoom-in-95 duration-200">
        {/* 关闭按钮 */}
        <button
          onClick={closeAuthModal}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors outline-none cursor-pointer"
        >
          <X size={18} />
        </button>

        {/* 品牌区 */}
        <div className="pt-8 pb-4 px-8 text-center">
          <div className="w-12 h-12 mx-auto rounded-xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-purple)] flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-[var(--accent)]/20 mb-4">
            Z
          </div>
          <h2 className="text-xl font-semibold text-white">
            {authModalTab === 'login' ? '欢迎回来' : '创建账号'}
          </h2>
          <p className="text-sm text-white/40 mt-1">
            {authModalTab === 'login' ? '登录以同步你的创作数据' : '注册即可开始 AI 创作之旅'}
          </p>
        </div>

        {/* 标签页切换 */}
        <div className="flex mx-8 rounded-lg bg-white/5 p-1">
          <button
            onClick={() => switchTab('login')}
            className={`flex-1 h-9 rounded-md text-sm font-medium transition-all cursor-pointer outline-none ${
              authModalTab === 'login'
                ? 'bg-[var(--accent)] text-white shadow-md shadow-[var(--accent)]/25'
                : 'text-white/50 hover:text-white/80'
            }`}
          >
            登录
          </button>
          <button
            onClick={() => switchTab('register')}
            className={`flex-1 h-9 rounded-md text-sm font-medium transition-all cursor-pointer outline-none ${
              authModalTab === 'register'
                ? 'bg-[var(--accent)] text-white shadow-md shadow-[var(--accent)]/25'
                : 'text-white/50 hover:text-white/80'
            }`}
          >
            注册
          </button>
        </div>

        {/* 表单区 */}
        <form
          onSubmit={authModalTab === 'login' ? handleLogin : handleRegister}
          className="px-8 pt-6 pb-8 flex flex-col gap-4"
        >
          {/* 用户名 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-white/50 font-medium">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              className="h-10 px-3 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-white/25 outline-none focus:border-[var(--accent)]/60 focus:ring-1 focus:ring-[var(--accent)]/30 transition-all"
              autoComplete="username"
              autoFocus
            />
          </div>

          {/* 密码 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-white/50 font-medium">密码</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={authModalTab === 'register' ? '至少 6 位密码' : '请输入密码'}
                className="h-10 w-full px-3 pr-10 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-white/25 outline-none focus:border-[var(--accent)]/60 focus:ring-1 focus:ring-[var(--accent)]/30 transition-all"
                autoComplete={authModalTab === 'login' ? 'current-password' : 'new-password'}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors outline-none cursor-pointer"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {/* 确认密码（仅注册） */}
          {authModalTab === 'register' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-white/50 font-medium">确认密码</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码"
                className="h-10 px-3 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-white/25 outline-none focus:border-[var(--accent)]/60 focus:ring-1 focus:ring-[var(--accent)]/30 transition-all"
                autoComplete="new-password"
              />
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-[var(--destructive)]/10 border border-[var(--destructive)]/20 text-xs text-[var(--destructive)]">
              {error}
            </div>
          )}

          {/* 提交按钮 */}
          <button
            type="submit"
            disabled={isLoading || !username.trim() || !password.trim()}
            className="h-10 mt-2 rounded-lg bg-gradient-to-r from-[var(--accent)] to-[var(--accent-purple)] text-white text-sm font-semibold shadow-lg shadow-[var(--accent)]/25 hover:shadow-[var(--accent)]/40 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer outline-none flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : authModalTab === 'login' ? (
              <LogIn size={16} />
            ) : (
              <UserPlus size={16} />
            )}
            {authModalTab === 'login' ? '登录' : '注册'}
          </button>
        </form>
      </div>
    </div>
  );
};
