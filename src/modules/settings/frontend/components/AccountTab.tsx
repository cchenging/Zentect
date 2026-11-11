// 📁 路径：src/modules/settings/frontend/components/AccountTab.tsx
// 账户设置：由原「个人设置」页合并而来（个人信息 + 安全设置）
import React, { useState } from 'react';
import { User, Image, Save, Eye, EyeOff } from 'lucide-react';
import { Input } from '@renderer/components/ui/input';
import { Button } from '@renderer/components/ui/button';
import { useUserStore } from '@renderer/store/useUserStore';
import { AppNotifier } from '@renderer/core/AppNotifier';
import { FormField } from '@renderer/components/ui/form-field';
import { API } from '@renderer/api';

export const AccountTab: React.FC = () => {
  const { userInfo } = useUserStore();

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
        await useUserStore.getState().fetchProfile();
      }
    } catch (err: any) {
      AppNotifier.error(err.message || '头像更新失败');
    } finally {
      setIsChangingAvatar(false);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-8 items-start animate-fade-in">
      {/* 个人信息 */}
      <section>
        <h2 className="text-[15px] font-semibold mb-5">个人信息</h2>

        <div className="glass-card-sm p-5">
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-[12px] text-muted-foreground hover:text-foreground hover:border-accent/40 transition-all cursor-pointer outline-none disabled:opacity-50"
              >
                <Image size={13} />
                {isChangingAvatar ? '更改中...' : '更换头像'}
              </button>
            </div>
          </div>
        </div>

        <div className="glass-card-sm p-5 mt-4">
          <div className="text-sm font-semibold mb-4">账户信息</div>
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted-foreground">用户名</span>
              <span className="text-[13px] font-medium">{userInfo?.username || '-'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted-foreground">VIP 等级</span>
              <span className={`text-[13px] font-medium ${
                userInfo?.vipLevel === 'ultra' ? 'text-accent-purple' :
                userInfo?.vipLevel === 'pro' ? 'text-accent' : 'text-muted-foreground'
              }`}>
                {userInfo?.vipLevel === 'ultra' ? '至尊版' :
                 userInfo?.vipLevel === 'pro' ? '专业版' : '免费版'}
              </span>
            </div>
            {userInfo?.vipExpireAt && (
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-muted-foreground">VIP 到期</span>
                <span className="text-[13px] font-medium">{new Date(userInfo.vipExpireAt).toLocaleDateString('zh-CN')}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 安全设置 */}
      <section>
        <h2 className="text-[15px] font-semibold mb-5">安全设置</h2>

        <div className="glass-card-sm p-5">
          <div className="text-sm font-semibold mb-1">修改密码</div>
          <div className="text-[12px] text-muted-foreground mb-5">修改后需使用新密码重新登录</div>

          <div className="flex flex-col gap-4">
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
              <div className="text-[12px] text-accent-rose">{passwordError}</div>
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
      </section>
    </div>
  );
};

AccountTab.displayName = 'AccountTab';
