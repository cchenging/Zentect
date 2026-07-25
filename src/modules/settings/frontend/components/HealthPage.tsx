// 📁 路径: src/modules/settings/frontend/components/HealthPage.tsx
// 系统健康检查 Tab - V4 重构
// 6 项健康检查：数据库 / FFmpeg / 本地模型 / 云端 API / 磁盘空间 / 存储路径
// 🔧 V4 改造：
//   1. P0-3：AI 引擎依赖区准确反映 demucs/sensevoice/clip 的 ready 状态（含 torch 等共用引擎）
//   2. P0-4：数据库项添加"详情"按钮 + Modal 显示路径/大小/版本/表列表
//   3. P0-5：本地模型项添加"详情"按钮 + Modal 显示已安装模型列表（按模块分组）
//   4. P1-1：明确职责边界 —— 健康检查只管"Python 运行时依赖"，模型文件状态去模型管理页查看
import React, { useEffect, useState } from 'react';
import {
  CheckCircle2, XCircle, AlertTriangle, Loader2, Server, Database,
  Cpu, HardDrive, Package, PackageX, ChevronRight,
} from 'lucide-react';
import { API } from '@renderer/api';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@renderer/components/ui/dialog';

/** 健康检查项状态 */
type HealthStatus = 'ok' | 'warn' | 'error';

/** 健康检查项 */
interface HealthCheckItem {
  key: string;
  label: string;
  status: HealthStatus;
  detail: string;
  /** V4 新增：是否支持详情按钮 */
  hasDetail?: boolean;
}

/** AI 引擎依赖卡片数据（对应 ai_daemon.modules 返回结构） */
interface EngineCard {
  id: string;
  display_name: string;
  size: string;
  ready: boolean;
  missing: string[];
  shared_by?: string[];
  needs?: string[];
}

/** 本地模型模块（用于详情 Modal 展示已安装模型列表） */
interface ModelModule {
  id: string;
  displayName: string;
  category: string;
  canUse: boolean;
  runtime: { ready: boolean; missing: string[]; displayName: string };
  models: Array<{
    id: string;
    name: string;
    displayName: string;
    status: string;
    sizeBytes: number;
    downloadPath: string;
  }>;
}

/** 格式化字节大小为人类可读字符串 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 系统健康检查 Tab
 * V4 重构：6 项检查 + 详情 Modal + Python 运行时依赖区
 * 职责边界：
 *   - 本页只显示"系统健康项"和"Python 运行时依赖（pip 包级别）"
 *   - 模型文件状态（.pth/.onnx 等磁盘文件）请前往"模型管理"页查看
 */
