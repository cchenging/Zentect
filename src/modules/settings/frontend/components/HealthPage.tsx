// 📁 路径: src/modules/settings/frontend/components/HealthPage.tsx
// 系统健康检查 Tab - V6 完整版
// 🔧 V6 重构（用户决策）：
//   1. 检查列表 7 项（数据库/FFmpeg/Python/AI运行时/LLM通道/TTS/云端API），每项带详情按钮
//   2. 底部硬件 3 小卡片（CPU/内存/磁盘）显示型号+使用率
//   3. 详情 Modal 显示具体字段（版本/路径/包列表/通道列表等）
//   4. 修复伪硬编码：所有数据从 system:health 真实获取
//   5. 字体规范 12px 起步：辅助 12px / 正文 13px / 标题 14-16px / 数值 18px
import React, { useEffect, useState } from 'react';
import {
  CheckCircle2, XCircle, AlertTriangle, Loader2, RefreshCw, ChevronRight, X,
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
  /** 详情 Modal 内容（按行渲染） */
  modalFields?: Array<{ label: string; value: string }>;
  /** 详情 Modal 列表内容（每行一个，带 ✓/✗） */
  modalList?: Array<{ name: string; ok: boolean; extra?: string }>;
  /** 详情 Modal 列表标题 */
  modalListTitle?: string;
}

/** 硬件卡片数据 */
interface HardwareCard {
  key: string;
  label: string;
  bigValue: string;
  lines: string[];
}

/** V6 健康报告类型（与后端 HealthReport 对齐，部分字段可选） */
interface V6HealthReport {
  cpu: { model: string; cores: number; percent: number };
  memory: { totalMB: number; freeMB: number; percent: number };
  disk: { freeGB: number; totalGB: number } | null;
  services: { db: boolean; aiDaemon: boolean; ffmpeg: boolean };
  sqliteVersion: string;
  ffmpegInfo: { version: string | null; path: string | null; available: boolean };
  pythonInfo: { version: string | null; path: string | null; ready: boolean };
  databaseInfo: { path: string; sizeBytes: number; sizeMB: number };
  runtimePkgs: Array<{ name: string; displayName: string; installed: boolean; version: string | null; usedBy: string[] }>;
  llmChannels: Array<{ id: string; displayName: string; configured: boolean; isDefault: boolean }>;
  ttsEngines: Array<{ id: string; displayName: string; available: boolean; isDefault: boolean; builtin: boolean }>;
}

/**
 * 系统健康检查 Tab - V6 完整版
 * 7 项检查列表 + 底部硬件 3 卡 + 详情 Modal
 */
