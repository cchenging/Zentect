// 📁 路径: src/modules/settings/frontend/components/HealthPage.tsx
// 系统健康检查 Tab - V5 极简用户版
// 🔧 V5 重构（用户决策）：
//   1. 极简用户版：只保留 6 项核心检查（数据库/FFmpeg/磁盘/CPU/内存/云端API）
//   2. 删除 Python 运行时依赖区（去模型管理页查看）
//   3. 删除本地模型检查项（去模型管理页查看）
//   4. 删除硬件 3 卡（CPU/内存/磁盘大数值卡片）— 开发信息，用户不关心
//   5. 删除数据库详情 Modal — 主行直接显示 "SQLite v3.45.0 · 已连接"
//   6. 修复伪硬编码：存储路径真实检测可写性，本地模型/云端API 不再硬编码
//   7. 修复重新检查无反馈：加载态覆盖 + 按钮 spinner
//   8. 字体规范 12px 起步：辅助 12px / 正文 13-14px / 标题 15-16px
import React, { useEffect, useState } from 'react';
import {
  CheckCircle2, XCircle, AlertTriangle, Loader2, RefreshCw,
} from 'lucide-react';
import { API } from '@renderer/api';

/** 健康检查项状态 */
type HealthStatus = 'ok' | 'warn' | 'error';

/** 健康检查项 */
interface HealthCheckItem {
  key: string;
  label: string;
  status: HealthStatus;
  detail: string;
}

/**
 * 系统健康检查 Tab - V5 极简用户版
 * 只保留用户关心的 6 项核心检查，每项只显状态 + 一句话
 */
export const HealthPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [checks, setChecks] = useState<HealthCheckItem[]>([]);
  const [error, setError] = useState('');

  /** 执行健康检查
   *  V5 修复：每次都显示加载态（不依赖 checks.length），让用户看到刷新反馈
   */
  const fetchHealth = async () => {
    setLoading(true);
    setError('');
    try {
      const health = await API.system.health();

      /** 计算云端 API 配置数（真实检测，不再硬编码"未配置"） */
      let cloudApiDetail = '未配置';
      let cloudApiStatus: HealthStatus = 'warn';
      try {
        const settings = await API.settingsExt.getAll();
        const configuredProviders = ['deepseekKey', 'qwenKey', 'openaiKey', 'doubaoKey', 'hunyuanKey']
          .filter(key => settings?.[key]);
        if (configuredProviders.length > 0) {
          cloudApiDetail = `${configuredProviders.length} 个供应商已配置`;
          cloudApiStatus = 'ok';
        }
      } catch {
        // settings 获取失败保持 "未配置"
      }

      /** 构建 6 项检查列表 */
      const items: HealthCheckItem[] = [
        {
          key: 'database',
          label: '数据库',
          status: health?.services?.db ? 'ok' : 'error',
          // V5：主行直接显示 SQLite 版本，不再需要详情 Modal
          detail: health?.services?.db
            ? `SQLite v${health.sqliteVersion || 'unknown'} · 已连接`
            : '数据库连接失败',
        },
        {
          key: 'ffmpeg',
          label: 'FFmpeg',
          status: health?.services?.ffmpeg ? 'ok' : 'error',
          detail: health?.services?.ffmpeg ? '可用' : '未找到',
        },
        {
          key: 'disk',
          label: '磁盘空间',
          status: health?.disk
            ? (health.disk.freeGB > 10 ? 'ok' : 'warn')
            : 'warn',
          detail: health?.disk
            ? `剩余 ${health.disk.freeGB} GB（共 ${health.disk.totalGB} GB）`
            : '信息不可用',
        },
        {
          key: 'cpu',
          label: 'CPU',
          status: (health?.cpu?.percent ?? 0) < 90 ? 'ok' : 'warn',
          // V5：只显使用率，不显型号（开发信息）
          detail: `${health?.cpu?.percent ?? 0}% 使用率`,
        },
        {
          key: 'memory',
          label: '内存',
          status: (health?.memory?.percent ?? 0) < 85 ? 'ok' : 'warn',
          // V5：只显使用率，不显 MB 细节
          detail: `${health?.memory?.percent ?? 0}% 使用率`,
        },
        {
          key: 'cloud_api',
          label: '云端 API',
          status: cloudApiStatus,
          detail: cloudApiDetail,
        },
      ];

      setChecks(items);
    } catch (err: any) {
      setError(err.message || '获取系统健康信息失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchHealth(); }, []);

  /** 获取状态图标 */
  const getStatusIcon = (status: HealthStatus) => {
    switch (status) {
      case 'ok':
        return <CheckCircle2 size={18} className="text-accent-green" />;
      case 'warn':
        return <AlertTriangle size={18} className="text-yellow-500" />;
      case 'error':
        return <XCircle size={18} className="text-accent-rose" />;
    }
  };

  /** 获取状态文字 */
  const getStatusLabel = (status: HealthStatus) => {
    switch (status) {
      case 'ok':
        return <span className="text-accent-green text-xs font-medium">正常</span>;
      case 'warn':
        return <span className="text-yellow-500 text-xs font-medium">警告</span>;
      case 'error':
        return <span className="text-accent-rose text-xs font-medium">异常</span>;
    }
  };

  return (
    <div className="space-y-6 animate-fade-in" style={{ maxWidth: '900px' }}>
      {/* 标题与操作 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-semibold">系统健康检查</div>
          <div className="text-xs text-muted-foreground mt-1">检查各组件运行状态</div>
        </div>
        <button
          onClick={fetchHealth}
          disabled={loading}
          className="h-9 px-4 rounded-lg bg-bg-secondary border border-border/50 text-xs font-medium hover:border-accent/40 hover:text-accent transition-all cursor-pointer outline-none flex items-center gap-1.5 disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {loading ? '检测中...' : '重新检查'}
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="rounded-xl p-4 border border-accent-rose/25 bg-accent-rose/5 text-sm text-accent-rose">
          {error}
        </div>
      )}

      {/* 加载态：V5 修复，每次检查都显示加载态，让用户看到刷新反馈 */}
      {loading && (
        <div className="glass-card-sm flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-accent" />
          <span className="ml-3 text-sm text-muted-foreground">正在收集系统健康数据...</span>
        </div>
      )}

      {/* 6 项健康检查列表 */}
      {!loading && checks.length > 0 && (
        <div className="glass-card-sm overflow-hidden">
          {checks.map((item, i) => (
            <div
              key={item.key}
              className={`flex items-center justify-between px-5 py-4 ${i < checks.length - 1 ? 'border-b border-border/20' : ''}`}
            >
              <div className="flex items-center gap-3">
                {getStatusIcon(item.status)}
                <div>
                  <div className="text-sm font-medium text-foreground">{item.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{item.detail}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {getStatusLabel(item.status)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 底部提示 */}
      {!loading && checks.length > 0 && (
        <div className="text-xs text-muted-foreground px-1">
          💡 如需查看 Python 运行时依赖或模型文件状态，请前往「模型管理」页
        </div>
      )}
    </div>
  );
};
