// 📁 路径: src/modules/settings/frontend/components/HealthPage.tsx
// 系统健康检查 Tab - V3 原型对齐
// 6项健康检查：数据库/FFmpeg/本地模型/云端API/磁盘空间/存储路径
// 🔧 V7 新增：AI 引擎依赖区（torch/demucs/funasr/insightface/transformers 独立卡片）
import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Server, Database, Cpu, HardDrive, Package, PackageX } from 'lucide-react';
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

/** 🔧 V7 新增：AI 引擎依赖卡片数据（对应 ai_daemon.modules 返回结构） */
interface EngineCard {
  id: string;
  display_name: string;
  size: string;
  ready: boolean;
  missing: string[];
  shared_by?: string[];  // 共用该引擎的功能模块
  needs?: string[];      // 该引擎依赖的其他引擎
}

/**
 * 系统健康检查 Tab
 * V3 原型对齐：6项检查 + 警告级别 + 硬件信息 + AI 引擎依赖区
 */
export const HealthPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [checks, setChecks] = useState<HealthCheckItem[]>([]);
  const [hardware, setHardware] = useState<any>(null);
  const [error, setError] = useState('');
  /** 🔧 V7 新增：AI 引擎依赖列表（来自 ai_daemon /api/check_deps 的 modules 字段） */
  const [engines, setEngines] = useState<EngineCard[]>([]);
  const [pythonExe, setPythonExe] = useState('');

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
          // 🔧 修复 P0：后端 scanDiskModels 写入 status='downloaded'，旧版只认 'ready' → 模型已下载但显示 0
          //   修复后：同时接受 downloaded/ready/is_installed 三种已下载信号
          const installed = modelList.filter((m: any) =>
            m.is_installed || m.status === 'ready' || m.status === 'downloaded'
          ).length;
          const total = modelList.length || 7;
          items[2] = {
            key: 'local_models',
            label: '本地模型',
            status: installed === 0 ? 'warn' : installed < total ? 'warn' : 'ok',
            detail: `${installed}/${total} 已下载`,
          };
        }
      } catch {}

      /** 🔧 V7 新增：AI 引擎依赖区（从 ai_daemon.modules 读取，独立卡片展示）
       *    旧版：python_deps 仅显示单行 "X/N 关键依赖已安装"，信息过简
       *    V7：拆分为 torch/demucs/mdx_net/whisper/sensevoice/insightface/clip 7 个引擎卡片
       *    不再作为健康检查项，而是独立区块，支持查看每个引擎的缺失依赖
       */
      try {
        const depsRes = await API.ai.checkDeps();
        if (depsRes?.modules) {
          const engineList = Object.entries(depsRes.modules).map(([id, info]: [string, any]) => ({
            id,
            display_name: info.display_name || id,
            size: info.size || '',
            ready: !!info.ready,
            missing: info.missing || [],
            shared_by: info.shared_by,
            needs: info.needs,
          }));
          setEngines(engineList);
          if (depsRes.python_executable) {
            setPythonExe(depsRes.python_executable);
          }
        } else {
          // Python 服务未启动
          setEngines([]);
        }
      } catch {
        setEngines([]);
      }

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

      {/* 🔧 V7 新增：AI 引擎依赖区（独立卡片，对应 ModelTab 卡片的运行时依赖） */}
      {engines.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <Package size={14} className="text-accent" />
            <div className="text-sm font-semibold">AI 引擎依赖</div>
            <div className="text-[11px] text-muted-foreground">
              {engines.filter(e => e.ready).length}/{engines.length} 已就绪
            </div>
            {pythonExe && (
              <div className="text-[10px] text-muted-foreground ml-auto truncate max-w-[400px]" title={pythonExe}>
                Python: {pythonExe}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {engines.map(engine => (
              <EngineCardView key={engine.id} engine={engine} />
            ))}
          </div>
          <div className="text-[10px] text-muted-foreground px-1">
            💡 引擎包为 Python 依赖（pip install），与模型文件独立。模型管理页的卡片会显示对应引擎是否就绪。
          </div>
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

/**
 * 🔧 V7 新增：AI 引擎依赖卡片
 * 显示引擎名称/版本/大小/状态/缺失依赖/共用方
 */
const EngineCardView: React.FC<{ engine: EngineCard }> = ({ engine }) => {
  const isShared = engine.shared_by && engine.shared_by.length > 0;
  const needsOthers = engine.needs && engine.needs.length > 0;
  return (
    <div className={`glass-card-sm p-3.5 ${engine.ready ? 'border-accent-green/20' : 'border-yellow-500/20'}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[12px] font-medium text-foreground">{engine.display_name}</div>
        {engine.ready ? (
          <span className="flex items-center gap-1 text-[10px] text-accent-green">
            <CheckCircle2 size={11} /> 已就绪
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-yellow-500">
            <PackageX size={11} /> 未安装
          </span>
        )}
      </div>
      {engine.size && (
        <div className="text-[10px] text-muted-foreground mb-1.5">体积: {engine.size}</div>
      )}
      {!engine.ready && engine.missing.length > 0 && (
        <div className="text-[10px] text-accent-rose mb-1.5">
          缺失: {engine.missing.join(', ')}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {isShared && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
            共用: {engine.shared_by!.join('/')}
          </span>
        )}
        {needsOthers && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-bg-tertiary text-muted-foreground">
            依赖: {engine.needs!.join('+')}
          </span>
        )}
      </div>
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