export const HealthPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<V6HealthReport | null>(null);
  const [error, setError] = useState('');
  /** 当前展开的详情 Modal key */
  const [detailKey, setDetailKey] = useState<string | null>(null);

  /** 执行健康检查 */
  const fetchHealth = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await API.system.health();
      setHealth(data);
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
      case 'ok': return <CheckCircle2 size={16} className="text-accent-green" />;
      case 'warn': return <AlertTriangle size={16} className="text-yellow-500" />;
      case 'error': return <XCircle size={16} className="text-accent-rose" />;
    }
  };

  /** 获取状态标签 */
  const getStatusLabel = (status: HealthStatus) => {
    switch (status) {
      case 'ok': return <span className="text-xs font-medium text-accent-green">正常</span>;
      case 'warn': return <span className="text-xs font-medium text-yellow-500">警告</span>;
      case 'error': return <span className="text-xs font-medium text-accent-rose">异常</span>;
    }
  };

  /** 构建 7 项检查列表 */
  const checks: HealthCheckItem[] = React.useMemo(() => {
    if (!health) return [];
    const items: HealthCheckItem[] = [];

    // 1. 数据库
    const dbOk = health.services?.db;
    items.push({
      key: 'database',
      label: '数据库',
      status: dbOk ? 'ok' : 'error',
      detail: dbOk ? `SQLite v${health.sqliteVersion || 'unknown'} · 已连接` : '连接失败',
      modalFields: [
        { label: '类型', value: 'SQLite' },
        { label: '版本', value: health.sqliteVersion || 'unknown' },
        { label: '文件路径', value: health.databaseInfo?.path || '-' },
        { label: '文件大小', value: `${health.databaseInfo?.sizeMB ?? 0} MB` },
        { label: '状态', value: dbOk ? '已连接' : '连接失败' },
      ],
    });

    // 2. FFmpeg
    const ffmpegOk = health.ffmpegInfo?.available;
    items.push({
      key: 'ffmpeg',
      label: 'FFmpeg',
      status: ffmpegOk ? 'ok' : 'error',
      detail: ffmpegOk ? `可用${health.ffmpegInfo.version ? ' · v' + health.ffmpegInfo.version : ''}` : '未找到',
      modalFields: [
        { label: '版本', value: health.ffmpegInfo?.version || '未知' },
        { label: '路径', value: health.ffmpegInfo?.path || '-' },
        { label: '状态', value: ffmpegOk ? '可用' : '未找到' },
      ],
    });

    // 3. Python 运行环境
    const pyOk = health.pythonInfo?.ready;
    items.push({
      key: 'python',
      label: 'Python 运行环境',
      status: pyOk ? 'ok' : 'error',
      detail: pyOk ? `v${health.pythonInfo.version || 'unknown'} · 已就绪` : '离线',
      modalFields: [
        { label: '版本', value: health.pythonInfo?.version || '未知' },
        { label: '可执行路径', value: health.pythonInfo?.path || '-' },
        { label: '状态', value: pyOk ? '已就绪' : '离线' },
      ],
    });

    // 4. AI 运行时依赖（pip 包）
    const pkgs = health.runtimePkgs || [];
    const installedCount = pkgs.filter(p => p.installed).length;
    const missingCount = pkgs.length - installedCount;
    items.push({
      key: 'runtime',
      label: 'AI 运行时依赖',
      status: missingCount === 0 ? 'ok' : (missingCount < pkgs.length ? 'warn' : 'error'),
      detail: `${installedCount}/${pkgs.length} 个包已装`,
      modalListTitle: '运行时包',
      modalList: pkgs.map(p => ({
        name: `${p.displayName} ${p.version ? p.version : ''}`.trim(),
        ok: p.installed,
        extra: `← ${p.usedBy.join(' / ')}`,
      })),
      modalFields: [
        { label: '缺失包总数', value: `${missingCount} 个` },
      ],
    });

    // 5. 大模型通道
    const channels = health.llmChannels || [];
    const configuredChannels = channels.filter(c => c.configured).length;
    const defaultChannel = channels.find(c => c.isDefault);
    items.push({
      key: 'llm',
      label: '大模型通道',
      status: configuredChannels > 0 ? 'ok' : 'warn',
      detail: `${configuredChannels}/${channels.length} 个通道已配置`,
      modalListTitle: 'LLM 通道',
      modalList: channels.map(c => ({
        name: c.displayName + (c.isDefault ? '（默认）' : ''),
        ok: c.configured,
      })),
      modalFields: [
        { label: '当前默认通道', value: defaultChannel?.displayName || '未设置' },
      ],
    });

    // 6. TTS 语音合成
    const engines = health.ttsEngines || [];
    const availableEngines = engines.filter(e => e.available).length;
    const defaultEngine = engines.find(e => e.isDefault);
    items.push({
      key: 'tts',
      label: 'TTS 语音合成',
      status: availableEngines > 0 ? 'ok' : 'warn',
      detail: defaultEngine ? `已配置 · ${defaultEngine.displayName}` : '未配置',
      modalListTitle: 'TTS 引擎',
      modalList: engines.map(e => ({
        name: e.displayName + (e.builtin ? '（内置）' : '') + (e.isDefault ? '（默认）' : ''),
        ok: e.available,
      })),
      modalFields: [
        { label: '当前默认引擎', value: defaultEngine?.displayName || '未设置' },
      ],
    });

    // 7. 云端 API（从 LLM 通道 + TTS 引擎聚合）
    const totalApi = channels.length + engines.filter(e => !e.builtin).length;
    const configuredApi = configuredChannels + engines.filter(e => !e.builtin && e.available).length;
    items.push({
      key: 'cloud_api',
      label: '云端 API',
      status: configuredApi > 0 ? 'ok' : 'warn',
      detail: `${configuredApi}/${totalApi} 个已配置`,
      modalFields: [
        { label: 'LLM 通道', value: `${configuredChannels}/${channels.length} 已配置` },
        { label: 'TTS 引擎', value: `${availableEngines}/${engines.length} 可用` },
      ],
    });

    return items;
  }, [health]);

  /** 构建硬件 3 卡 */
  const hardwareCards: HardwareCard[] = React.useMemo(() => {
    if (!health) return [];
    const cards: HardwareCard[] = [];

    // CPU 卡
    cards.push({
      key: 'cpu',
      label: 'CPU',
      bigValue: `${health.cpu?.percent ?? 0}%`,
      lines: [
        health.cpu?.model || 'Unknown',
        `${health.cpu?.cores ?? 0} 核`,
      ],
    });

    // 内存卡
    const memUsed = health.memory ? health.memory.totalMB - health.memory.freeMB : 0;
    cards.push({
      key: 'memory',
      label: '内存',
      bigValue: `${health.memory?.percent ?? 0}%`,
      lines: [
        `总量 ${health.memory?.totalMB ?? 0} MB`,
        `已用 ${memUsed} MB / 空闲 ${health.memory?.freeMB ?? 0} MB`,
      ],
    });

    // 磁盘卡
    if (health.disk) {
      const usedGB = health.disk.totalGB - health.disk.freeGB;
      const usedPercent = Math.round((usedGB / health.disk.totalGB) * 100);
      cards.push({
        key: 'disk',
        label: '磁盘',
        bigValue: `${health.disk.freeGB} GB`,
        lines: [
          `共 ${health.disk.totalGB} GB`,
          `已用 ${usedGB} GB (${usedPercent}%)`,
        ],
      });
    }

    return cards;
  }, [health]);

  /** 当前展开的详情项 */
  const detailItem = checks.find(c => c.key === detailKey);

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

      {/* 加载态 */}
      {loading && (
        <div className="glass-card-sm flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-accent" />
          <span className="ml-3 text-sm text-muted-foreground">正在收集系统健康数据...</span>
        </div>
      )}

      {/* 检查列表 */}
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
              <div className="flex items-center gap-3">
                {getStatusLabel(item.status)}
                <button
                  onClick={() => setDetailKey(item.key)}
                  className="text-xs text-accent hover:text-accent-cyan flex items-center gap-0.5 transition-colors"
                >
                  详情 <ChevronRight size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 硬件状态 - 底部 3 小卡片 */}
      {!loading && hardwareCards.length > 0 && (
        <div>
          <div className="text-sm font-semibold mb-3 text-foreground">硬件状态</div>
          <div className="grid grid-cols-3 gap-3">
            {hardwareCards.map(card => (
              <div key={card.key} className="glass-card-sm p-4">
                <div className="text-xs text-muted-foreground mb-1">{card.label}</div>
                <div className="text-lg font-bold text-foreground mb-2">{card.bigValue}</div>
                {card.lines.map((line, i) => (
                  <div key={i} className="text-xs text-muted-foreground truncate" title={line}>
                    {line}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 详情 Modal */}
      {detailItem && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => setDetailKey(null)}
        >
          <div
            className="bg-bg-secondary rounded-xl border border-border/50 shadow-2xl max-w-md w-full mx-4 max-h-[80vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal 头部 */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border/30">
              <div className="flex items-center gap-2">
                {getStatusIcon(detailItem.status)}
                <div className="text-sm font-semibold">{detailItem.label}</div>
              </div>
              <button
                onClick={() => setDetailKey(null)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Modal 内容 */}
            <div className="px-5 py-4 overflow-y-auto space-y-4">
              {/* 字段列表 */}
              {detailItem.modalFields && detailItem.modalFields.length > 0 && (
                <div className="space-y-2">
                  {detailItem.modalFields.map((field, i) => (
                    <div key={i} className="flex items-start justify-between gap-3 text-xs">
                      <span className="text-muted-foreground flex-shrink-0">{field.label}</span>
                      <span className="text-foreground text-right break-all">{field.value}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* 列表内容（包/通道/引擎） */}
              {detailItem.modalList && detailItem.modalList.length > 0 && (
                <div>
                  {detailItem.modalListTitle && (
                    <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                      {detailItem.modalListTitle}
                    </div>
                  )}
                  <div className="space-y-1.5">
                    {detailItem.modalList.map((item, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        {item.ok ? (
                          <CheckCircle2 size={12} className="text-accent-green flex-shrink-0" />
                        ) : (
                          <XCircle size={12} className="text-accent-rose flex-shrink-0" />
                        )}
                        <span className="text-foreground">{item.name}</span>
                        {item.extra && (
                          <span className="text-muted-foreground text-xs ml-auto">{item.extra}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 底部提示 */}
      {!loading && checks.length > 0 && (
        <div className="text-xs text-muted-foreground px-1">
          💡 模型文件管理请前往「模型管理」页
        </div>
      )}
    </div>
  );
};
