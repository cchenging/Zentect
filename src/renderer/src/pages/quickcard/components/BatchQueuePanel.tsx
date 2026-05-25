// 📁 新建文件: src/renderer/src/pages/quickcard/components/BatchQueuePanel.tsx
// V1.2: 队列管理台 — 实时进度监控、暂停/重试/重排、批量结果汇总

import React, { useState, useEffect, useCallback } from 'react';
import {
  Play, Pause, RotateCcw, Trash2, GripVertical,
  CheckCircle2, XCircle, Clock, Loader2, Layers,
  ArrowUpDown, AlertTriangle
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { API } from '../../../api';

/** 队列状态（与后端 QueueStatus 对齐） */
interface QueueStatus {
  isRunning: boolean;
  totalJobs: number;
  pendingJobs: number;
  completedJobs: number;
  failedJobs: number;
  currentJob: BatchJob | null;
  jobs: BatchJob[];
}

/** 批量作业 */
interface BatchJob {
  id: string;
  projectId: string;
  projectName: string;
  mediaPath: string;
  shots: any[];
  workflowId?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  createdAt: string;
  queuePosition: number;
}

/** 状态标签配置 */
const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  pending:    { icon: <Clock size={14} />,         color: 'text-muted-foreground', label: '等待' },
  processing: { icon: <Loader2 size={14} className="animate-spin" />, color: 'text-blue-500', label: '处理中' },
  completed:  { icon: <CheckCircle2 size={14} />,  color: 'text-success',          label: '完成' },
  failed:     { icon: <XCircle size={14} />,        color: 'text-error',            label: '失败' },
};

interface BatchQueuePanelProps {
  /** 关闭面板回调 */
  onClose?: () => void;
}

