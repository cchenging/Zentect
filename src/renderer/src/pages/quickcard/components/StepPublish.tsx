/** V1.3 B4: StepPublish 发布素材设计页
 *  中栏显示封面大预览 + 比例切换 + 底部导航按钮
 *  右栏（PublishEditor）通过 Zustand store 同步编辑数据
 */

import React, { useEffect, useState, useMemo } from 'react';
import { Image, CheckCircle2, ArrowRight, Edit3 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { useQuickCardStore } from '../../../store/useQuickCardStore';
import { createDefaultPublishConfig } from '../../../../../shared/types/publish';

interface StepPublishProps {
  projectId: string;
  onComplete: () => void;
  onOpenRightPanel?: () => void;
}

const ASPECT_RATIOS = [
  { label: '16:9', value: '16:9', className: 'w-10 h-6' },
  { label: '9:16', value: '9:16', className: 'w-6 h-10' },
  { label: '1:1', value: '1:1', className: 'w-8 h-8' },
] as const;

export const StepPublish: React.FC<StepPublishProps> = ({
  projectId,
  onComplete,
  onOpenRightPanel,
}) => {
  const publishConfig = useQuickCardStore(s => s.publishConfig);
  const setPublishConfig = useQuickCardStore(s => s.setPublishConfig);
  const [selectedRatio, setSelectedRatio] = useState('16:9');

  /** 组件挂载时初始化 publishConfig（从 AI 分析结果自动填充） */
  useEffect(() => {
    if (!publishConfig.title) {
      const loadDefaults = async () => {
        try {
          const winApi = (window as any).api;
          const data = winApi
            ? await winApi.invoke?.('project:loadData', projectId)
            : null;
          if (data) {
            const shots = data.shots || [];
            const script = data.script || '';
            const coverPath = shots[0]?.thumbnail || shots[0]?.coverPath || '';
            const defaults = createDefaultPublishConfig({
              title: script.slice(0, 80) || '我的 AI 解说视频',
              description: script.slice(0, 200) || '',
              tags: ['#解说', '#AI'],
              coverUrl: coverPath,
              coverSource: coverPath ? 'custom' : 'first_frame',
            });
            setPublishConfig(defaults);
          }
        } catch {
          setPublishConfig(createDefaultPublishConfig());
        }
      };
      loadDefaults();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 封面无图时的占位背景 */
  const coverDisplay = publishConfig.coverUrl || '';

  /** 预览比例样式 */
  const previewStyle = useMemo(() => {
    switch (selectedRatio) {
      case '9:16': return { aspectRatio: '9/16', maxHeight: '480px' };
      case '1:1': return { aspectRatio: '1/1', maxHeight: '400px' };
      default: return { aspectRatio: '16/9', maxHeight: '400px' };
    }
  }, [selectedRatio]);

  return (
    <div className="flex-1 flex flex-col items-center gap-6 max-w-3xl mx-auto px-6 py-8">
      {/* 头部 */}
      <div className="text-center space-y-1">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-2">
          <Image size={24} className="text-primary" />
        </div>
        <h2 className="text-xl font-semibold">发布素材设计</h2>
        <p className="text-sm text-muted-foreground">设置视频封面、标题和描述，准备发布</p>
      </div>

      {/* 比例选择器 */}
      <div className="flex gap-1 p-1 rounded-lg bg-card border border-border">
        {ASPECT_RATIOS.map(r => (
          <button
            key={r.value}
            onClick={() => setSelectedRatio(r.value)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              selectedRatio === r.value
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* 封面大预览 */}
      <div
        className="w-full rounded-xl bg-card border border-border overflow-hidden flex items-center justify-center relative group"
        style={previewStyle}
      >
        {coverDisplay ? (
          <img
            src={coverDisplay}
            alt="封面预览"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground/40">
            <Image size={48} className="opacity-30" />
            <p className="text-sm">视频首帧将作为封面</p>
            <p className="text-xs">点击右下角编辑面板上传自定义封面</p>
          </div>
        )}

        {/* 标题覆盖层 */}
        {publishConfig.title && (
          <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/70 to-transparent">
            <p className="text-white font-semibold text-lg leading-tight">
              {publishConfig.title}
            </p>
          </div>
        )}
      </div>

      {/* 底部操作按钮 */}
      <div className="flex items-center gap-3 mt-2">
        {onOpenRightPanel && (
          <Button variant="outline" onClick={onOpenRightPanel} className="gap-2">
            <Edit3 size={16} /> 编辑素材
          </Button>
        )}
        <Button onClick={onComplete} size="lg" className="gap-2">
          <CheckCircle2 size={16} /> 去导出
          <ArrowRight size={16} />
        </Button>
      </div>
    </div>
  );
};