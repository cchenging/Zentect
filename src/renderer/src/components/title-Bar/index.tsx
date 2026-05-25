import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Sun, Moon, Bell, Settings as SettingsIcon } from 'lucide-react';
import { useEditorStore } from '../../store/useStore';
import { UI_CONFIG } from '../../constants/ui';
import { useI18n } from '../../store/useI18n';
import { AppNotifier } from '../../core/AppNotifier';
import { WindowControls } from '../window-controls';

/**
 * 首页标题栏
 * 砍掉冗余窗口控制代码，引入 WindowControls 原子组件
 * 使用 Tailwind 任意值替换 style as any，保持类型安全
 */
export const TitleBar: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();

  const theme = useEditorStore((state) => state.theme);
  const toggleTheme = useEditorStore((state) => state.toggleTheme);

  return (
    /* 💥 使用 Tailwind 任意值替换 style as any，重塑纯净的类型安全体系 */
    <div className={`${UI_CONFIG.TOPBAR_HEIGHT_CLASS} w-full shrink-0 bg-background border-b border-border flex items-center justify-end select-none pr-1 [-webkit-app-region:drag]`}>

      <div className="flex h-full items-center gap-0.5 [-webkit-app-region:no-drag]">

        <div className="flex items-center gap-0.5">
          <button
            className={`${UI_CONFIG.ICON_BTN_SIZE} flex items-center justify-center bg-transparent border-none rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer outline-none`}
            onClick={toggleTheme}
            title={theme === 'dark' ? t.common?.theme_light || '亮色模式' : t.common?.theme_dark || '暗黑模式'}
          >
            {theme === 'dark' ? <Sun size={UI_CONFIG.ICON_SIZE} /> : <Moon size={UI_CONFIG.ICON_SIZE} />}
          </button>

          <button
            className={`${UI_CONFIG.ICON_BTN_SIZE} flex items-center justify-center bg-transparent border-none rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer outline-none relative`}
            onClick={() => AppNotifier.info('通知功能开发中')}
            aria-label="通知"
            title={t.common?.notifications || '通知'}
          >
            <Bell size={UI_CONFIG.ICON_SIZE} />
            <span className="absolute top-[5px] right-[5px] w-1.5 h-1.5 bg-red-500 rounded-full border border-background"></span>
          </button>

          <button
            className={`${UI_CONFIG.ICON_BTN_SIZE} flex items-center justify-center bg-transparent border-none rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer outline-none`}
            onClick={() => navigate('/settings')}
            title={t.nav?.settings || '设置'}
          >
            <SettingsIcon size={UI_CONFIG.ICON_SIZE} />
          </button>
        </div>

        <div className="w-[1px] h-3 bg-border mx-1" />

        {/* 💥 接入原子化组件，释放视图层负担 */}
        <WindowControls />

      </div>
    </div>
  );
};
