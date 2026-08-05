// 📁 路径: src/modules/settings/frontend/components/ModelTab.tsx
// 本地模型管理 Tab - V7 功能模块化重构
// 🔧 修复 M3：只管模型文件，运行时依赖去健康检查页查看
// V7：4 分类 Chip + 7 功能模块卡片（每张含模型文件详情 + 操作）
import React, { useState, useEffect, useMemo } from 'react';
import {
  Download, Trash2, Loader2, CheckCircle2, XCircle, AlertTriangle,
  Upload, FileSearch, Package, HardDrive,
} from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { API } from '@renderer/api';

/** 模型文件状态 */
type ModelFileStatus = 'not_downloaded' | 'downloaded' | 'downloading' | 'corrupted' | 'download_failed';

/** 模块整体状态 */
type ModuleStatus = 'ready' | 'partial' | 'missing';

/** 分类 key（与后端 MODEL_CATEGORIES 对齐） */
type CategoryId = 'audio' | 'asr' | 'vision';

/** 分类菜单项 */
interface CategoryOption {
  key: 'all' | CategoryId;
  label: string;
  icon: string;  // emoji
}

/** 单个模型文件（模块下的子项） */
interface ModelFile {
  id: string;
  name: string;           // 英文技术名
  displayName: string;    // 中文显示名
  description: string;
  version: string;
  status: ModelFileStatus;
  sizeBytes: number;
  downloadPath: string;
  remoteUrl: string;
  pythonPkg?: string;
}

/** 功能模块（对应一张卡片）
 * 🔧 修复 M3：删除 runtime 字段，模型管理只管模型文件
 */
interface ModuleCard {
  id: string;
  category: CategoryId;
  displayName: string;
  description: string;
  icon: string;
  required: 'builtin' | 'optional';
  sizeNote: string;
  models: ModelFile[];
  status: ModuleStatus;
  canUse: boolean;
}

/** 分类选项（顶部 Chip） */
const CATEGORY_OPTIONS: CategoryOption[] = [
  { key: 'all', label: '全部', icon: '📋' },
  { key: 'audio', label: '音频分离', icon: '🎵' },
  { key: 'asr', label: '语音识别', icon: '🎙️' },
  { key: 'vision', label: '视觉', icon: '👁️' },
];

/** 格式化字节大小为人类可读字符串 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 本地模型管理 Tab - V7 功能模块化版本
 * 🔧 修复 M3：只管模型文件，运行时依赖去健康检查页查看
 * 3 分类 Chip + 6 功能模块卡片（仅模型文件状态 + 操作）
 */
