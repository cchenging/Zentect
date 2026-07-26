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
  CheckCircle2, XCircle, AlertTriangle, Loader2, RefreshCw, ChevronRight, X, Download, Zap,
} from 'lucide-react';
import { API } from '@renderer/api';

/** 🔧 V8 pip install 进度状态（与后端 InstallProgress 对齐） */
interface InstallProgressState {
  status: 'pending' | 'downloading' | 'installing' | 'done' | 'error' | null;
  total: number;
  installed: string[];
  current: string | null;
  percent: number;
  message: string;
  error: string | null;
}

/** 🚀 阶段 3 GPU/CUDA 状态（与后端 GpuStatus 对齐） */
interface GpuStatusState {
  cuda_available: boolean;
  device_count: number;
  devices: Array<{ name: string; vram_mb: number }>;
  torch_version: string;
  is_cuda_torch: boolean;
  cuda_version: string | null;
  needs_cuda_install: boolean;
}

/** 🚀 阶段 3 CUDA 版 torch 安装进度（与后端 GpuInstallProgress 对齐） */
interface GpuInstallProgressState {
  status: 'pending' | 'uninstalling' | 'installing' | 'done' | 'error' | 'rollback' | null;
  percent: number;
  message: string;
  current_step: string | null;
  error: string | null;
}

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
  /** 🔧 V8 pip install 安装状态 */
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<InstallProgressState | null>(null);

  // 🚀 阶段 3: GPU 加速相关状态
  const [gpuStatus, setGpuStatus] = useState<GpuStatusState | null>(null);
  const [enableGPU, setEnableGPU] = useState(false);
  const [cudaInstalling, setCudaInstalling] = useState(false);
  const [cudaInstallProgress, setCudaInstallProgress] = useState<GpuInstallProgressState | null>(null);

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

  /** 🔧 V8 一键安装缺失的运行时依赖 */
  const handleInstallMissingDeps = async () => {
    if (!health?.runtimePkgs) return;
    const missingPkgs = health.runtimePkgs.filter(p => !p.installed).map(p => p.name);
    if (missingPkgs.length === 0) return;

    setInstalling(true);
    setInstallProgress({
      status: 'pending', total: missingPkgs.length, installed: [],
      current: null, percent: 0, message: '准备安装...', error: null,
    });

    // 注册 SSE 进度监听
    const unsubscribe = API.system.onInstallDepProgress((progress: any) => {
      setInstallProgress(progress);
      if (progress.status === 'done' || progress.status === 'error') {
        setInstalling(false);
        // 安装完成后自动刷新健康检查
        if (progress.status === 'done') {
          setTimeout(() => fetchHealth(), 500);
        }
      }
    });

    try {
      const result = await API.system.installDep(missingPkgs);
      if (!result?.success) {
        setInstalling(false);
        setInstallProgress(prev => prev ? {
          ...prev, status: 'error',
          error: result?.message || '触发安装失败',
          message: result?.message || '触发安装失败',
        } : null);
      }
    } catch (err: any) {
      setInstalling(false);
      setInstallProgress(prev => prev ? {
        ...prev, status: 'error',
        error: err.message, message: err.message,
      } : null);
    } finally {
      // 进度流结束后取消订阅（延迟，确保最后一条消息处理完）
      setTimeout(() => unsubscribe(), 1000);
    }
  };

  /** 🚀 阶段 3: 查询 GPU 状态 + enableGPU 设置项 */
  const fetchGpuStatus = async () => {
    try {
      // 并行查询 GPU 状态和 enableGPU 设置（设置项可能以 boolean 或 string 形式返回）
      const [gpuRes, gpuEnabledVal] = await Promise.all([
        API.system.getGpuStatus(),
        API.system.getSetting<boolean>('enableGPU', false),
      ]);
      setGpuStatus(gpuRes || null);
      // 兼容 boolean / string 两种返回形式（SettingsService 可能返回 'true'/'false' 字符串）
      setEnableGPU(gpuEnabledVal === true || String(gpuEnabledVal) === 'true');
    } catch (err) {
      // GPU 状态查询失败不阻塞健康检查
      console.warn('[HealthPage] GPU 状态查询失败:', err);
    }
  };

  /** 🚀 阶段 3: 触发 CUDA 版 torch 安装 */
  const handleInstallCudaTorch = async () => {
    if (cudaInstalling) return;
    if (!window.confirm(
      '即将下载并安装 CUDA 版 torch（约 2.5GB），安装过程可能需要 5-30 分钟。\n\n' +
      '安装流程：\n' +
      '1. 卸载当前 CPU 版 torch\n' +
      '2. 下载 CUDA 12.1 版 torch（约 2.5GB）\n' +
      '3. 验证 CUDA 可用性\n' +
      '4. 安装失败将自动回滚到 CPU 版\n\n' +
      '安装完成后需要重启 AI 运行时以启用 GPU 加速。\n\n' +
      '确认开始安装？'
    )) return;

    setCudaInstalling(true);
    setCudaInstallProgress({
      status: 'pending', percent: 0, message: '准备安装 CUDA 版 torch...',
      current_step: null, error: null,
    });

    // 注册 SSE 进度监听
    const unsubscribe = API.system.onGpuInstallProgress((progress: any) => {
      setCudaInstallProgress(progress);
      if (progress.status === 'done' || progress.status === 'error') {
        setCudaInstalling(false);
        // 安装完成后刷新 GPU 状态
        if (progress.status === 'done') {
          setTimeout(() => fetchGpuStatus(), 1000);
        }
      }
    });

    try {
      const result = await API.system.installCudaTorch();
      if (!result?.success) {
        setCudaInstalling(false);
        setCudaInstallProgress(prev => prev ? {
          ...prev, status: 'error',
          error: result?.message || '触发 CUDA 安装失败',
          message: result?.message || '触发 CUDA 安装失败',
        } : null);
      }
    } catch (err: any) {
      setCudaInstalling(false);
      setCudaInstallProgress(prev => prev ? {
        ...prev, status: 'error',
        error: err.message, message: err.message,
      } : null);
    } finally {
      setTimeout(() => unsubscribe(), 1000);
    }
  };

  /** 🚀 阶段 3: 切换 AI 运行时 GPU 加速开关 */
  const handleToggleEnableGPU = async (newVal: boolean) => {
    // 开启 GPU 前的预检查
    if (newVal) {
      if (!gpuStatus) {
        window.alert('正在查询 GPU 状态，请稍后再试');
        return;
      }
      if (gpuStatus.needs_cuda_install) {
        // 当前为 CPU 版 torch，需要先安装 CUDA 版
        const confirmed = window.confirm(
          `检测到 NVIDIA GPU：${gpuStatus.devices[0]?.name || '未知型号'}\n` +
          `当前 torch 版本：${gpuStatus.torch_version}（CPU 版）\n\n` +
          `启用 GPU 加速需要先安装 CUDA 版 torch（约 2.5GB）。\n` +
          `点击"确定"开始安装，安装完成后将自动启用 GPU 加速。\n` +
          `点击"取消"暂不启用。`
        );
        if (!confirmed) return;
        // 先触发 CUDA 安装，安装成功后再开启开关
        await handleInstallCudaTorch();
        // 安装成功后 enableGPU 会在 fetchGpuStatus 中更新（暂不强制设 true，避免安装失败时状态错乱）
        return;
      }
      if (!gpuStatus.cuda_available) {
        window.alert(
          `未检测到可用的 CUDA GPU。\n\n` +
          `torch 版本：${gpuStatus.torch_version}\n` +
          `可能原因：\n` +
          `1. 未安装 NVIDIA 显卡驱动\n` +
          `2. 显卡驱动版本过低（需支持 CUDA 12.1+）\n` +
          `3. 无 NVIDIA 显卡`
        );
        return;
      }
    }

    // 切换设置项
    setEnableGPU(newVal);
    try {
      await API.system.setSetting('enableGPU', newVal);
      // 切换后提示用户需重启 AI 运行时
      window.alert(
        `AI 运行时 GPU 加速已${newVal ? '开启' : '关闭'}。\n\n` +
        `需要重启 AI 运行时才能生效。请关闭并重新打开应用，或在设置中点击"重启 AI 运行时"。`
      );
    } catch (err: any) {
      setEnableGPU(!newVal);  // 回滚 UI 状态
      window.alert(`切换 GPU 开关失败: ${err.message}`);
    }
  };

  useEffect(() => { fetchHealth(); fetchGpuStatus(); }, []);

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
                {/* 🔧 V8: AI 运行时依赖项 - 缺失包时显示"一键安装"按钮 */}
                {item.key === 'runtime' && health?.runtimePkgs &&
                  health.runtimePkgs.some(p => !p.installed) && (
                  <button
                    onClick={handleInstallMissingDeps}
                    disabled={installing}
                    className="h-7 px-3 rounded-md bg-accent/10 border border-accent/30 text-xs font-medium text-accent hover:bg-accent/20 transition-all cursor-pointer outline-none flex items-center gap-1 disabled:opacity-50"
                  >
                    {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    {installing ? '安装中...' : '一键安装'}
                  </button>
                )}
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

      {/* 🔧 V8: pip install 进度条 */}
      {installing && installProgress && (
        <div className="glass-card-sm p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-foreground">安装运行时依赖</div>
            <div className="text-xs text-muted-foreground">{installProgress.percent}%</div>
          </div>
          <div className="h-2 bg-bg-tertiary rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${installProgress.percent}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            {installProgress.message}
            {installProgress.current && installProgress.status !== 'done' && (
              <span className="text-accent ml-2">[{installProgress.current}]</span>
            )}
          </div>
          {installProgress.status === 'error' && installProgress.error && (
            <div className="text-xs text-accent-rose break-all">{installProgress.error}</div>
          )}
        </div>
      )}

      {/* 🚀 阶段 3: GPU 加速管理区（含开关 + 显卡型号 + CUDA 状态 + 安装进度） */}
      {!loading && (
        <div className="glass-card-sm p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap size={16} className={enableGPU ? 'text-accent-cyan' : 'text-muted-foreground'} />
              <div>
                <div className="text-sm font-semibold text-foreground">AI 运行时 GPU 加速</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  启用 NVIDIA CUDA 加速 PyTorch 推理（CLIP/SenseVoice/Demucs）
                </div>
              </div>
            </div>
            {/* GPU 开关 */}
            <button
              onClick={() => handleToggleEnableGPU(!enableGPU)}
              disabled={cudaInstalling}
              className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer outline-none disabled:opacity-50 ${
                enableGPU ? 'bg-accent-cyan' : 'bg-bg-tertiary'
              }`}
              title={enableGPU ? '点击关闭 GPU 加速' : '点击开启 GPU 加速'}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  enableGPU ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* GPU 状态信息 */}
          {gpuStatus && (
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="space-y-1">
                <div className="text-muted-foreground">显卡型号</div>
                <div className="text-foreground font-medium">
                  {gpuStatus.device_count > 0
                    ? gpuStatus.devices.map(d => d.name).join(', ')
                    : '未检测到 NVIDIA GPU'}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-muted-foreground">显存</div>
                <div className="text-foreground font-medium">
                  {gpuStatus.device_count > 0
                    ? gpuStatus.devices.map(d => `${(d.vram_mb / 1024).toFixed(1)} GB`).join(', ')
                    : '—'}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-muted-foreground">torch 版本</div>
                <div className={`font-medium ${gpuStatus.is_cuda_torch ? 'text-accent-cyan' : 'text-muted-foreground'}`}>
                  {gpuStatus.torch_version}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-muted-foreground">CUDA 状态</div>
                <div className={`font-medium ${
                  gpuStatus.cuda_available ? 'text-accent-green' : 'text-muted-foreground'
                }`}>
                  {gpuStatus.cuda_available
                    ? `可用 (CUDA ${gpuStatus.cuda_version})`
                    : gpuStatus.is_cuda_torch
                      ? 'CUDA 版 torch 但不可用（驱动问题？）'
                      : '不可用（CPU 版 torch）'}
                </div>
              </div>
            </div>
          )}

          {/* 未查询到 GPU 状态时显示提示 */}
          {!gpuStatus && (
            <div className="text-xs text-muted-foreground">
              GPU 状态查询中...（需 AI 运行时在线）
            </div>
          )}

          {/* "安装 CUDA 版" 按钮（仅当 needs_cuda_install=true 且未在安装中时显示） */}
          {gpuStatus?.needs_cuda_install && !cudaInstalling && (
            <button
              onClick={handleInstallCudaTorch}
              className="h-8 px-4 rounded-md bg-accent-cyan/10 border border-accent-cyan/30 text-xs font-medium text-accent-cyan hover:bg-accent-cyan/20 transition-all cursor-pointer outline-none flex items-center gap-1.5"
            >
              <Download size={12} />
              安装 CUDA 版 torch（约 2.5GB）
            </button>
          )}

          {/* CUDA 安装进度条 */}
          {cudaInstalling && cudaInstallProgress && (
            <div className="space-y-2 p-3 rounded-lg bg-bg-tertiary/50">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-foreground">
                  {cudaInstallProgress.current_step === 'uninstall_cpu' && '卸载 CPU 版 torch...'}
                  {cudaInstallProgress.current_step === 'install_cuda' && '下载安装 CUDA 版 torch...'}
                  {cudaInstallProgress.current_step === 'verify' && '验证 CUDA 安装...'}
                  {cudaInstallProgress.current_step === 'rollback' && '回滚到 CPU 版...'}
                  {!cudaInstallProgress.current_step && cudaInstallProgress.message}
                </div>
                <div className="text-xs text-muted-foreground">{cudaInstallProgress.percent}%</div>
              </div>
              <div className="h-2 bg-bg-tertiary rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    cudaInstallProgress.current_step === 'rollback'
                      ? 'bg-yellow-500'
                      : 'bg-accent-cyan'
                  }`}
                  style={{ width: `${cudaInstallProgress.percent}%` }}
                />
              </div>
              <div className="text-xs text-muted-foreground">{cudaInstallProgress.message}</div>
              {cudaInstallProgress.status === 'error' && cudaInstallProgress.error && (
                <div className="text-xs text-accent-rose break-all">{cudaInstallProgress.error}</div>
              )}
            </div>
          )}
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
