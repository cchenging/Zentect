// 📁 路径: src/modules/settings/frontend/components/ModelTab.tsx
// 本地模型管理 Tab - V5 细化分类菜单 + 卡片网格
import React, { useState, useEffect, useMemo } from 'react';
import { Download, Trash2, Loader2, Pause, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { API } from '@renderer/api';

/** 模型状态类型 */
type ModelStatus = 'missing' | 'downloading' | 'ready' | 'updating' | 'error';

/** 模型分类key（与后端 local_models.type 对齐） */
type ModelCategory = 'asr' | 'tts' | 'vision' | 'audio' | 'emotion';

/** 分类菜单项 */
interface CategoryOption {
  key: 'all' | ModelCategory;
  label: string;
  /** lucide 图标组件（用任意小写字母占位，实际渲染用 JSX） */
  icon: React.ReactNode;
}

/** 模型条目 */
interface ModelItem {
  id: string;
  /** 中文显示名 */
  label: string;
  /** 英文技术名（对应后端 local_models.name） */
  englishName: string;
  /** 估算大小（磁盘未读到时兜底） */
  size: string;
  /** 磁盘实际字节数（从后端 size_bytes 读取） */
  sizeBytes: number;
  /** 用途描述 */
  description: string;
  /** 后端 type 字段：asr/tts/vision/audio/emotion */
  category: ModelCategory;
  status: ModelStatus;
  progress: number;
  version: string;
  /** 下载路径 */
  downloadPath: string;
  /** 下载完成时间 */
  downloadedAt: string;
  /** 对应的 Python 包名（用于依赖徽章，无则不显示） */
  pythonPkg?: string;
}

/**
 * V5 细化版本地模型列表（21 条，与后端 ModelService MODEL_DEFINITIONS 对齐）
 * 每个具体模型文件一条记录，按 category 分类展示
 *   - asr(2): Whisper Base, SenseVoice ONNX
 *   - tts(8): MOSS 7 个子模型 + GPT-SoVITS
 *   - vision(7): Buffalo L 5 个子模型 + YunNet + SFace
 *   - audio(3): MDX-Net HQ3, MDX-Net HQ4, Demucs htdemucs
 *   - emotion(1): 情绪分析模型（暂未实现）
 */
const DEFAULT_MODELS: Omit<ModelItem, 'status' | 'progress'>[] = [
  // === ASR 语音识别 ===
  { id: 'whisper_base', label: 'Whisper Base 基座模型', englishName: 'Whisper Base', size: '~150MB', sizeBytes: 0, description: 'Whisper.cpp 中文语音识别基座（ggml 格式）', category: 'asr', version: '1.0', downloadPath: '', downloadedAt: '' },
  { id: 'sensevoice_onnx', label: 'SenseVoice 量化模型', englishName: 'SenseVoice ONNX', size: '~80MB', sizeBytes: 0, description: '中/日/韩/粤 多语言语音识别', category: 'asr', version: '1.0', downloadPath: '', downloadedAt: '', pythonPkg: 'funasr' },
  // === TTS 语音合成 ===
  { id: 'moss_tokenizer_encode', label: 'MOSS 音频分词器编码端', englishName: 'MOSS Audio Tokenizer Encode', size: '~20MB', sizeBytes: 0, description: 'MOSS TTS 音频分词器编码端', category: 'tts', version: '1.0', downloadPath: '', downloadedAt: '' },
  { id: 'moss_tokenizer_decode_full', label: 'MOSS 音频分词器完整解码端', englishName: 'MOSS Audio Tokenizer Decode Full', size: '~20MB', sizeBytes: 0, description: 'MOSS TTS 音频分词器完整解码端', category: 'tts', version: '1.0', downloadPath: '', downloadedAt: '' },
  { id: 'moss_tokenizer_decode_step', label: 'MOSS 音频分词器逐步解码端', englishName: 'MOSS Audio Tokenizer Decode Step', size: '~20MB', sizeBytes: 0, description: 'MOSS TTS 音频分词器逐步解码端', category: 'tts', version: '1.0', downloadPath: '', downloadedAt: '' },
  { id: 'moss_tts_prefill', label: 'MOSS TTS 100M 预填充', englishName: 'MOSS TTS 100M Prefill', size: '~40MB', sizeBytes: 0, description: 'MOSS TTS 100M 预填充模型', category: 'tts', version: '1.0', downloadPath: '', downloadedAt: '' },
  { id: 'moss_tts_decode', label: 'MOSS TTS 100M 逐步解码', englishName: 'MOSS TTS 100M Decode', size: '~40MB', sizeBytes: 0, description: 'MOSS TTS 100M 逐步解码模型', category: 'tts', version: '1.0', downloadPath: '', downloadedAt: '' },
  { id: 'moss_tts_local_decoder', label: 'MOSS TTS 100M 本地解码器', englishName: 'MOSS TTS 100M Local Decoder', size: '~10MB', sizeBytes: 0, description: 'MOSS TTS 100M 本地解码器', category: 'tts', version: '1.0', downloadPath: '', downloadedAt: '' },
  { id: 'moss_tokenizer_model', label: 'MOSS TTS 分词器', englishName: 'MOSS TTS Tokenizer', size: '~1MB', sizeBytes: 0, description: 'MOSS TTS SentencePiece 分词器', category: 'tts', version: '1.0', downloadPath: '', downloadedAt: '' },
  { id: 'sovits', label: 'GPT-SoVITS', englishName: 'GPT-SoVITS', size: '~200MB', sizeBytes: 0, description: 'TTS 增强（音色克隆，pip 包内置）', category: 'tts', version: '1.0', downloadPath: '', downloadedAt: '', pythonPkg: 'sovits' },
  // === Vision 视觉识别 ===
  { id: 'buffalo_l_det_10g', label: 'Buffalo L 人脸检测主干', englishName: 'Buffalo L det_10g', size: '~10MB', sizeBytes: 0, description: 'InsightFace Buffalo L 人脸检测主干网络', category: 'vision', version: '1.0', downloadPath: '', downloadedAt: '', pythonPkg: 'insightface' },
  { id: 'buffalo_l_w600k_r50', label: 'Buffalo L 人脸特征嵌入', englishName: 'Buffalo L w600k_r50', size: '~5MB', sizeBytes: 0, description: 'InsightFace Buffalo L 人脸特征嵌入', category: 'vision', version: '1.0', downloadPath: '', downloadedAt: '', pythonPkg: 'insightface' },
  { id: 'buffalo_l_1k3d68', label: 'Buffalo L 3D关键点', englishName: 'Buffalo L 1k3d68', size: '~3MB', sizeBytes: 0, description: 'InsightFace Buffalo L 3D 人脸关键点', category: 'vision', version: '1.0', downloadPath: '', downloadedAt: '', pythonPkg: 'insightface' },
  { id: 'buffalo_l_2d106det', label: 'Buffalo L 2D 106点', englishName: 'Buffalo L 2d106det', size: '~2MB', sizeBytes: 0, description: 'InsightFace Buffalo L 2D 106点关键点', category: 'vision', version: '1.0', downloadPath: '', downloadedAt: '', pythonPkg: 'insightface' },
  { id: 'buffalo_l_genderage', label: 'Buffalo L 性别年龄', englishName: 'Buffalo L genderage', size: '~1MB', sizeBytes: 0, description: 'InsightFace Buffalo L 性别年龄估计', category: 'vision', version: '1.0', downloadPath: '', downloadedAt: '', pythonPkg: 'insightface' },
  { id: 'yunnet_detection', label: 'YunNet 人脸检测', englishName: 'YunNet Face Detection', size: '~340KB', sizeBytes: 0, description: 'YunNet 人脸检测模型 (2023年3月版)', category: 'vision', version: '1.0', downloadPath: '', downloadedAt: '' },
  { id: 'sface_recognition', label: 'SFace 人脸识别', englishName: 'SFace Face Recognition', size: '~520KB', sizeBytes: 0, description: 'SFace 人脸识别特征提取', category: 'vision', version: '1.0', downloadPath: '', downloadedAt: '' },
  // === Audio 音频分离 ===
  { id: 'mdx_hq3', label: 'UVR MDX-Net HQ3', englishName: 'MDX-Net HQ 3', size: '~100MB', sizeBytes: 0, description: 'UVR MDX-Net 人声/伴奏分离模型 HQ3', category: 'audio', version: '1.0', downloadPath: '', downloadedAt: '', pythonPkg: 'audio_separator' },
  { id: 'mdx_hq4', label: 'UVR MDX-Net HQ4', englishName: 'MDX-Net HQ 4', size: '~100MB', sizeBytes: 0, description: 'UVR MDX-Net 人声/伴奏分离模型 HQ4', category: 'audio', version: '1.0', downloadPath: '', downloadedAt: '', pythonPkg: 'audio_separator' },
  { id: 'demucs_htdemucs', label: 'Demucs htdemucs', englishName: 'Demucs htdemucs', size: 'pip 包内置', sizeBytes: 0, description: 'Demucs htdemucs 4-stem 分离模型（随 demucs 安装）', category: 'audio', version: '1.0', downloadPath: '', downloadedAt: '', pythonPkg: 'demucs' },
  // === Emotion 情绪分析 ===
  { id: 'emotion', label: '情绪分析模型', englishName: 'Emotion Model', size: '暂未实现', sizeBytes: 0, description: '文本+音频情绪分析（暂未实现）', category: 'emotion', version: '1.0', downloadPath: '', downloadedAt: '' },
];

/** Python 依赖检查结果 */
type DepsInfo = Record<string, { installed: boolean; version: string | null; display_name: string }>;

/** 分类菜单配置（顺序即 UI 顺序） */
const CATEGORY_OPTIONS: CategoryOption[] = [
  { key: 'all', label: '全部', icon: <span className="text-[11px]">≡</span> },
  { key: 'asr', label: '语音识别', icon: <span className="text-[11px]">ASR</span> },
  { key: 'tts', label: '语音合成', icon: <span className="text-[11px]">TTS</span> },
  { key: 'vision', label: '视觉识别', icon: <span className="text-[11px]">👁</span> },
  { key: 'audio', label: '音频分离', icon: <span className="text-[11px]">♪</span> },
  { key: 'emotion', label: '情绪分析', icon: <span className="text-[11px]">♥</span> },
];

/**
 * 格式化字节数为人类可读字符串
 * @param bytes 字节数
 * @returns 形如 "147.9 MB" / "338.9 KB" / "-"
 */
const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

/**
 * 格式化 ISO 时间为本地短日期
 * @param iso ISO 时间字符串
 * @returns 形如 "07-25 14:30" 或 "-"
 */
const formatDateTime = (iso: string): string => {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch { return '-'; }
};

/**
 * 本地模型管理 Tab
 * V5：分类菜单（顶部 Chip 切换）+ 卡片网格；21 条具体模型记录
 */
export const ModelTab: React.FC = () => {
  const [models, setModels] = useState<ModelItem[]>(
    DEFAULT_MODELS.map(m => ({ ...m, status: 'missing' as ModelStatus, progress: 0 }))
  );
  /** 当前选中分类，'all' 表示全部 */
  const [activeCategory, setActiveCategory] = useState<'all' | ModelCategory>('all');
  /** Python 依赖检查结果（仅用于卡片徽章，主面板已在 HealthPage） */
  const [deps, setDeps] = useState<DepsInfo | null>(null);

  /** 按当前分类过滤模型 */
  const filteredModels = useMemo(() => {
    if (activeCategory === 'all') return models;
    return models.filter(m => m.category === activeCategory);
  }, [models, activeCategory]);

  /** 从后端加载模型状态 + Python 依赖（用于卡片徽章） */
  useEffect(() => {
    loadModelStatus();
    loadDeps();
    API.model.onDownloadProgress((payload) => {
      setModels(prev => prev.map(m =>
        m.id === payload.modelId
          ? { ...m, progress: payload.progress, status: payload.progress >= 100 ? 'ready' : 'downloading' }
          : m
      ));
    });
    return () => { API.model.offDownloadProgress(); };
  }, []);

  /** 加载模型状态 */
  const loadModelStatus = async () => {
    try {
      const list = await API.model.getList();
      if (Array.isArray(list) && list.length > 0) {
        setModels(prev => prev.map(m => {
          const serverModel = list.find((s: any) => s.model_id === m.id || s.id === m.id);
          if (serverModel) {
            // 🔧 修复 P0：后端 scanDiskModels 写入 status='downloaded'，旧版只认 'ready' → 已下载模型识别不到
            //   修复后：同时接受 'downloaded' / 'ready' / is_installed 三种已下载信号
            const isReady = serverModel.status === 'downloaded'
              || serverModel.status === 'ready'
              || serverModel.is_installed === true;
            return {
              ...m,
              status: isReady ? 'ready' : m.status,
              version: serverModel.version || m.version,
              englishName: serverModel.name || m.englishName,
              sizeBytes: serverModel.size_bytes || 0,
              downloadPath: serverModel.download_path || '',
              downloadedAt: serverModel.downloaded_at || '',
            };
          }
          return m;
        }));
      }
    } catch {}
  };

  /** 加载 Python 依赖（仅用于卡片徽章显示） */
  const loadDeps = async () => {
    try {
      const res = await API.ai.checkDeps();
      setDeps(res?.deps || null);
    } catch {
      setDeps(null);
    }
  };

  /** 下载模型 */
  const handleDownload = async (modelId: string) => {
    setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'downloading', progress: 0 } : m));
    try {
      await API.model.download(modelId);
      setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'ready', progress: 100 } : m));
      // 下载完成后重新拉取列表，刷新 sizeBytes/downloadPath/downloadedAt
      loadModelStatus();
    } catch { setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'error' } : m)); }
  };

  /** 卸载模型 */
  const handleUninstall = async (modelId: string) => {
    if (!window.confirm('确定要卸载此模型吗？')) return;
    try {
      await API.model.uninstall(modelId);
      setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'missing', progress: 0, sizeBytes: 0, downloadPath: '', downloadedAt: '' } : m));
    } catch {}
  };

  /** 全部下载（仅当前分类下的 missing） */
  const handleDownloadAll = async () => {
    const missing = filteredModels.filter(m => m.status === 'missing');
    for (const m of missing) { await handleDownload(m.id); }
  };

  /** 全部更新（仅当前分类下的 ready） */
  const handleUpdateAll = async () => {
    const ready = filteredModels.filter(m => m.status === 'ready');
    const ids = ready.map(m => m.id);
    try { await API.model.batchUpdate(ids); } catch {}
  };

  /** 获取状态图标 */
  const getStatusIcon = (status: ModelStatus) => {
    switch (status) {
      case 'ready': return <div className="w-6 h-6 rounded-full bg-accent-green/20 flex items-center justify-center text-accent-green text-[11px]">&#x2713;</div>;
      case 'downloading': case 'updating': return <Loader2 size={16} className="text-accent animate-spin" />;
      case 'error': return <div className="w-6 h-6 rounded-full bg-accent-rose/20 flex items-center justify-center text-accent-rose text-[11px]">&#x2715;</div>;
      default: return <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center" />;
    }
  };

  /** 获取 Python 依赖徽章 */
  const getDepBadge = (model: ModelItem) => {
    if (!model.pythonPkg) return null;
    if (!deps) return <span className="text-[10px] text-muted-foreground/60">Python 离线</span>;
    const dep = deps[model.pythonPkg];
    if (!dep) return null;
    return dep.installed
      ? <span className="inline-flex items-center gap-1 text-[10px] text-accent-green"><CheckCircle2 size={11} />{dep.version && dep.version !== 'unknown' ? `v${dep.version}` : '已安装'}</span>
      : <span className="inline-flex items-center gap-1 text-[10px] text-accent-rose"><XCircle size={11} />未安装</span>;
  };

  const readyCount = models.filter(m => m.status === 'ready').length;
  const usedBytes = models.reduce((sum, m) => sum + (m.sizeBytes || 0), 0);

  return (
    <div className="space-y-4 animate-fade-in" style={{ maxWidth: '1100px' }}>
      {/* 标题与全局操作 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">本地模型</div>
          <div className="text-[11px] text-muted-foreground">管理 AI 模型文件 · 共 {models.length} 个</div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleDownloadAll} className="h-8 px-3 text-xs gap-1.5 border-accent/30 text-accent hover:bg-accent/10">
            <Download size={13} /> 下载缺失
          </Button>
          <Button variant="outline" onClick={handleUpdateAll} className="h-8 px-3 text-xs gap-1.5 border-border/50 hover:border-accent-cyan/40 hover:text-accent-cyan">
            更新已装
          </Button>
        </div>
      </div>

      {/* 分类菜单 - 顶部 Chip 切换 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {CATEGORY_OPTIONS.map(opt => {
          const isActive = activeCategory === opt.key;
          /** 该分类下模型数量（all 显示总数） */
          const count = opt.key === 'all'
            ? models.length
            : models.filter(m => m.category === opt.key).length;
          return (
            <button
              key={opt.key}
              onClick={() => setActiveCategory(opt.key)}
              className={`
                inline-flex items-center gap-1.5 h-7 px-3 rounded-full border text-[11px] font-medium transition-all cursor-pointer outline-none select-none
                ${isActive
                  ? 'bg-accent/15 border-accent text-accent shadow-sm shadow-accent/10'
                  : 'bg-muted/20 border-border/50 text-muted-foreground hover:bg-muted/40 hover:border-border'}
              `}
            >
              <span className="opacity-80">{opt.icon}</span>
              <span>{opt.label}</span>
              <span className={`text-[10px] px-1 rounded-full ${isActive ? 'bg-accent/20 text-accent' : 'bg-muted/40 text-muted-foreground/70'}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 模型卡片网格 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {filteredModels.map(model => (
          <div
            key={model.id}
            className={`
              glass-card-sm p-4 flex flex-col gap-2.5 transition-all
              ${model.status === 'ready'
                ? 'border-accent-green/20'
                : model.status === 'downloading'
                  ? 'border-accent/30'
                  : 'border-border/40'}
            `}
          >
            {/* 顶部：状态图标 + 名称 + 操作按钮 */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                {getStatusIcon(model.status)}
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-foreground truncate">{model.label}</div>
                  <div className="text-[10px] text-muted-foreground/70 font-mono truncate">{model.englishName}</div>
                </div>
              </div>
              <div className="flex-shrink-0">
                {model.status === 'missing' && (
                  <Button variant="outline" size="sm" onClick={() => handleDownload(model.id)} className="h-7 text-[11px] gap-1 border-accent/30 text-accent hover:bg-accent/10 px-2.5">
                    <Download size={12} /> 下载
                  </Button>
                )}
                {model.status === 'downloading' && (
                  <Button variant="ghost" size="sm" className="h-7 text-[11px] gap-1 text-muted-foreground px-2.5">
                    <Pause size={12} /> 暂停
                  </Button>
                )}
                {model.status === 'ready' && (
                  <Button variant="ghost" size="sm" onClick={() => handleUninstall(model.id)} className="h-7 text-[11px] gap-1 text-muted-foreground hover:text-accent-rose px-2.5">
                    <Trash2 size={12} /> 卸载
                  </Button>
                )}
                {model.status === 'error' && (
                  <Button variant="outline" size="sm" onClick={() => handleDownload(model.id)} className="h-7 text-[11px] gap-1 border-accent-rose/30 text-accent-rose hover:bg-accent-rose/10 px-2.5">
                    <Download size={12} /> 重试
                  </Button>
                )}
              </div>
            </div>

            {/* 用途描述 */}
            <div className="text-[12px] text-muted-foreground">{model.description}</div>

            {/* 下载进度条（仅 downloading 状态显示） */}
            {model.status === 'downloading' && (
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${model.progress}%` }} />
                </div>
                <span className="text-[10px] text-accent">{model.progress}%</span>
              </div>
            )}

            {/* 元信息网格：版本 / 大小 / Python 依赖 */}
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/20">
              <div>
                <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wide">版本</div>
                <div className="text-[11px] text-muted-foreground font-mono">v{model.version}</div>
              </div>
              <div>
                <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wide">大小</div>
                <div className="text-[11px] text-muted-foreground">
                  {model.sizeBytes > 0 ? (
                    <span className="text-accent-green/90">{formatBytes(model.sizeBytes)}</span>
                  ) : (
                    <span className="text-muted-foreground/60">{model.size}</span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wide">Python 依赖</div>
                <div>{getDepBadge(model) || <span className="text-[10px] text-muted-foreground/40">-</span>}</div>
              </div>
            </div>

            {/* 下载信息（仅 ready 状态显示） */}
            {model.status === 'ready' && model.downloadPath && (
              <div className="text-[10px] text-muted-foreground/70 bg-muted/20 rounded px-2 py-1.5 font-mono break-all" title={model.downloadPath}>
                <span className="text-muted-foreground/50">路径：</span>{model.downloadPath}
                {model.downloadedAt && (
                  <span className="text-muted-foreground/50 ml-2">· {formatDateTime(model.downloadedAt)}</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 空状态（分类下无模型） */}
      {filteredModels.length === 0 && (
        <div className="text-center py-10 text-[12px] text-muted-foreground/60">
          该分类下暂无模型
        </div>
      )}

      {/* 磁盘统计 */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-2 border-t border-border/30">
        <span>
          已用空间：{usedBytes > 0 ? formatBytes(usedBytes) : (readyCount > 0 ? `~${readyCount * 80}MB` : '0MB')} / 共 {readyCount}/{models.length} 个已下载
        </span>
      </div>
    </div>
  );
};