export const BatchQueuePanel: React.FC<BatchQueuePanelProps> = ({ onClose }) => {
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 加载队列状态 */
  const fetchStatus = useCallback(async () => {
    try {
      const data: any = await API.queue.status();
      setStatus(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || '加载队列状态失败');
    } finally {
      setLoading(false);
    }
  }, []);

  /** 订阅实时进度 */
  useEffect(() => {
    fetchStatus();
    API.events.onBatchProgress((data: any) => {
      setStatus(data);
    });
    return () => API.events.offBatchProgress();
  }, [fetchStatus]);

  /** 队列控制 */
  const handleStart = async () => { await API.queue.start(); fetchStatus(); };
  const handlePause = async () => { await API.queue.pause(); fetchStatus(); };
  const handleRetry = async (jobId: string) => { await API.queue.retry(jobId); fetchStatus(); };
  const handleRemove = async (jobId: string) => { await API.queue.remove(jobId); fetchStatus(); };

  /** 统计卡片 */
  const renderStats = () => {
    if (!status) return null;
    const items = [
      { label: '总计', value: status.totalJobs, color: 'text-foreground' },
      { label: '等待', value: status.pendingJobs, color: 'text-muted-foreground' },
      { label: '完成', value: status.completedJobs, color: 'text-success' },
      { label: '失败', value: status.failedJobs, color: 'text-error' },
    ];
    return (
      <div className="grid grid-cols-4 gap-3">
        {items.map(item => (
          <div key={item.label} className="flex flex-col items-center p-3 rounded-xl bg-muted/30 border border-border/50">
            <span className={`text-2xl font-bold ${item.color}`}>{item.value}</span>
            <span className="text-xs text-muted-foreground mt-0.5">{item.label}</span>
          </div>
        ))}
      </div>
    );
  };

  /** 当前任务进度（动态控制台） */
  const renderCurrentJob = () => {
    if (!status?.currentJob) return null;
    const job = status.currentJob;
    const cfg = STATUS_CONFIG[job.status];
    return (
      <div className="w-full p-4 rounded-xl border border-border bg-card space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`${cfg.color}`}>{cfg.icon}</span>
            <span className="text-sm font-medium">{job.projectName}</span>
            <span className={`text-xs ${cfg.color}`}>{cfg.label}</span>
          </div>
          <span className="text-xs text-muted-foreground">{Math.round(job.progress)}%</span>
        </div>
        {/* 进度条 */}
        <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${job.status === 'failed' ? 'bg-error' : job.status === 'completed' ? 'bg-success' : 'bg-primary'}`}
            style={{ width: `${Math.max(job.progress, 2)}%` }}
          />
        </div>
        {/* 当前步骤 */}
        {job.message && (
          <p className="text-xs text-muted-foreground">{job.message}</p>
        )}
      </div>
    );
  };

  /** 作业列表 */
  const renderJobList = () => {
    if (!status?.jobs || status.jobs.length === 0) {
      return (
        <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
          <Layers size={32} className="opacity-30" />
          <p className="text-sm">队列为空</p>
          <p className="text-xs">完成一部电影的分析后，在导出页面提交到后台队列</p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {status.jobs.map(job => {
          const cfg = STATUS_CONFIG[job.status];
          return (
            <div key={job.id}
              className={`flex items-center gap-3 p-3 rounded-lg border transition-all
                ${job.status === 'processing' ? 'border-blue-500/30 bg-blue-500/5' :
                  job.status === 'failed' ? 'border-error/20 bg-error/5' :
                  'border-border/50 bg-card hover:bg-accent/30'}`}
            >
              {/* 拖拽手柄（重排占位） */}
              <GripVertical size={14} className="text-muted-foreground/30 shrink-0" />

              {/* 状态图标 */}
              <span className={cfg.color}>{cfg.icon}</span>

              {/* 任务信息 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{job.projectName}</span>
                  <span className={`text-xs ${cfg.color} shrink-0`}>{cfg.label}</span>
                </div>
                {(job.status === 'processing' || job.status === 'failed') && job.message && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{job.message}</p>
                )}
                {/* 迷你进度条（仅处理中显示） */}
                {job.status === 'processing' && (
                  <div className="w-full bg-muted rounded-full h-1 mt-1 overflow-hidden">
                    <div className="bg-primary h-full rounded-full transition-all" style={{ width: `${Math.max(job.progress, 2)}%` }} />
                  </div>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex items-center gap-1 shrink-0">
                {job.status === 'failed' && (
                  <button onClick={() => handleRetry(job.id)} title="重试"
                    className="p-1.5 rounded-md hover:bg-amber-500/10 hover:text-amber-500 transition-colors cursor-pointer">
                    <RotateCcw size={14} />
                  </button>
                )}
                {(job.status === 'pending' || job.status === 'failed') && (
                  <button onClick={() => handleRemove(job.id)} title="移除"
                    className="p-1.5 rounded-md hover:bg-error/10 hover:text-error transition-colors cursor-pointer">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // ==== 主渲染 ====

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <AlertTriangle size={32} className="text-error/60" />
        <p className="text-sm text-error">{error}</p>
        <Button variant="outline" size="sm" onClick={fetchStatus}>重试</Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto space-y-6">
      {/* 头部：标题 + 全局控制 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Layers size={20} className="text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold">批量队列管理台</h2>
            <p className="text-xs text-muted-foreground">
              {status?.isRunning ? '▶ 运行中 — 关闭窗口不影响后台执行' : '⏸ 已停止'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status?.isRunning ? (
            <Button variant="outline" size="sm" className="gap-1.5 h-8" onClick={handlePause}>
              <Pause size={14} /> 暂停
            </Button>
          ) : (
            <Button size="sm" className="gap-1.5 h-8" onClick={handleStart}
              disabled={!status || status.pendingJobs === 0}>
              <Play size={14} /> 启动
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={fetchStatus}>
            <ArrowUpDown size={14} /> 刷新
          </Button>
          {onClose && (
            <Button variant="ghost" size="sm" className="h-8" onClick={onClose}>关闭</Button>
          )}
        </div>
      </div>

      {/* 统计卡片 */}
      {renderStats()}

      {/* 当前任务进度（动态控制台） */}
      {renderCurrentJob()}

      {/* 作业列表 */}
      <div>
        <h3 className="text-sm font-medium mb-3">待执行队列</h3>
        {renderJobList()}
      </div>
    </div>
  );
};