export const ModelTab: React.FC = () => {
  const [modules, setModules] = useState<ModuleCard[]>([]);
  const [activeCategory, setActiveCategory] = useState<'all' | CategoryId>('all');
  const [loading, setLoading] = useState(true);
  // 🔧 修复 P0-2：per-module 操作中状态 + 全局 toast 反馈，替代无反馈的 alert
  const [busyModuleId, setBusyModuleId] = useState<string | null>(null);
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);

  /** 显示 toast 提示（3 秒后自动消失） */
  const showToast = (type: 'success' | 'error' | 'info', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3000);
  };

  /** 加载功能模块列表（仅含模型文件状态） */
  const loadModules = async () => {
    setLoading(true);
    try {
      const list = await API.model.getModuleList();
      if (Array.isArray(list)) {
        setModules(list);
      }
    } catch (err) {
      console.error('[ModelTab] 加载模块列表失败:', err);
      showToast('error', `加载模块列表失败: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModules();
  }, []);

  /** 下载模块下所有缺失的模型文件 */
  const handleInstall = async (module: ModuleCard) => {
    // 找出所有未下载或损坏的模型文件
    const missing = module.models.filter(m =>
      m.status === 'not_downloaded' || m.status === 'corrupted' || m.status === 'download_failed'
    );
    // 🔧 修复 M3：canUse 现在仅基于模型文件，无需检查 runtime
    if (missing.length === 0) {
      // 模型文件齐全，无需操作
      showToast('info', `${module.displayName} 模型文件已齐全`);
      return;
    }
    // 🔧 修复 P0-2：标记 busy 状态，给用户即时反馈
    setBusyModuleId(module.id);
    showToast('info', `开始下载 ${module.displayName}（${missing.length} 个文件）...`);
    let successCount = 0;
    let failCount = 0;
    // 串行下载缺失的模型文件
    for (const m of missing) {
      setBusyModelId(m.id);
      try {
        await API.model.download(m.id);
        successCount++;
      } catch (err) {
        failCount++;
        console.error(`[ModelTab] 下载 ${m.id} 失败:`, err);
      }
    }
    setBusyModelId(null);
    setBusyModuleId(null);
    if (failCount === 0) {
      showToast('success', `${module.displayName} 安装完成（${successCount} 个文件）`);
    } else if (successCount === 0) {
      showToast('error', `${module.displayName} 安装失败（${failCount} 个文件失败）`);
    } else {
      showToast('error', `${module.displayName} 部分安装：${successCount} 成功 / ${failCount} 失败`);
    }
    // 刷新列表
    loadModules();
  };

  /** 卸载模块（删除所有模型文件） */
  const handleUninstall = async (module: ModuleCard) => {
    if (!window.confirm(`确认卸载「${module.displayName}」？\n将删除 ${module.models.length} 个模型文件。`)) return;
    setBusyModuleId(module.id);
    let successCount = 0;
    let failCount = 0;
    for (const m of module.models) {
      if (m.status === 'downloaded') {
        try {
          await API.model.uninstall(m.id);
          successCount++;
        } catch (err) {
          failCount++;
          console.error(`[ModelTab] 卸载 ${m.id} 失败:`, err);
        }
      }
    }
    setBusyModuleId(null);
    if (failCount === 0) {
      showToast('success', `${module.displayName} 已卸载（${successCount} 个文件）`);
    } else {
      showToast('error', `${module.displayName} 卸载部分失败：${successCount} 成功 / ${failCount} 失败`);
    }
    loadModules();
  };

  /** 导入本地模型文件（用户离线补模型）
   *  后端会弹 dialog 选文件 + 校验大小/MD5 + 复制到 resources/models/
   *  修复 P0-2：调用前显示"正在打开文件选择器..."给用户即时反馈
   */
  const handleImport = async (modelId: string) => {
    setBusyModelId(modelId);
    showToast('info', '正在打开文件选择器...');
    try {
      const result = await API.model.importFile(modelId);
      if (result?.status === 'canceled') {
        // 用户取消，不显示 toast
        return;
      }
      if (result?.status === 'downloaded') {
        showToast('success', `导入成功：${result.downloadPath}`);
        loadModules();
      } else {
        showToast('error', `导入失败：${result?.message || '未知错误'}`);
      }
    } catch (err: any) {
      showToast('error', `导入失败：${err.message || '校验不通过'}`);
    } finally {
      setBusyModelId(null);
    }
  };

  /** 按分类过滤模块 */
  const filteredModules = useMemo(() => {
    if (activeCategory === 'all') return modules;
    return modules.filter(m => m.category === activeCategory);
  }, [modules, activeCategory]);

  /** 统计 */
  const readyCount = modules.filter(m => m.canUse).length;
  const totalSizeBytes = modules.reduce((sum, m) =>
    sum + m.models.reduce((s, mod) => s + (mod.sizeBytes || 0), 0), 0);

  return (
    <div className="space-y-4 animate-fade-in" style={{ maxWidth: '1100px' }}>
      {/* 🔧 修复 P0-2：全局 toast 提示，替代无反馈的 alert */}
      {toast && (
        <div className={`
          fixed top-4 right-4 z-50 max-w-md px-4 py-2.5 rounded-lg border shadow-lg text-[12px] font-medium animate-fade-in
          ${toast.type === 'success'
            ? 'bg-accent-green/15 border-accent-green/30 text-accent-green'
            : toast.type === 'error'
              ? 'bg-accent-rose/15 border-accent-rose/30 text-accent-rose'
              : 'bg-accent/15 border-accent/30 text-accent'}
        `}>
          {toast.msg}
        </div>
      )}

      {/* 标题与全局操作 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">本地模型</div>
          <div className="text-xs text-muted-foreground">
            按功能模块管理 AI 模型文件 · 共 {modules.length} 个模块
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={loadModules} className="h-8 px-3 text-xs gap-1.5 border-border/50 hover:border-accent/40">
            <FileSearch size={13} /> 重新扫描
          </Button>
        </div>
      </div>

      {/* 分类菜单 - 顶部 Chip 切换 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {CATEGORY_OPTIONS.map(opt => {
          const isActive = activeCategory === opt.key;
          const count = opt.key === 'all'
            ? modules.length
            : modules.filter(m => m.category === opt.key).length;
          return (
            <button
              key={opt.key}
              onClick={() => setActiveCategory(opt.key)}
              className={`
                inline-flex items-center gap-1.5 h-7 px-3 rounded-full border text-xs font-medium transition-all cursor-pointer outline-none select-none
                ${isActive
                  ? 'bg-accent/15 border-accent text-accent shadow-sm shadow-accent/10'
                  : 'bg-muted/20 border-border/50 text-muted-foreground hover:bg-muted/40 hover:border-border'}
              `}
            >
              <span className="opacity-80">{opt.icon}</span>
              <span>{opt.label}</span>
              <span className={`text-xs px-1 rounded-full ${isActive ? 'bg-accent/20 text-accent' : 'bg-muted/40 text-muted-foreground/70'}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 加载中 */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-accent" />
          <span className="ml-3 text-[12px] text-muted-foreground">扫描磁盘...</span>
        </div>
      )}

      {/* 模块卡片网格 */}
      {!loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredModules.map(module => (
            <ModuleCardView
              key={module.id}
              module={module}
              busyModuleId={busyModuleId}
              busyModelId={busyModelId}
              onInstall={() => handleInstall(module)}
              onUninstall={() => handleUninstall(module)}
              onImport={handleImport}
            />
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!loading && filteredModules.length === 0 && (
        <div className="text-center py-10 text-[12px] text-muted-foreground/60">
          该分类下暂无模块
        </div>
      )}

      {/* 磁盘统计 */}
      <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t border-border/30">
        <span className="flex items-center gap-1.5">
          <HardDrive size={11} />
          模型文件占用：{formatBytes(totalSizeBytes)} · {readyCount}/{modules.length} 个模块可用
        </span>
      </div>
    </div>
  );
};

/**
 * 功能模块卡片
 * 🔧 修复 M3：只显示模型文件状态，删除运行时相关 UI
 * 修复 P0-2：接受 busyModuleId/busyModelId，按钮在 busy 时显示 spinner 并 disabled
 */
const ModuleCardView: React.FC<{
  module: ModuleCard;
  busyModuleId: string | null;
  busyModelId: string | null;
  onInstall: () => void;
  onUninstall: () => void;
  onImport: (modelId: string) => void;
}> = ({ module, busyModuleId, busyModelId, onInstall, onUninstall, onImport }) => {
  const someReady = module.models.some(m => m.status === 'downloaded');
  const canUse = module.canUse;
  const isModuleBusy = busyModuleId === module.id;

  /** 获取模块整体状态文案与图标（M3：仅基于模型文件） */
  const getStatusDisplay = () => {
    if (canUse) {
      return { icon: <CheckCircle2 size={12} />, text: '已就绪', color: 'text-accent-green' };
    }
    if (someReady) {
      return { icon: <AlertTriangle size={12} />, text: '部分就绪', color: 'text-yellow-500' };
    }
    return { icon: <XCircle size={12} />, text: '未安装', color: 'text-muted-foreground' };
  };
  const statusDisp = getStatusDisplay();

  return (
    <div className={`
      glass-card-sm p-4 flex flex-col gap-3 transition-all
      ${canUse ? 'border-accent-green/20'
        : someReady ? 'border-yellow-500/20'
        : 'border-border/40'}
    `}>
      {/* 顶部：图标 + 名称 + 必装/可选标签 + 状态 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <div className="text-xl leading-none mt-0.5">{module.icon}</div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className="text-[13px] font-semibold text-foreground truncate">{module.displayName}</div>
              {module.required === 'builtin' && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-accent-green/15 text-accent-green font-medium">
                  必装·内置
                </span>
              )}
              {module.required === 'optional' && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground">
                  可选
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{module.description}</div>
          </div>
        </div>
        <div className={`flex items-center gap-1 text-xs font-medium ${statusDisp.color} flex-shrink-0`}>
          {statusDisp.icon}
          {statusDisp.text}
        </div>
      </div>

      {/* 体积说明 */}
      <div className="text-xs text-muted-foreground/70">
        📦 {module.sizeNote}
      </div>

      {/* 模型文件列表 */}
      <div className="space-y-1.5 bg-muted/15 rounded-lg p-2.5">
        <div className="text-xs text-muted-foreground/80 font-medium uppercase tracking-wide flex items-center gap-1">
          <Package size={10} /> 模型文件（{module.models.length}）
        </div>
        {module.models.map(m => (
          <div key={m.id} className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {m.status === 'downloaded' ? (
                <CheckCircle2 size={11} className="text-accent-green flex-shrink-0" />
              ) : m.status === 'corrupted' ? (
                <AlertTriangle size={11} className="text-accent-rose flex-shrink-0" />
              ) : (
                <XCircle size={11} className="text-muted-foreground/50 flex-shrink-0" />
              )}
              <span className="text-foreground truncate">{m.displayName}</span>
              <span className="text-muted-foreground/60 text-xs font-mono truncate">{m.name}</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs text-muted-foreground">v{m.version}</span>
              <span className="text-xs text-muted-foreground">
                {m.sizeBytes > 0 ? formatBytes(m.sizeBytes) : '—'}
              </span>
              {m.status === 'downloaded' && (
                <button
                  onClick={() => onImport(m.id)}
                  className="text-xs text-accent hover:text-accent-cyan transition-colors"
                  title="导入替换此模型文件"
                >
                  导入
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 已下载模型的路径信息（仅展示第一个已下载文件） */}
      {module.models.filter(m => m.status === 'downloaded' && m.downloadPath).slice(0, 1).map(m => (
        <div
          key={`path-${m.id}`}
          className="text-xs text-muted-foreground/70 bg-muted/20 rounded px-2 py-1.5 font-mono break-all"
          title={m.downloadPath}
        >
          <span className="text-muted-foreground/50">路径：</span>{m.downloadPath}
        </div>
      ))}

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 pt-1">
        {/* 主按钮：安装/卸载 状态机 */}
        {canUse ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onUninstall}
            disabled={isModuleBusy}
            className="h-7 text-xs gap-1 text-muted-foreground hover:text-accent-rose px-2.5 disabled:opacity-50"
          >
            {isModuleBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            {isModuleBusy ? '处理中...' : '卸载'}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={onInstall}
            disabled={isModuleBusy}
            className="h-7 text-xs gap-1 border-accent/30 text-accent hover:bg-accent/10 px-2.5 disabled:opacity-50"
          >
            {isModuleBusy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {isModuleBusy ? '下载中...' : '安装'}
          </Button>
        )}

        {/* 导入按钮（始终可用，用于离线补模型） */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onImport(module.models[0]?.id || module.id)}
          disabled={isModuleBusy}
          className="h-7 text-xs gap-1 text-muted-foreground hover:text-accent px-2.5 disabled:opacity-50"
        >
          {busyModelId === (module.models[0]?.id || module.id) ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Upload size={12} />
          )}
          {busyModelId === (module.models[0]?.id || module.id) ? '选择中...' : '导入'}
        </Button>
      </div>
    </div>
  );
};
