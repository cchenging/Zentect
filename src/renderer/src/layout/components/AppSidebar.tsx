// 📁 路径: src/renderer/src/layout/components/AppSidebar.tsx
// 全局侧边栏 - V3 深空紫蓝设计
import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Home, Download, Crown, LogOut, LogIn } from 'lucide-react';
import { AppIcon } from '../../components/app-icon';
import { useI18n } from '../../store/useI18n';
import { useUserStore } from '../../store/useUserStore';
import { UI_CONFIG } from '../../constants/ui';

interface AppSidebarProps {
  className?: string;
}

/**
 * 全局侧边栏组件
 * V3 设计：深空紫蓝背景、渐变品牌区、用户认证集成
 */
export const AppSidebar: React.FC<AppSidebarProps> = ({ className = "" }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();
  const { isLoggedIn, userInfo, openAuthModal, logout } = useUserStore();

  /** 导航项 */
  const navItems = [
    { key: '/', icon: <Home size={18} />, label: t.nav?.home || '首页' },
    { key: '/models', icon: <Download size={18} />, label: '模型下载' },
  ];

  /** VIP 等级显示文本 */
  const vipLabel = userInfo?.vipLevel === 'ultra' ? '至尊版' : userInfo?.vipLevel === 'pro' ? '专业版' : '免费版';

  return (
    <aside className={`${className} flex flex-col bg-card select-none z-20`}>
      {/* 品牌区：与标题栏齐平 */}
      <div className={`${UI_CONFIG.TOPBAR_HEIGHT_CLASS} flex items-center px-4 shrink-0 gap-3 border-b border-border/50 bg-bg-deep/50 [-webkit-app-region:drag]`}>
        <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent to-accent-purple flex items-center justify-center text-white font-bold text-[11px] shadow-md shadow-accent/20 [-webkit-app-region:no-drag]">
          Z
        </div>
        <span className="font-bold text-sm tracking-wide text-foreground [-webkit-app-region:no-drag]">Zentect</span>
      </div>

      {/* 主导航区 */}
      <nav className="flex-1 flex flex-col gap-1 px-3 mt-4 [-webkit-app-region:no-drag]">
        {navItems.map((item) => {
          const isActive = location.pathname === item.key;
          return (
            <button
              key={item.key}
              onClick={() => navigate(item.key)}
              className={`w-full h-10 flex items-center gap-3 px-3 rounded-xl transition-all cursor-pointer outline-none
                ${isActive
                  ? 'bg-accent/10 text-accent font-semibold shadow-sm shadow-accent/10'
                  : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground font-medium'}`}
            >
              {item.icon}
              <span className="text-[13px] tracking-wide">{item.label}</span>
              {isActive && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-accent animate-pulse-glow" />}
            </button>
          );
        })}
      </nav>

      {/* 底部用户区 */}
      <div className="p-3 mb-2 [-webkit-app-region:no-drag]">
        <div className="glass-card-sm p-3 flex flex-col gap-3 cursor-pointer group relative overflow-hidden">
          {/* 悬停渐变背景 */}
          <div className="absolute inset-0 bg-gradient-to-br from-accent/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

          {/* 用户信息行 */}
          <div className="flex items-center gap-3 relative z-10">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-accent/20 to-accent-purple/20 border border-accent/20 flex items-center justify-center text-accent overflow-hidden shrink-0">
              {userInfo?.avatar ? (
                <img src={userInfo.avatar} alt="" className="w-full h-full object-cover" />
              ) : (
                <AppIcon name="User" size={18} />
              )}
            </div>
            <div className="flex flex-col flex-1 overflow-hidden text-left">
              <span className="text-[13px] font-semibold text-foreground truncate">
                {isLoggedIn ? userInfo?.username : (t.user?.unlogged_title || '未登录')}
              </span>
              <span className="text-[10px] text-muted-foreground truncate">
                {isLoggedIn ? vipLabel : (t.user?.unlogged_desc || '点击登录账号')}
              </span>
            </div>
          </div>

          {/* 操作按钮行 */}
          <div className="flex items-center gap-2 relative z-10">
            {isLoggedIn ? (
              <>
                {/* VIP 升级/状态 */}
                <div className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold tracking-wide transition-all
                  ${userInfo?.vipLevel === 'free'
                    ? 'bg-accent-warm/10 text-accent-warm border border-accent-warm/20 hover:bg-accent-warm/20'
                    : 'bg-accent/10 text-accent border border-accent/20'}`}
                  onClick={() => navigate('/settings')}
                >
                  <Crown size={12} />
                  {userInfo?.vipLevel === 'free' ? (t.user?.pro_activate || '升级专业版') : vipLabel}
                </div>
                {/* 登出按钮 */}
                <button
                  onClick={(e) => { e.stopPropagation(); logout(); }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-accent-rose hover:bg-accent-rose/10 transition-colors cursor-pointer outline-none"
                  title="退出登录"
                >
                  <LogOut size={14} />
                </button>
              </>
            ) : (
              <button
                onClick={() => openAuthModal('login')}
                className="flex-1 h-8 rounded-lg bg-gradient-to-r from-accent to-accent-purple text-white text-[11px] font-semibold shadow-md shadow-accent/20 hover:shadow-accent/30 hover:brightness-110 transition-all cursor-pointer outline-none flex items-center justify-center gap-1.5"
              >
                <LogIn size={13} /> 登录
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
};
