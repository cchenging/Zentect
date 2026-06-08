import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, X } from 'lucide-react';
import { API } from '../api';

/** P2: 首次启动引导 — 检测 API Key 配置，引导用户完成初始化 */
export function FirstLaunchWizard() {
  const [show, setShow] = useState<boolean | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        const deepseek = await API.system.getSetting('ai.deepseekKey', '');
        const qwen = await API.system.getSetting('ai.qwenKey', '');
        const doubao = await API.system.getSetting('ai.doubaoKey', '');
        const hasAnyKey = !!(deepseek || qwen || doubao);
        setShow(!hasAnyKey);
      } catch {
        setShow(false);
      }
    })();
  }, []);

  const goToSettings = () => {
    setShow(false);
    navigate('/settings');
  };

  if (show !== true) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-2xl max-w-md w-full p-8 shadow-2xl animate-in fade-in zoom-in-95 duration-300">
        <div className="flex justify-end -mt-2 -mr-2">
          <button onClick={() => setShow(false)} className="text-muted-foreground hover:text-foreground outline-none p-1">
            <X size={18} />
          </button>
        </div>

        <div className="text-center mb-6">
          <div className="text-5xl mb-4">🎬</div>
          <h2 className="text-lg font-semibold text-foreground mb-2">一分钟出片，AI 帮你做解说</h2>
          <p className="text-sm text-muted-foreground">拖入电影 → AI 自动分析 → 生成解说稿 → 导出剪映草稿</p>
        </div>

        <div className="bg-muted rounded-xl p-4 mb-6 text-left">
          <p className="text-sm font-medium text-foreground mb-3">开始前，请先配置：</p>
          <div className="space-y-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="text-amber-500">1️⃣</span>
              <span>API Key（用于 AI 解说稿生成）</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">2️⃣</span>
              <span>可选：语音克隆（个性化配音）</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={goToSettings}
            className="flex-1 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium
                       hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
          >
            <ExternalLink size={14} /> 去配置 Key
          </button>
          <button
            onClick={() => setShow(false)}
            className="flex-1 h-10 rounded-lg border border-border text-muted-foreground text-sm font-medium
                       hover:bg-muted transition-colors"
          >
            暂不配置，先看看
          </button>
        </div>
      </div>
    </div>
  );
}
