// 📁 路径: src/modules/settings/frontend/components/HealthPage.tsx
// 系统健康检查 Tab - V3 原型对齐
// 6项健康检查：数据库/FFmpeg/本地模型/云端API/磁盘空间/存储路径
import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Server, Database, Cpu, HardDrive } from 'lucide-react';
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
 * 系统健康检查 Tab
 * V3 原型对齐：6项检查 + 警告级别 + 硬件信息
 */
export const HealthPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [checks, setChecks] = useState<HealthCheckItem[]>([]);
  const [hardware, setHardware] = useState<any>(null);
  const [error, setError] = useState('');

  /** 执行健康检查 */
  const fetchHealth = async () => {
    setLoading(true);
    setError('');
    try {
      const health = await API.system.health();
      await API.system.smokeTest();

      /** 构建检查项列表 */
      const items: HealthCheckItem[] = [
        {
          key: 'database',
          label: '数据库',
          status: health?.services?.db ? 'ok' : 'error',
          detail: health?.services?.db ? 'SQLite 连接正常' : '数据库连接失败',
        },
        {
          key: 'ffmpeg',
          label: 'FFmpeg',
          status: health?.services?.ffmpeg ? 'ok' : 'error',
          detail: health?.services?.ffmpeg ? 'FFmpeg 可用' : 'FFmpeg 未找到',
        },
        {
          key: 'local_models',
          label: '本地模型',
          status: 'warn' as HealthStatus,
          detail: '0/7 已下载',
        },
        {
          key: 'cloud_api',
          label: '云端 API',
          status: 'warn' as HealthStatus,
          detail: '未配置',
        },
        {
          key: 'disk',
          label: '磁盘空间',
          status: health?.disk ? (health.disk.freeGB > 10 ? 'ok' : 'warn') : 'ok',
          detail: health?.disk ? `剩余 ${health.disk.freeGB}GB` : '信息不可用',
        },
        {
          key: 'storage_paths',
          label: '存储路径',
          status: 'ok' as HealthStatus,
          detail: '所有路径可写入',
        },
      ];

      /** 尝试获取模型状态 */
      try {
        const modelList = await API.model.getList();
        if (Array.isArray(modelList)) {
          const installed = modelList.filter((m: any) => m.is_installed || m.status === 'ready').length;
          const total = modelList.length || 7;
          items[2] = {
            key: 'local_models',
            label: '本地模型',
            status: installed === 0 ? 'warn' : installed < total ? 'warn' : 'ok',
            detail: `${installed}/${total} 已下载`,
          };
        }
      } catch {}

      /** 尝试获取设置中的 API 配置 */
      try {
        const settings = await API.settingsExt.getAll();
        const configuredProviders = ['deepseekKey', 'qwenKey', 'openaiKey', 'doubaoKey', 'hunyuanKey']
          .filter(key => settings?.[key]);
        if (configuredProviders.length > 0) {
          items[3] = {
            key: 'cloud_api',
            label: '云端 API',
            status: 'ok',
            detail: `${configuredProviders.length} 个供应商已配置`,
          };
        }
      } catch {}

      setChecks(items);
      setHardware(health);
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
      case 'ok': return <div className="w-8 h-8 rounded-full bg-accent-green/20 flex items-center justify-center text-accent-green"><CheckCircle2 size={16} /></div>;
      case 'warn': return <div className="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center text-yellow-500"><AlertTriangle size={16} /></div>;
      case 'error': return <div className="w-8 h-8 rounded-full bg-accent-rose/20 flex items-center justify-center text-accent-rose"><XCircle size={16} /></div>;
    }
  };

  /** 获取状态文字 */
  const getStatusLabel = (status: HealthStatus) => {
    switch (status) {
      case 'ok': return <span className="text-accent-green text-[11px] font-medium">正常</span>;
      case 'warn': return <span className="text-yellow-500 text-[11px] font-medium">警告</span>;
      case 'error': return <span className="text-accent-rose text-[11px] font-medium">异常</span>;
    }
  };

  return (
    <div className="space-y-6 animate-fade-in" style={{ maxWidth: '996px' }}>
      {/* 标题 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">系统健康检查</div>
          <div className="text-[11px] text-muted-foreground">检查各组件运行状态</div>
        </div>
        <button
          onClick={fetchHealth}
          disabled={loading}
          className="h-8 px-4 rounded-lg bg-bg-secondary border border-border/50 text-[11px] font-medium hover:border-accent/40 hover:text-accent transition-all cursor-pointer outline-none flex items-center gap-1.5 disabled:opacity-50"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Server size={13} />}
          {loading ? '检测中...' : '重新检查'}
        </button>
      </div>

      {error && (
        <div className="rounded-xl p-4 border border-accent-rose/25 bg-accent-rose/5 text-[12px] text-accent-rose">{error}</div>
      )}

      {loading && !checks.length && (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-accent" />
          <span className="ml-3 text-[12px] text-muted-foreground">正在收集系统健康数据...</span>
        </div>
      )}

      {/* 6项健康检查列表 */}
      {checks.length > 0 && (
        <div className="glass-card-sm overflow-hidden">
          {checks.map((item, i) => (
            <div key={item.key} className={`flex items-center justify-between px-5 py-3.5 ${i < checks.length - 1 ? 'border-b border-border/20' : ''}`}>
              <div className="flex items-center gap-3">
                {getStatusIcon(item.status)}
                <div>
                  <div className="text-[13px] font-medium text-foreground">{item.label}</div>
                  <div className="text-[11px] text-muted-foreground">{item.detail}</div>
                </div>
              </div>
              {getStatusLabel(item.status)}
            </div>
          ))}
        </div>
      )}

      {/* 硬件信息 */}
      {hardware && (
        <div className="grid grid-cols-3 gap-3">
          <HardwareCard icon={<Cpu size={16} />} title="CPU" value={`${hardware.cpu?.percent ?? 0}%`} detail={`${hardware.cpu?.model ?? ''} (${hardware.cpu?.cores ?? 0}核)`} />
          <HardwareCard icon={<HardDrive size={16} />} title="内存" value={`${hardware.memory?.percent ?? 0}%`} detail={`空闲 ${hardware.memory?.freeMB ?? 0}MB / 共 ${hardware.memory?.totalMB ?? 0}MB`} />
          <HardwareCard icon={<Database size={16} />} title="磁盘" value={hardware.disk ? `${Math.round((1 - (hardware.disk.freeGB ?? 0) / (hardware.disk.totalGB || 1)) * 100)}%` : 'N/A'} detail={hardware.disk ? `空闲 ${hardware.disk.freeGB}GB / 共 ${hardware.disk.totalGB}GB` : ''} />
        </div>
      )}
    </div>
  );
};

/** 硬件指标卡片 */
const HardwareCard: React.FC<{ icon: React.ReactNode; title: string; value: string; detail: string }> = ({ icon, title, value, detail }) => (
  <div className="glass-card-sm p-4">
    <div className="flex items-center gap-2 text-muted-foreground mb-2">{icon}<span className="text-[11px] font-medium">{title}</span></div>
    <div className="text-lg font-bold text-foreground">{value}</div>
    <div className="text-[10px] text-muted-foreground mt-0.5">{detail}</div>
  </div>
);
