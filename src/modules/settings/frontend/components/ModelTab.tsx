// 📁 路径: src/modules/settings/frontend/components/ModelTab.tsx
// 本地模型管理 Tab - V3 原型对齐（表格布局）
import React, { useState, useEffect } from 'react';
import { Download, Trash2, Loader2, RefreshCw, Pause, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { API } from '@renderer/api';

/** 模型状态类型 */
type ModelStatus = 'missing' | 'downloading' | 'ready' | 'updating' | 'error';

/** 模型定义 - V3 原型7个模型，pythonPkg 映射到 Python 依赖包名（用于依赖检查） */
interface ModelItem {
  id: string;
  label: string;
  size: string;
  description: string;
  status: ModelStatus;
  progress: number;
  version: string;
  /** 对应的 Python 包名（用于 checkDeps 依赖检查，无则不检查） */
  pythonPkg?: string;
}

/** V3 原型本地模型列表 */
const DEFAULT_MODELS: Omit<ModelItem, 'status' | 'progress'>[] = [
  { id: 'moss_tts', label: 'moss-tts-nano', size: '~50MB', description: 'TTS 语音合成', version: '1.0' },
  { id: 'whisper', label: 'Whisper.cpp', size: '~150MB', description: '语音识别 ASR', version: '1.0' },
  { id: 'sensevoice', label: 'SenseVoiceSmall', size: '~80MB', description: '语音识别增强', version: '1.0', pythonPkg: 'funasr' },
  { id: 'mdx_net', label: '音频分离模型', size: '~100MB', description: '人声与BGM分离', version: '1.0', pythonPkg: 'demucs' },
  { id: 'insightface', label: '人脸识别模型', size: '~30MB', description: '人物面部检测', version: '1.0', pythonPkg: 'insightface' },
  { id: 'emotion', label: '情绪分析模型', size: '~20MB', description: '文本+音频情绪', version: '1.0' },
  { id: 'sovits', label: 'GPT-SoVITS', size: '~200MB', description: 'TTS 增强', version: '1.0' },
];

/** Python 依赖检查结果：{ 包名: { installed, version, display_name } } */
type DepsInfo = Record<string, { installed: boolean; version: string | null; display_name: string }>;

/**
 * 本地模型管理 Tab
 * V3 原型对齐：表格布局 + 批量操作 + 下载/暂停/卸载 + Python 依赖检查
 */
export const ModelTab: React.FC = () => {
  const [models, setModels] = useState<ModelItem[]>(
    DEFAULT_MODELS.map(m => ({ ...m, status: 'missing' as ModelStatus, progress: 0 }))
  );
  /** Python 依赖检查结果，null 表示服务离线或未检查 */
  const [deps, setDeps] = useState<DepsInfo | null>(null);
  /** Python 解释器路径（用于提示用户安装命令） */
  const [pythonExe, setPythonExe] = useState<string>('');
  /** 依赖检查加载中 */
  const [depsLoading, setDepsLoading] = useState(false);

  /** 从后端加载模型状态 + Python 依赖检查 */
  useEffect(() => {
    loadModelStatus();
    loadDeps();
    API.model.onDownloadProgress((payload) => {
      setModels(prev => prev.map(m =>
        m.id === payload.modelId
          ? { ...m, progress: payload.progress, status: payload.progress >= 100 ? 'ready' : 'downloading' }
          : m
      ));
    });
    return () => { API.model.offDownloadProgress(); };
  }, []);

  /** 加载模型状态 */
  const loadModelStatus = async () => {
    try {
      const list = await API.model.getList();
      if (Array.isArray(list) && list.length > 0) {
        setModels(prev => prev.map(m => {
          const serverModel = list.find((s: any) => s.model_id === m.id || s.id === m.id);
          if (serverModel) {
            return { ...m, status: serverModel.status === 'ready' || serverModel.is_installed ? 'ready' : m.status, version: serverModel.version || m.version };
          }
          return m;
        }));
      }
    } catch {}
  };

  /** 加载 Python 依赖状态（调用 ai_daemon /api/check_deps） */
  const loadDeps = async () => {
    setDepsLoading(true);
    try {
      const res = await API.ai.checkDeps();
      if (res) {
        setDeps(res.deps);
        setPythonExe(res.python_executable);
      } else {
        setDeps(null);
      }
    } catch {
      setDeps(null);
    } finally {
      setDepsLoading(false);
    }
  };

  /** 下载模型 */
  const handleDownload = async (modelId: string) => {
    setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'downloading', progress: 0 } : m));
    try {
      await API.model.download(modelId);
      setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'ready', progress: 100 } : m));
    } catch { setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'error' } : m)); }
  };

  /** 卸载模型 */
  const handleUninstall = async (modelId: string) => {
    if (!window.confirm('确定要卸载此模型吗？')) return;
    try { await API.model.uninstall(modelId); setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'missing', progress: 0 } : m)); } catch {}
  };

  /** 全部下载 */
  const handleDownloadAll = async () => {
    const missing = models.filter(m => m.status === 'missing');
    for (const m of missing) { await handleDownload(m.id); }
  };

  /** 全部更新 */
  const handleUpdateAll = async () => {
    const ready = models.filter(m => m.status === 'ready');
    const ids = ready.map(m => m.id);
    try { await API.model.batchUpdate(ids); } catch {}
  };

  /** 获取状态图标 */
  const getStatusIcon = (status: ModelStatus) => {
    switch (status) {
      case 'ready': return <div className="w-6 h-6 rounded-full bg-accent-green/20 flex items-center justify-center text-accent-green text-[11px]">&#x2713;</div>;
      case 'downloading': case 'updating': return <Loader2 size={16} className="text-accent animate-spin" />;
      case 'error': return <div className="w-6 h-6 rounded-full bg-accent-rose/20 flex items-center justify-center text-accent-rose text-[11px]">&#x2715;</div>;
      default: return <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center" />;
    }
  };

  /** 获取模型对应的 Python 依赖状态徽章 */
  const getDepBadge = (model: ModelItem) => {
    if (!model.pythonPkg) return null;
    if (depsLoading) return <span className="text-[10px] text-muted-foreground/60">检查中…</span>;
    if (!deps) return <span className="text-[10px] text-muted-foreground/60">Python 服务离线</span>;
    const dep = deps[model.pythonPkg];
    if (!dep) return null;
    return dep.installed
      ? <span className="inline-flex items-center gap-1 text-[10px] text-accent-green"><CheckCircle2 size={11} />{dep.version && dep.version !== 'unknown' ? `v${dep.version}` : '已安装'}</span>
      : <span className="inline-flex items-center gap-1 text-[10px] text-accent-rose"><XCircle size={11} />未安装</span>;
  };

  const readyCount = models.filter(m => m.status === 'ready').length;
  const totalSize = '~630MB';
  /** 统计 Python 依赖安装情况 */
  const depModels = models.filter(m => m.pythonPkg);
  const depsInstalledCount = depModels.filter(m => deps?.[m.pythonPkg!]?.installed).length;
  const depsAllInstalled = deps && depModels.length > 0 && depsInstalledCount === depModels.length;

  return (
    <div className="space-y-4 animate-fade-in" style={{ maxWidth: '996px' }}>
      {/* 标题与操作 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">本地模型</div>
          <div className="text-[11px] text-muted-foreground">管理 AI 模型文件</div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleDownloadAll} className="h-8 px-3 text-xs gap-1.5 border-accent/30 text-accent hover:bg-accent/10">
            <Download size={13} /> 全部下载
          </Button>
          <Button variant="outline" onClick={handleUpdateAll} className="h-8 px-3 text-xs gap-1.5 border-border/50 hover:border-accent-cyan/40 hover:text-accent-cyan">
            <RefreshCw size={13} /> 全部更新
          </Button>
        </div>
      </div>

      {/* Python 依赖状态卡片 */}
      <div className="glass-card-sm p-3.5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <AlertCircle size={14} className={depsAllInstalled ? 'text-accent-green' : 'text-accent-amber'} />
            <span className="text-[12px] font-medium">Python 运行环境</span>
          </div>
          <Button variant="ghost" size="sm" onClick={loadDeps} className="h-6 text-[10px] gap-1 px-2 text-muted-foreground">
            <RefreshCw size={11} className={depsLoading ? 'animate-spin' : ''} /> 刷新
          </Button>
        </div>
        {pythonExe ? (
          <div className="text-[10px] text-muted-foreground/80 mb-2 font-mono truncate" title={pythonExe}>
            解释器：{pythonExe}
          </div>
        ) : null}
        {deps ? (
          <div className="space-y-1.5">
            <div className="text-[11px] text-muted-foreground">
              关键依赖：<span className={depsAllInstalled ? 'text-accent-green' : 'text-accent-amber'}>{depsInstalledCount}/{depModels.length}</span> 已安装
            </div>
            {!depsAllInstalled && (
              <div className="text-[10px] text-muted-foreground/70 bg-muted/30 rounded px-2 py-1.5 font-mono break-all">
                {pythonExe ? `"${pythonExe}" -m pip install -r requirements.txt` : 'pip install -r requirements.txt'}
              </div>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground/70">
            {depsLoading ? '检查中…' : 'Python 服务未启动，无法检查依赖'}
          </div>
        )}
      </div>

      {/* 模型表格 */}
      <div className="glass-card-sm overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border/30">
              <th className="text-left text-[11px] text-muted-foreground font-medium px-4 py-2.5">状态</th>
              <th className="text-left text-[11px] text-muted-foreground font-medium px-4 py-2.5">模型</th>
              <th className="text-left text-[11px] text-muted-foreground font-medium px-4 py-2.5">用途</th>
              <th className="text-left text-[11px] text-muted-foreground font-medium px-4 py-2.5">大小</th>
              <th className="text-right text-[11px] text-muted-foreground font-medium px-4 py-2.5">操作</th>
            </tr>
          </thead>
          <tbody>
            {models.map(model => (
              <tr key={model.id} className="border-b border-border/15 hover:bg-white/[0.02] transition-colors">
                <td className="px-4 py-3">{getStatusIcon(model.status)}</td>
                <td className="px-4 py-3">
                  <div className="text-[13px] font-medium text-foreground">{model.label}</div>
                  {model.status === 'downloading' && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden max-w-[120px]">
                        <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${model.progress}%` }} />
                      </div>
                      <span className="text-[10px] text-accent">{model.progress}%</span>
                    </div>
                  )}
                  {/* Python 依赖状态徽章 */}
                  {getDepBadge(model) && (
                    <div className="mt-1">{getDepBadge(model)}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-[12px] text-muted-foreground">{model.description}</td>
                <td className="px-4 py-3 text-[12px] text-muted-foreground">{model.size}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    {model.status === 'missing' && (
                      <Button variant="outline" size="sm" onClick={() => handleDownload(model.id)} className="h-7 text-[11px] gap-1 border-accent/30 text-accent hover:bg-accent/10 px-2.5">
                        <Download size={12} /> 下载
                      </Button>
                    )}
                    {model.status === 'downloading' && (
                      <Button variant="ghost" size="sm" className="h-7 text-[11px] gap-1 text-muted-foreground px-2.5">
                        <Pause size={12} /> 暂停
                      </Button>
                    )}
                    {model.status === 'ready' && (
                      <Button variant="ghost" size="sm" onClick={() => handleUninstall(model.id)} className="h-7 text-[11px] gap-1 text-muted-foreground hover:text-accent-rose px-2.5">
                        <Trash2 size={12} /> 卸载
                      </Button>
                    )}
                    {model.status === 'error' && (
                      <Button variant="outline" size="sm" onClick={() => handleDownload(model.id)} className="h-7 text-[11px] gap-1 border-accent-rose/30 text-accent-rose hover:bg-accent-rose/10 px-2.5">
                        <Download size={12} /> 重试
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 磁盘统计 */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-2 border-t border-border/30">
        <span>已用空间：{readyCount > 0 ? `~${readyCount * 80}MB` : '0MB'} / 总共 {totalSize}</span>
      </div>
    </div>
  );
};