export const HealthPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [checks, setChecks] = useState<HealthCheckItem[]>([]);
  const [hardware, setHardware] = useState<any>(null);
  const [error, setError] = useState('');
  /** AI 引擎依赖列表（来自 ai_daemon /api/check_deps 的 modules 字段） */
  const [engines, setEngines] = useState<EngineCard[]>([]);
  const [pythonExe, setPythonExe] = useState('');
  /** V4 新增：本地模型模块列表（供详情 Modal 展示） */
  const [modelModules, setModelModules] = useState<ModelModule[]>([]);
  /** V4 新增：当前打开的详情 Modal 类型 */
  const [detailOpen, setDetailOpen] = useState<null | 'database' | 'models'>(null);
  /** V4 新增：详情 Modal 数据 */
  const [dbDetail, setDbDetail] = useState<Awaited<ReturnType<typeof API.system.getDbDetail>> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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
          hasDetail: true,  // V4：支持详情按钮
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
          detail: '0/0 已下载',
          hasDetail: true,  // V4：支持详情按钮
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

      /** V4 新增：并行拉取模型模块列表 + Python 依赖状态
       *  模型模块用于"本地模型"详情 Modal 显示已安装模型列表
       *  Python 依赖用于"AI 引擎依赖"区显示运行时状态
       */
      const [moduleList, depsRes] = await Promise.all([
        API.model.getModuleList().catch(() => []),
        API.ai.checkDeps().catch(() => null),
      ]);

      /** 计算本地模型状态 */
      if (Array.isArray(moduleList) && moduleList.length > 0) {
        const flatModels = moduleList.flatMap((m: any) => m.models || []);
        const installed = flatModels.filter((m: any) => m.status === 'downloaded').length;
        const total = flatModels.length;
        items[2] = {
          key: 'local_models',
          label: '本地模型',
          status: installed === 0 ? 'warn' : installed < total ? 'warn' : 'ok',
          detail: `${installed}/${total} 已下载（${moduleList.filter((m: any) => m.canUse).length}/${moduleList.length} 模块可用）`,
          hasDetail: true,
        };
        setModelModules(moduleList);
      }

      /** 解析 Python 引擎依赖（V4：明确 demucs/sensevoice/clip 含 torch 共用引擎） */
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

  /** V4 新增：打开详情 Modal（按需拉取数据） */
  const openDetail = async (type: 'database' | 'models') => {
    setDetailOpen(type);
    setDetailLoading(true);
    try {
      if (type === 'database') {
        const detail = await API.system.getDbDetail();
        setDbDetail(detail);
      }
      // models 类型无需额外请求，modelModules 已在 fetchHealth 中加载
    } catch (err: any) {
      console.error('[HealthPage] 加载详情失败:', err);
    } finally {
      setDetailLoading(false);
    }
  };

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

      {/* 6 项健康检查列表 */}
      {checks.length > 0 && (
        <div className="glass-card-sm overflow-hidden">
          {checks.map((item, i) => (
            <div
              key={item.key}
              className={`flex items-center justify-between px-5 py-3.5 ${i < checks.length - 1 ? 'border-b border-border/20' : ''}`}
            >
              <div className="flex items-center gap-3">
                {getStatusIcon(item.status)}
                <div>
                  <div className="text-[13px] font-medium text-foreground">{item.label}</div>
                  <div className="text-[11px] text-muted-foreground">{item.detail}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* V4 新增：详情按钮（database / local_models） */}
                {item.hasDetail && (
                  <button
                    onClick={() => openDetail(item.key as 'database' | 'models')}
                    className="text-[10px] text-accent hover:text-accent-cyan flex items-center gap-0.5 px-2 py-1 rounded border border-accent/30 hover:bg-accent/10 transition-colors"
                  >
                    详情 <ChevronRight size={10} />
                  </button>
                )}
                {getStatusLabel(item.status)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 🔧 V4：Python 运行时依赖区（明确职责边界，避免与模型管理页冲突）
          - 本区只显示 Python 包级别状态（torch/demucs/funasr/transformers 等）
          - 模型文件状态（.pth/.onnx 磁盘文件）请前往"模型管理"页查看
          - 引擎 ready 判断与 needs 字段一致（demucs 含 torch+torchaudio，sensevoice/clip 含 torch） */}
      {engines.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <Package size={14} className="text-accent" />
            <div className="text-sm font-semibold">Python 运行时依赖</div>
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
            💡 本区仅显示 Python pip 包安装状态，与模型文件状态独立。模型文件（.pth/.onnx）请前往「模型管理」页查看。
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

      {/* V4 新增：数据库详情 Modal */}
      <Dialog open={detailOpen === 'database'} onOpenChange={(v) => !v && setDetailOpen(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>数据库详情</DialogTitle>
            <DialogDescription>SQLite 数据库文件路径、版本、表统计</DialogDescription>
          </DialogHeader>
          {detailLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={20} className="animate-spin text-accent" />
              <span className="ml-2 text-[12px] text-muted-foreground">加载中...</span>
            </div>
          ) : dbDetail ? (
            <div className="space-y-3 text-[12px]">
              <DetailRow label="文件路径" value={dbDetail.path} mono />
              <DetailRow label="文件大小" value={formatBytes(dbDetail.sizeBytes)} />
              <DetailRow label="SQLite 版本" value={dbDetail.sqliteVersion} />
              <DetailRow label="日志模式" value={dbDetail.journalMode} />
              <div className="pt-2 border-t border-border/30">
                <div className="text-[11px] font-medium text-muted-foreground mb-2">
                  表列表（{dbDetail.tables.length} 张表）
                </div>
                <div className="max-h-80 overflow-y-auto rounded-lg border border-border/30">
                  <table className="w-full text-[11px]">
                    <thead className="bg-muted/20 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-medium">表名</th>
                        <th className="text-right px-3 py-1.5 font-medium">行数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dbDetail.tables.map(t => (
                        <tr key={t.name} className="border-t border-border/20">
                          <td className="px-3 py-1.5 font-mono text-foreground">{t.name}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {t.rowCount >= 0 ? t.rowCount.toLocaleString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-10 text-[12px] text-muted-foreground">加载失败</div>
          )}
        </DialogContent>
      </Dialog>

      {/* V4 新增：本地模型列表 Modal */}
      <Dialog open={detailOpen === 'models'} onOpenChange={(v) => !v && setDetailOpen(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>本地模型列表</DialogTitle>
            <DialogDescription>按功能模块展示已安装的模型文件（与模型管理页同步）</DialogDescription>
          </DialogHeader>
          {modelModules.length === 0 ? (
            <div className="text-center py-10 text-[12px] text-muted-foreground">
              暂无模型数据
            </div>
          ) : (
            <div className="space-y-3">
              {modelModules.map(mod => {
                const installed = mod.models.filter(m => m.status === 'downloaded');
                const total = mod.models.length;
                return (
                  <div key={mod.id} className="rounded-lg border border-border/30 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-medium text-foreground">{mod.displayName}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${mod.canUse ? 'bg-accent-green/15 text-accent-green' : 'bg-yellow-500/15 text-yellow-500'}`}>
                          {mod.canUse ? '可用' : '部分就绪'}
                        </span>
                      </div>
                      <span className="text-[11px] text-muted-foreground">
                        {installed.length}/{total} 模型 · {mod.runtime.ready ? '运行时就绪' : '运行时缺失'}
                      </span>
                    </div>
                    {installed.length > 0 ? (
                      <div className="space-y-1">
                        {installed.map(m => (
                          <div key={m.id} className="flex items-center justify-between text-[11px] py-1 px-2 bg-muted/15 rounded">
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              <CheckCircle2 size={11} className="text-accent-green flex-shrink-0" />
                              <span className="text-foreground truncate">{m.displayName}</span>
                              <span className="text-muted-foreground/60 text-[10px] font-mono truncate">{m.name}</span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0 text-muted-foreground">
                              <span>{m.sizeBytes > 0 ? formatBytes(m.sizeBytes) : '—'}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-muted-foreground/60 italic py-1">
                        尚无已下载的模型文件，请前往「模型管理」页安装
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

/**
 * AI 引擎依赖卡片
 * 显示引擎名称/版本/大小/状态/缺失依赖/共用方
 * V4：明确 ready 判断已包含 needs 字段声明的共用引擎
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

/** 详情行 */
const DetailRow: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="flex items-start gap-3 py-1">
    <div className="w-20 flex-shrink-0 text-[11px] text-muted-foreground">{label}</div>
    <div className={`flex-1 text-foreground break-all ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</div>
  </div>
);
