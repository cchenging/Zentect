/** V1.3 A3: ExportPanel 共用导出组件
 *  从 StepExport.tsx 抽取核心导出逻辑，供 QuickCard 步进和 Editor ExportModal 共用
 *  Props.container 决定是否为完整页面（page 自带标题+返回按钮，dialog 仅渲染选项区）
 */

import React, { useState, useCallback } from 'react';
import { Download, Loader2, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { useQuickCardStore } from '../../../store/useQuickCardStore';

export type ExportContainer = 'page' | 'dialog';

interface ExportPanelProps {
  projectId: string;
  container: ExportContainer;
}

interface ExportMethod {
  id: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
  ext: string;
}

/** 支持的导出方式 */
const EXPORT_METHODS: ExportMethod[] = [
  {
    id: 'jianying',
    label: '剪映草稿',
    desc: '生成剪映草稿文件，在剪映中二次编辑再导出',
    icon: '✂️',
    ext: '.draft',
  },
  {
    id: 'mp4',
    label: 'MP4 直出',
    desc: '直接渲染 MP4 视频文件，最快成品',
    icon: '🎬',
    ext: '.mp4',
  },
  {
    id: 'publish',
    label: '发布素材包',
    desc: '打包封面+解说稿+视频，用于分发到各短视频平台',
    icon: '📦',
    ext: '.zip',
  },
  {
    id: 'batch',
    label: '批量队列',
    desc: '加入后台队列批量导出，不阻塞当前操作',
    icon: '📋',
    ext: '',
  },
];

type ExportStatus = 'idle' | 'exporting' | 'done' | 'error';

export const ExportPanel: React.FC<ExportPanelProps> = ({ projectId, container }) => {
  const publishConfig = useQuickCardStore(s => s.publishConfig);
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null);
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [outputPath, setOutputPath] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  /** 开始导出 */
  const handleExport = useCallback(async () => {
    if (!selectedMethod || !projectId) return;
    setStatus('exporting');
    setProgress(0);
    setErrorMsg(null);

    try {
      const method = EXPORT_METHODS.find(m => m.id === selectedMethod);
      if (!method) throw new Error('未知导出方式');

      const result: any = await (window as any).api?.invoke?.('engine:export', {
        type: selectedMethod,
        publishConfig:
          selectedMethod === 'publish' ? (publishConfig as any) : undefined,
      });

      if (result?.success) {
        setStatus('done');
        setOutputPath(result.outputPath || '');
        setProgress(100);
      } else {
        setStatus('error');
        setErrorMsg(result?.error || '导出失败');
      }
    } catch (err: any) {
      setStatus('error');
      setErrorMsg(err.message || '连接导出引擎失败');
    }
  }, [selectedMethod, projectId, publishConfig]);

  /** 打开输出目录 */
  const handleOpenFolder = () => {
    if (outputPath) {
      (window as any).api?.shell?.openPath?.(outputPath);
    }
  };

  /** 重试 */
  const handleRetry = () => {
    setStatus('idle');
    setProgress(0);
    setErrorMsg(null);
    setOutputPath('');
  };

  const isPage = container === 'page';

  return (
    <div className={isPage ? 'flex-1 flex flex-col gap-6 max-w-2xl mx-auto px-6 py-8' : 'flex flex-col gap-4'}>
      {/* 标题区域（page 模式） */}
      {isPage && (
        <div className="text-center space-y-1">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-2">
            <Download size={24} className="text-primary" />
          </div>
          <h2 className="text-xl font-semibold">导出成品</h2>
          <p className="text-sm text-muted-foreground">选择导出方式，生成最终视频文件</p>
        </div>
      )}

      {/* 导出方式选择 */}
      {status === 'idle' && (
        <div className="space-y-3">
          {EXPORT_METHODS.map(method => (
            <button
              key={method.id}
              onClick={() => setSelectedMethod(method.id)}
              className={`w-full flex items-start gap-4 p-4 rounded-xl border text-left transition-all ${
                selectedMethod === method.id
                  ? 'border-primary bg-primary/5 shadow-sm'
                  : 'border-border hover:border-border/80 hover:bg-card/50'
              }`}
            >
              <span className="text-2xl shrink-0 mt-0.5">{method.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{method.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{method.desc}</p>
              </div>
              <div className={`w-5 h-5 rounded-full border-2 shrink-0 mt-0.5 flex items-center justify-center transition-all ${
                selectedMethod === method.id ? 'border-primary bg-primary' : 'border-border'
              }`}>
                {selectedMethod === method.id && <div className="w-2 h-2 rounded-full bg-primary-foreground" />}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 进度条 */}
      {status === 'exporting' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-4 rounded-xl bg-card border border-border">
            <Loader2 size={24} className="text-primary animate-spin shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">正在导出...</p>
              <div className="w-full bg-muted rounded-full h-2 mt-2 overflow-hidden">
                <div
                  className="bg-primary h-full rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            <span className="text-sm font-mono text-muted-foreground">{progress}%</span>
          </div>
        </div>
      )}

      {/* 成功 */}
      {status === 'done' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-4 rounded-xl bg-success/10 border border-success/30">
            <CheckCircle2 size={24} className="text-success shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-success">导出成功！</p>
              {outputPath && (
                <p className="text-xs text-muted-foreground mt-1 truncate">{outputPath}</p>
              )}
            </div>
          </div>
          {outputPath && (
            <Button variant="outline" onClick={handleOpenFolder} className="gap-2 w-full">
              <ExternalLink size={16} /> 打开文件所在位置
            </Button>
          )}
        </div>
      )}

      {/* 错误 */}
      {status === 'error' && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-4 rounded-xl bg-error/10 border border-error/30">
            <AlertCircle size={24} className="text-error shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-error">导出失败</p>
              {errorMsg && (
                <p className="text-xs text-muted-foreground mt-1">{errorMsg}</p>
              )}
            </div>
          </div>
          <Button variant="outline" onClick={handleRetry} className="gap-2 w-full">
            重新选择导出方式
          </Button>
        </div>
      )}

      {/* 底部操作按钮 */}
      {status === 'idle' && selectedMethod && (
        <Button onClick={handleExport} size="lg" className="gap-2">
          <Download size={16} /> 开始导出
        </Button>
      )}

      {/* 发布素材打包确认区（仅 publish 方式且有 publishConfig 时显示） */}
      {selectedMethod === 'publish' && status === 'idle' && publishConfig.title && (
        <div className="p-3 rounded-lg bg-card border border-border space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            发布素材确认
          </p>
          <div className="flex items-center gap-3">
            {publishConfig.coverUrl && (
              <div className="w-16 h-9 rounded overflow-hidden bg-muted shrink-0">
                <img src={publishConfig.coverUrl} alt="" className="w-full h-full object-cover" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm truncate">{publishConfig.title}</p>
              <p className="text-xs text-muted-foreground truncate">{publishConfig.description}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};