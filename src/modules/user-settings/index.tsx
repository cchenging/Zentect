// 📁 路径: src/modules/settings/user-settings/index.tsx
// 用户个人设置页面（从 pages/user-settings 迁移，import 路径已更新）
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, User, Lock, Image, Save, Eye, EyeOff } from 'lucide-react';
import { Input } from '@renderer/components/ui/input';
import { Button } from '@renderer/components/ui/button';
import { useUserStore } from '@renderer/store/useUserStore';
import { AppNotifier } from '@renderer/core/AppNotifier';
import { FormField } from '@renderer/components/ui/form-field';
import { API } from '@renderer/api';

/**
 * 用户个人设置页面
 * 支持修改密码（旧密码/新密码/确认密码）
 * 支持修改头像（本地图片选择）
 * 修改成功后 toaster 提示
 */
const UserSettings: React.FC = () => {
  const navigate = useNavigate();
  const { userInfo, logout } = useUserStore();

  const [activeTab, setActiveTab] = useState<'profile' | 'security'>('profile');

  /** 密码修改状态 */
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOldPassword, setShowOldPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  /** 头像修改状态 */
  const [isChangingAvatar, setIsChangingAvatar] = useState(false);

  /** 处理密码修改 */
  const handleChangePassword = async () => {
    setPasswordError(null);

    if (!oldPassword) {
      setPasswordError('请输入旧密码');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('新密码至少需要 6 个字符');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }

    setIsSaving(true);
    try {
      if (userInfo) {
        await API.user.changePassword(userInfo.userId, oldPassword, newPassword);
        AppNotifier.success('密码已更新');
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      }
    } catch (err: any) {
      setPasswordError(err.message || '旧密码不正确');
    } finally {
      setIsSaving(false);
    }
  };

  /** 处理头像修改 */
  const handleChangeAvatar = async () => {
    setIsChangingAvatar(true);
    try {
      const filePath = await API.system.openFile({
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        properties: ['openFile'],
      });
      if (filePath && userInfo) {
        await API.user.updateProfile(userInfo.userId, { avatar: filePath });
        AppNotifier.success('头像已更新');
        // 刷新用户资料
        await useUserStore.getState().fetchProfile();
      }
    } catch (err: any) {
      AppNotifier.error(err.message || '头像更新失败');
    } finally {
      setIsChangingAvatar(false);
    }
  };

  return (
    <div className="h-screen w-screen bg-bg-deep text-foreground overflow-hidden flex flex-col">
      {/* 顶部导航栏 */}
      <div className="flex items-center gap-4 px-6 py-3 border-b border-border/30 bg-bg-deep/50 shrink-0">
        <button
          onClick={() => navigate('/')}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer outline-none"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-[15px] font-semibold">个人设置</h1>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* 左侧标签导航 */}
        <div className="w-[200px] flex flex-col gap-1 p-4 border-r border-border/30 shrink-0">
          <button
            onClick={() => setActiveTab('profile')}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all cursor-pointer outline-none text-left ${
              activeTab === 'profile'
                ? 'bg-accent/10 text-accent'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            <User size={16} />
            个人信息
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all cursor-pointer outline-none text-left ${
              activeTab === 'security'
                ? 'bg-accent/10 text-accent'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            <Lock size={16} />
            安全设置
          </button>
        </div>

        {/* 右侧内容区 */}
        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-[540px] mx-auto space-y-8">

            {/* 个人信息 */}
            {activeTab === 'profile' && (
              <div className="animate-fade-in">
                <h2 className="text-[15px] font-semibold mb-6">个人信息</h2>

                {/* 头像区域 */}
                <div className="glass-card-sm p-5 mb-6">
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-full bg-gradient-to-br from-accent/20 to-accent-purple/20 border-2 border-accent/20 flex items-center justify-center text-accent overflow-hidden shrink-0">
                      {userInfo?.avatar ? (
                        <img src={userInfo.avatar} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <User size={28} />
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <span className="text-[14px] font-semibold">{userInfo?.username || '未登录'}</span>
                      <button
                        onClick={handleChangeAvatar}
                        disabled={isChangingAvatar}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-[11px] text-muted-foreground hover:text-foreground hover:border-accent/40 transition-all cursor-pointer outline-none disabled:opacity-50"
                      >
                        <Image size={13} />
                        {isChangingAvatar ? '更改中...' : '更换头像'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* 用户信息展示 */}
                <div className="glass-card-sm p-5">
                  <div className="text-sm font-semibold mb-4">账户信息</div>
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] text-muted-foreground">用户名</span>
                      <span className="text-[12px] font-medium">{userInfo?.username || '-'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] text-muted-foreground">VIP 等级</span>
                      <span className={`text-[12px] font-medium ${
                        userInfo?.vipLevel === 'ultra' ? 'text-accent-purple' :
                        userInfo?.vipLevel === 'pro' ? 'text-accent' : 'text-muted-foreground'
                      }`}>
                        {userInfo?.vipLevel === 'ultra' ? '至尊版' :
                         userInfo?.vipLevel === 'pro' ? '专业版' : '免费版'}
                      </span>
                    </div>
                    {userInfo?.vipExpireAt && (
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] text-muted-foreground">VIP 到期</span>
                        <span className="text-[12px] font-medium">{new Date(userInfo.vipExpireAt).toLocaleDateString('zh-CN')}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 安全设置 */}
            {activeTab === 'security' && (
              <div className="animate-fade-in">
                <h2 className="text-[15px] font-semibold mb-6">安全设置</h2>

                <div className="glass-card-sm p-5">
                  <div className="text-sm font-semibold mb-1">修改密码</div>
                  <div className="text-[11px] text-muted-foreground mb-5">修改后需使用新密码重新登录</div>

                  <div className="flex flex-col gap-4">
                    {/* 旧密码 */}
                    <FormField label="旧密码" error={passwordError && !newPassword ? passwordError : null}>
                      <div className="relative">
                        <Input
                          type={showOldPassword ? 'text' : 'password'}
                          value={oldPassword}
                          onChange={(e) => { setOldPassword(e.target.value); setPasswordError(null); }}
                          placeholder="输入当前密码"
                          className="text-xs bg-bg-secondary h-9 pr-8 border-border/50"
                        />
                        <button
                          type="button"
                          onClick={() => setShowOldPassword(!showOldPassword)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground outline-none cursor-pointer"
                        >
                          {showOldPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </FormField>

                    {/* 新密码 */}
                    <FormField label="新密码">
                      <div className="relative">
                        <Input
                          type={showNewPassword ? 'text' : 'password'}
                          value={newPassword}
                          onChange={(e) => { setNewPassword(e.target.value); setPasswordError(null); }}
                          placeholder="输入新密码（至少6位）"
                          className="text-xs bg-bg-secondary h-9 pr-8 border-border/50"
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground outline-none cursor-pointer"
                        >
                          {showNewPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </FormField>

                    {/* 确认密码 */}
                    <FormField
                      label="确认新密码"
                      error={confirmPassword && newPassword !== confirmPassword ? '两次输入不一致' : null}
                    >
                      <div className="relative">
                        <Input
                          type={showConfirmPassword ? 'text' : 'password'}
                          value={confirmPassword}
                          onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError(null); }}
                          placeholder="再次输入新密码"
                          className="text-xs bg-bg-secondary h-9 pr-8 border-border/50"
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground outline-none cursor-pointer"
                        >
                          {showConfirmPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </FormField>

                    {passwordError && newPassword && (
                      <div className="text-[10px] text-accent-rose">{passwordError}</div>
                    )}

                    <Button
                      onClick={handleChangePassword}
                      disabled={isSaving}
                      className="h-9 text-xs mt-2 bg-accent hover:bg-accent/90"
                    >
                      <Save size={13} className="mr-1.5" />
                      {isSaving ? '保存中...' : '保存修改'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

UserSettings.displayName = 'UserSettings';

export default UserSettings;
