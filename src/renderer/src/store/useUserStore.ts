// 📁 路径: src/renderer/src/store/useUserStore.ts
// 用户认证与信息状态管理（独立 Store，不混入编辑器状态）
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { API } from '../api';

/** 用户信息类型 */
interface UserInfo {
  userId: string;
  username: string;
  avatar: string | null;
  vipLevel: 'free' | 'pro' | 'ultra';
  vipExpireAt: string | null;
}

/** 用户状态切片类型 */
interface UserState {
  /** 是否已登录 */
  isLoggedIn: boolean;
  /** 当前用户信息 */
  userInfo: UserInfo | null;
  /** 认证令牌 */
  token: string | null;
  /** 是否正在加载 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 认证模态框是否可见 */
  isAuthModalOpen: boolean;
  /** 认证模态框当前标签页 */
  authModalTab: 'login' | 'register';

  /** 打开认证模态框 */
  openAuthModal: (tab?: 'login' | 'register') => void;
  /** 关闭认证模态框 */
  closeAuthModal: () => void;
  /** 用户注册 */
  register: (username: string, password: string) => Promise<boolean>;
  /** 用户登录 */
  login: (username: string, password: string, rememberMe?: boolean) => Promise<boolean>;
  /** 用户登出 */
  logout: () => Promise<void>;
  /** 获取用户资料 */
  fetchProfile: () => Promise<void>;
  /** 检查会话有效性 */
  checkSession: () => Promise<void>;
  /** VIP 激活码激活 */
  activateVip: (code: string) => Promise<boolean>;
  /** 清除错误 */
  clearError: () => void;
}

/**
 * 用户认证与信息状态管理
 * 使用 persist 中间件持久化 token，实现自动登录
 */
export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      isLoggedIn: false,
      userInfo: null,
      token: null,
      isLoading: false,
      error: null,
      isAuthModalOpen: false,
      authModalTab: 'login',

      /** 打开认证模态框 */
      openAuthModal: (tab = 'login') => set({ isAuthModalOpen: true, authModalTab: tab, error: null }),

      /** 关闭认证模态框 */
      closeAuthModal: () => set({ isAuthModalOpen: false, error: null }),

      /** 用户注册 */
      register: async (username, password) => {
        set({ isLoading: true, error: null });
        try {
          const result = await API.user.register(username, password);
          set({
            isLoggedIn: true,
            token: result.token,
            userInfo: { userId: result.userId, username, avatar: null, vipLevel: 'free', vipExpireAt: null },
            isAuthModalOpen: false,
            isLoading: false,
          });
          return true;
        } catch (err: any) {
          set({ error: err.message || '注册失败', isLoading: false });
          return false;
        }
      },

      /** 用户登录 */
      login: async (username, password, rememberMe = false) => {
        set({ isLoading: true, error: null });
        try {
          const result = await API.user.login(username, password, rememberMe);
          set({
            isLoggedIn: true,
            token: result.token,
            userInfo: { userId: result.userId, username, avatar: null, vipLevel: 'free', vipExpireAt: null },
            isAuthModalOpen: false,
            isLoading: false,
          });
          // 登录后拉取完整资料
          get().fetchProfile();
          return true;
        } catch (err: any) {
          set({ error: err.message || '登录失败', isLoading: false });
          return false;
        }
      },

      /** 用户登出 */
      logout: async () => {
        const token = get().token;
        if (token) {
          try { await API.user.logout(token); } catch {}
        }
        set({ isLoggedIn: false, userInfo: null, token: null });
      },

      /** 获取用户资料 */
      fetchProfile: async () => {
        const { userInfo } = get();
        if (!userInfo) return;
        try {
          const profile = await API.user.getProfile(userInfo.userId);
          if (profile) {
            set({
              userInfo: {
                userId: profile.id || userInfo.userId,
                username: profile.username || userInfo.username,
                avatar: profile.avatar || null,
                vipLevel: profile.vip_level || 'free',
                vipExpireAt: profile.vip_expire_at || null,
              },
            });
          }
        } catch {}
      },

      /** 检查会话有效性 */
      checkSession: async () => {
        const token = get().token;
        if (!token) return;
        try {
          const result = await API.user.checkSession(token);
          if (result.valid && result.userId) {
            set({ isLoggedIn: true });
            get().fetchProfile();
          } else {
            set({ isLoggedIn: false, userInfo: null, token: null });
          }
        } catch {
          set({ isLoggedIn: false, userInfo: null, token: null });
        }
      },

      /** VIP 激活码激活 */
      activateVip: async (code) => {
        const { userInfo } = get();
        if (!userInfo) return false;
        set({ isLoading: true, error: null });
        try {
          await API.user.activateVip(userInfo.userId, code);
          await get().fetchProfile();
          set({ isLoading: false });
          return true;
        } catch (err: any) {
          set({ error: err.message || '激活失败', isLoading: false });
          return false;
        }
      },

      /** 清除错误 */
      clearError: () => set({ error: null }),
    }),
    {
      name: 'zentect-user',
      // 仅持久化 token，不持久化敏感信息
      partialize: (state) => ({ token: state.token }),
    }
  )
);
