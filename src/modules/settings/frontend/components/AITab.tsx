// AI 服务配置 Tab - V3 设计系统风格
// Provider 卡片（扁平式，不可展开）+ 管线映射 + TTS 配置
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Eye, EyeOff, Server, Play, ExternalLink, Zap, Plus, Trash2 } from 'lucide-react';
import { Input } from '@renderer/components/ui/input';
import { Button } from '@renderer/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select';
import { FormField } from '@renderer/components/ui/form-field';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@renderer/components/ui/dialog';
import { PROVIDER_CONFIGS } from '../../ai-config/backend/AiConfigService';
import { API } from '@renderer/api';
import { looksEncryptedValue } from '../../../../shared/utils/credentialFormat';

interface AITabProps {
  data: any;
  onUpdate: (section: string, key: string, value: any) => void;
  onTest: (type: string, providerName: string, configData: any, saveKey?: string) => void;
  onTestTTS: () => void;
  isTesting: boolean;
  modelPool: string[];
  apiProfiles?: any[];
  profileBindings?: any[];
}

/* ====== Provider 图标映射 ====== */
const PROVIDER_ICON_MAP: Record<string, { className: string; text: string }> = {
  doubao:  { className: 'bg-[rgba(0,212,170,0.12)] text-[#00d4aa]', text: '方' },
  deepseek:{ className: 'bg-[rgba(79,143,247,0.12)] text-[#4f8ff7]', text: 'D' },
  qwen:    { className: 'bg-[rgba(108,60,252,0.12)] text-[#6c3cfc]', text: '千' },
  hunyuan: { className: 'bg-[rgba(0,198,255,0.12)] text-[#00c6ff]', text: '混' },
  custom:  { className: 'bg-[rgba(245,158,11,0.12)] text-[#f59e0b]', text: '∞' },
};

const getIcon = (presetType: string) =>
  PROVIDER_ICON_MAP[presetType] || PROVIDER_ICON_MAP.custom;

/**
 * 剥离 Electron IPC 的报错包装，只留业务消息
 *
 * `ipcRenderer.invoke` 会把主进程抛出的 Error 包成
 * `Error invoking remote method 'apiProfile:update': Error: <原文>`，
 * 直接展示给用户太吵；此处剥掉两层前缀（剥不出则原样返回）。
 */
const cleanIpcErrorMessage = (e: any): string => {
  const raw = String(e?.message || e || '保存失败');
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    || '保存失败';
};

/* ====== 完整管线节点定义（9 个节点） ====== */
const ALL_PIPELINE_NODES = [
  // LLM 节点：使用上方已配置的云模型
  { taskType: 'visual',    label: '视觉理解',  useModelPool: true, icon: '👁', desc: '视频画面分析与描述' },
  { taskType: 'script',    label: '脚本生成',  useModelPool: true, icon: '✍', desc: '生成解说文案' },
  { taskType: 'translate', label: '翻译',      useModelPool: true, icon: '🌐', desc: '多语言文案翻译' },
  { taskType: 'helper',    label: '对话Agent', useModelPool: true, icon: '🤖', desc: '辅助对话与推理' },
  { taskType: 'chat',      label: '聊天对话',  useModelPool: true, icon: '💬', desc: '用户交互聊天' },
  { taskType: 'sentiment', label: '情绪识别',  useModelPool: true, icon: '🎭', desc: '台词情感分析' },
  // 本地节点：使用本地引擎，不走云 API
  { taskType: 'audio',     label: '音频处理',  localOptions: ['本地轻量模型', 'Demucs', 'MDX-Net'], icon: '🎵', desc: '人声/伴奏分离' },
  { taskType: 'asr',       label: '语音识别',  localOptions: ['Paraformer 中文', 'Faster-Whisper 多语言'], icon: '🎙', desc: '语音转文字' },
  // 禁用节点：由下方独立配置决定
  { taskType: 'tts',       label: '语音合成',  hint: '由下方语音合成配置决定', disabled: true, icon: '🔊', desc: '文字转语音' },
] as const;

/* ====== 模型分类（拉取列表的筛选维度） ====== */
const MODEL_CATEGORIES = ['全部', '视觉', '语音', '生图/视频', '向量/重排', '文本'] as const;
/**
 * 按小写关键词给模型名归类，供筛选 chip 使用
 * 顺序敏感：先匹配到的先返回（如 qwen-vl-max 归「视觉」而非「文本」）
 */
function classifyModel(name: string): string {
  const n = name.toLowerCase();
  if (/(embedding|rerank)/.test(n)) return '向量/重排';
  if (/(tts|asr|audio|speech|livetranslate|s2s|voice)/.test(n)) return '语音';
  if (/(image|seedream|seedance|video|^wan)/.test(n)) return '生图/视频';
  if (/(vl|omni|qvq|ocr)/.test(n)) return '视觉';
  return '文本';
}

/* ====== Toggle Switch ====== */
const ToggleSwitch: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ checked, onChange, disabled }) => (
  <label className={`relative w-[34px] h-[19px] inline-block ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only" disabled={disabled} />
    <span className={`absolute inset-0 rounded-full transition-colors duration-200 ${checked ? 'bg-[var(--accent-green)]' : 'bg-white/10'}`} />
    <span className={`absolute w-[13px] h-[13px] left-[3px] top-[3px] bg-white rounded-full transition-transform duration-200 ${checked ? 'translate-x-[15px]' : ''}`} />
  </label>
);

/* ====== PasswordField（TTS 区复用） ====== */
const PasswordField = ({ label, value, onChange, onCheck, linkUrl, placeholder = "sk-...", forceShow }: any) => {
  const [localShow, setLocalShow] = useState(false);
  const [touched, setTouched] = useState(false);
  const isRevealed = forceShow || localShow;
  const hasValue = !!value;

  const validateApiKey = (val: string): string | null => {
    if (touched && (!val || val.trim() === '')) return 'API Key 不能为空';
    if (val && val.trim().length < 10) return 'API Key 格式不正确，长度不足';
    return null;
  };

  const error = validateApiKey(value);
  const isValid = touched && hasValue && !error;

  return (
    <FormField label={label} error={error} valid={isValid}>
      <div className="flex items-center gap-2">
        {hasValue && !isRevealed && <span className="badge-success shrink-0">已配置</span>}
        <div className="relative flex-1">
          <Input
            type={isRevealed ? 'text' : 'password'}
            value={value || ''}
            onChange={(e) => { onChange(e); if (!touched) setTouched(true); }}
            onBlur={() => setTouched(true)}
            placeholder={placeholder}
            className={`text-xs bg-bg-secondary h-9 pr-8 w-full border-border/50 ${error ? 'border-accent-rose/50' : ''}`}
          />
          {!forceShow && (
            <button type="button" onClick={() => setLocalShow(!localShow)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground outline-none cursor-pointer">
              {isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          )}
        </div>
        <Button variant="outline" onClick={onCheck} className="h-9 text-xs text-accent-cyan hover:text-accent-cyan border-accent-cyan/20 bg-accent-cyan/5 hover:bg-accent-cyan/10 px-4 shadow-none shrink-0 gap-1.5">
          <Server size={13} /> 检测
        </Button>
      </div>
      {linkUrl && (
        <div className="text-xs mt-0.5 pl-0.5">
          <span className="text-muted-foreground mr-1.5">没有密钥？</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.open(linkUrl, '_blank'); }} className="text-accent hover:underline cursor-pointer">点击获取</a>
        </div>
      )}
    </FormField>
  );
};

/* ====== AI 服务配置 Tab ====== */
export const AITab: React.FC<AITabProps> = ({ data, onUpdate, onTest, onTestTTS, isTesting: _isTesting, modelPool: _modelPool, apiProfiles: propProfiles, profileBindings: propBindings }) => {
  const aiData = data || {};
  const [currentTts, setCurrentTts] = useState(aiData.ttsProvider || 'edge');

  /* ---------- Provider 卡片状态 ---------- */
  const [internalApiProfiles, setApiProfiles] = useState<any[]>([]);
  const [internalBindings, setBindings] = useState<Record<string, any>>({});

  // 🔧 修复 Bug2：始终使用 internalBindings，避免 propBindings 派生对象导致 setBindings 不生效
  const apiProfiles = internalApiProfiles;
  const bindings = internalBindings;

  /* ---------- Modal 状态 ---------- */
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStep, setModalStep] = useState<'provider' | 'form'>('provider');
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  /** 本次弹窗是「新增」还是「编辑既有配置」—— 新增流会在选定供应商时建草稿行，
   *  因此不能再用 `editingProfileId` 判断新增（草稿行一建它就非空了） */
  const [isNewProfile, setIsNewProfile] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formAlias, setFormAlias] = useState('');
  const [formModels, setFormModels] = useState<string[]>([]);
  const [customModelsText, setCustomModelsText] = useState('');
  const [formKeyVisible, setFormKeyVisible] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'fail'>('idle');
  const [apiKeyChanged, setApiKeyChanged] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  /** 该配置的 Key 已存在但解不开（ADR-004 G4）：留空 + 横幅，绝不回显密文 */
  const [credentialWarning, setCredentialWarning] = useState('');
  /** 保存失败原因（此前 catch{} 静默吞掉，用户看不到后端拒绝） */
  const [saveError, setSaveError] = useState('');

  /* ---------- 感知保存（方案 1：草稿行 + 失焦即存） ---------- */
  /**
   * - `draftRowIdRef`：本次弹窗内**新建**的草稿行 id（编辑既有配置时恒为 null）
   * - `draftPromiseRef`：草稿行创建中的 promise —— 用户可能在 create 落库前就失焦，
   *   用它串行化，避免「草稿未建好又建一条」产生重复行
   * - `dirtyRef`：用户是否真的改过字段；关闭时「有草稿行且从未改动」⇒ 回滚删除，避免垃圾行
   * - `originalModelsRef`：打开弹窗时的模型列表 —— 联动清理（删模型 ⇒ 清绑定）的比较基准，
   *   不能读 `apiProfiles`（每次落库都在变）
   */
  const draftRowIdRef = useRef<string | null>(null);
  const draftPromiseRef = useRef<Promise<string | null> | null>(null);
  const dirtyRef = useRef(false);
  const originalModelsRef = useRef<string[]>([]);

  /* ---------- 删除确认 ---------- */
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  /* ---------- 加载数据 ---------- */
  const loadData = useCallback(async () => {
    try {
      const rawP = await window.api?.apiProfile?.getAll();
      const pData = (rawP as any)?.data ?? rawP;
      if (Array.isArray(pData)) setApiProfiles(pData);
    } catch {}
    try {
      // 初始化配置：加载前先清理无效绑定（profileId 为空 / Profile 不存在 / modelName 已被删除）
      // 避免 DB 残留导致下拉里显示已删除的模型（如 deepseek）
      try { await window.api?.profileBinding?.cleanupInvalid(); } catch {}
      const rawB = await window.api?.profileBinding?.getAll();
      const bData = (rawB as any)?.data ?? rawB;
      if (Array.isArray(bData)) {
        const map: Record<string, any> = {};
        bData.forEach((b: any) => { map[b.taskType] = b; });
        setBindings(map);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (propProfiles && propProfiles.length > 0) {
      setApiProfiles(propProfiles);
    } else {
      loadData();
    }
  }, [propProfiles, loadData]);

  // 🔧 修复 Bug2：propBindings 仅用于初始同步，写入 internalBindings 后续乐观更新才能生效
  useEffect(() => {
    if (propBindings && propBindings.length > 0) {
      const map: Record<string, any> = {};
      propBindings.forEach((b: any) => { map[b.taskType] = b; });
      setBindings(map);
    } else {
      loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propBindings]);

  /* ---------- TTS 相关 ---------- */
  const TTS_SETTINGS_KEYS = ['ttsProvider', 'doubaoTtsAppId', 'doubaoTtsToken', 'doubaoTtsVoice'];
  const ttsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleValChange = (field: string, val: any) => {
    onUpdate('ai', field, val);
    if (field === 'ttsProvider') setCurrentTts(val);
    if (TTS_SETTINGS_KEYS.includes(field)) {
      if (ttsSaveTimerRef.current) clearTimeout(ttsSaveTimerRef.current);
      ttsSaveTimerRef.current = setTimeout(async () => {
        try { await API.system.setSetting(field, val ?? ''); } catch {}
      }, 500);
    }
  };

  /* ---------- 管线绑定 ---------- */
  const handleBindingChange = useCallback(async (taskType: string, profileId: string | null, modelName: string) => {
    if (!taskType) return;
    setBindings((prev) => ({ ...prev, [taskType]: { taskType, profileId, modelName } }));
    try { await window.api?.profileBinding?.upsert(taskType, profileId, modelName); } catch {}
  }, []);

  /* ---------- Provider 开关 ---------- */
  const toggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    const newEnabled = enabled ? 1 : 0;
    // 乐观更新：先更新 UI，再调 API
    setApiProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, enabled: newEnabled } : p)));
    try {
      await window.api?.apiProfile?.toggleEnabled(id, enabled);
      await loadData(); // 从 DB 刷新，确保与前端一致
    } catch {
      // API 失败则回滚本地状态
      setApiProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, enabled: enabled ? 0 : 1 } : p)));
    }
  }, [loadData]);

  /* ---------- 删除 Provider ---------- */
  const handleDelete = async () => {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    try {
      // 后端会自动清理引用此 Profile 的 binding（见 ApiProfileController）
      await window.api?.apiProfile?.delete(targetId);
    } catch {}
    // 乐观更新：移除 Profile 卡片
    setApiProfiles((prev) => prev.filter((p) => p.id !== targetId));
    // 🔧 修复 Bug3：同步清理本地 bindings，避免管线节点残留无效绑定
    setBindings((prev) => {
      const next: Record<string, any> = {};
      Object.entries(prev).forEach(([taskType, b]) => {
        if (b?.profileId === targetId) {
          // 该 Profile 已删除，对应管线节点退回到未绑定状态
          next[taskType] = { taskType, profileId: null, modelName: '' };
        } else {
          next[taskType] = b;
        }
      });
      return next;
    });
    setDeleteTarget(null);
  };

  /* ---------- 表单校验 ---------- */
  /**
   * 行内校验（**只提示、不阻塞写入**）
   *
   * 感知保存（方案 1）下不存在「保存闸门」：字段一失焦就落库，因此校验结果只用于字段旁的红色提示。
   * 唯一的硬拦截是 ADR-004 G4 的密文形态 Key —— 由 `persistProfile` 直接拒绝写入（后端亦有守卫）。
   */
  const isApiKeyPristine = editingProfileId !== null && !draftRowIdRef.current && !apiKeyChanged;

  const validateField = (field: 'baseUrl' | 'apiKey' | 'models') => {
    setFormErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      if (field === 'baseUrl' && !formBaseUrl.trim()) {
        next.baseUrl = '接口地址不能为空';
      }
      if (field === 'apiKey') {
        const v = formApiKey.trim();
        if (looksEncryptedValue(v)) {
          // 🔧 ADR-004 G4：密文形态绝不能保存（会对密文再加密且不可逆）
          next.apiKey = '检测到密文格式（v1:/v2:/v3:）。请填写明文 API Key —— 保存密文会导致二次加密且不可恢复';
        } else if (!isApiKeyPristine && !v) {
          next.apiKey = 'API Key 不能为空';
        } else if (v && v.length < 10) {
          next.apiKey = 'API Key 格式不正确，长度不足';
        }
      }
      if (field === 'models') {
        const models = isCustom
          ? customModelsText.split('\n').map((s) => s.trim()).filter(Boolean)
          : formModels;
        if (models.length === 0) next.models = '请至少选择一个模型';
      }
      return next;
    });
  };

  /* ---------- Modal 操作 ---------- */
  /** 重置感知保存的会话级 refs（每次打开弹窗都要清，否则会串上一轮的状态） */
  const resetDraftRefs = (originalModels: string[] = []) => {
    draftRowIdRef.current = null;
    draftPromiseRef.current = null;
    dirtyRef.current = false;
    originalModelsRef.current = originalModels;
  };

  const openAddModal = () => {
    setEditingProfileId(null);
    setIsNewProfile(true);
    setModalStep('provider');
    setSelectedProvider(''); setFormBaseUrl(''); setFormApiKey(''); setFormAlias('');
    setFormModels([]); setCustomModelsText(''); setFormKeyVisible(false); setTestStatus('idle');
    setApiKeyChanged(false); setFormErrors({}); setCredentialWarning(''); setSaveError('');
    resetDraftRefs();
    setModalOpen(true);
  };

  const openEditModal = (profile: any) => {
    setEditingProfileId(profile.id);
    setIsNewProfile(false);
    // 🔧 修复 Bug1：后端返回 camelCase，旧代码读 snake_case 导致预设类型恒为 undefined
    const presetType = profile.presetType || profile.provider;
    const models: string[] = Array.isArray(profile.models) ? profile.models : [];
    setSelectedProvider(presetType);
    setFormBaseUrl(profile.baseUrl || '');
    // 🔧 修复：编辑模式回填真实 Key（后端已解密），用户可查看和修改
    // apiKeyChanged 保持 false，保存时若未改动则不覆盖原 Key
    // 🔧 ADR-004 G4：解密失败时后端恒返回空串（不再回显密文），此处改为留空 + 横幅提示
    const keyUnreadable = profile.apiKeyStatus === 'decrypt_failed';
    setFormApiKey(keyUnreadable ? '' : (profile.apiKey || ''));
    setCredentialWarning(keyUnreadable
      ? '该配置的 API Key 已失效（无法解密，通常因系统密钥库重建）。请重新填写明文 Key，否则该通道不可用。'
      : '');
    setFormAlias(profile.alias || profile.name || '');
    setFormModels(models);
    setCustomModelsText(models.join('\n'));
    setFormKeyVisible(false); setTestStatus('idle');
    setApiKeyChanged(false); setFormErrors({}); setSaveError('');
    // 🔧 方案 1：编辑既有配置**不建草稿行**；联动清理的比较基准取打开时的模型列表
    resetDraftRefs(models);
    setModalStep(presetType ? 'form' : 'provider');
    setModalOpen(true);
  };
  /**
   * 感知保存：把当前表单落库（新增流先补建草稿行，之后一律走 `update` 单一路径）
   *
   * - ADR-004 G4：密文形态的 Key **绝不外发**（此处拦截 + 后端 `assertPlaintextApiKey` 双保险）
   * - 仅当用户实际输入过 Key 才写 `apiKey` 字段，否则不传 ⇒ 不会把既有 Key 覆盖成空
   * @param overrides.models 显式指定模型列表（勾选复选框时用，避免读到未提交的 state）
   * @returns true = 已写入；false = 被拒/失败（原因已由 `saveError` / `formErrors` 呈现）
   */
  const persistProfile = async (overrides?: { models?: string[] }): Promise<boolean> => {
    if (!selectedProvider) return false;

    // G4：对密文再加密不可逆 ⇒ 直接拒绝写入
    if (apiKeyChanged && looksEncryptedValue(formApiKey.trim())) {
      setFormErrors((prev) => ({ ...prev, apiKey: '检测到密文格式（v1:/v2:/v3:）。请填写明文 API Key —— 保存密文会导致二次加密且不可恢复' }));
      return false;
    }

    const preset = (PROVIDER_CONFIGS as any)[selectedProvider];
    const alias = formAlias.trim();
    const models = overrides?.models ?? (isCustom
      ? customModelsText.split('\n').map((s) => s.trim()).filter(Boolean)
      : formModels);

    const patch: any = {
      name: alias || preset?.name || selectedProvider,
      baseUrl: formBaseUrl.trim(),
      models,
      alias: alias || '',
      isPreset: isCustom ? 0 : 1,
      presetType: isCustom ? null : selectedProvider,
    };
    if (apiKeyChanged && formApiKey.trim()) patch.apiKey = formApiKey.trim();

    try {
      let id = editingProfileId ?? draftRowIdRef.current;
      // 草稿行可能仍在创建中（用户在 create 落库前就失焦了）⇒ 等它，避免重复建行
      if (!id && draftPromiseRef.current) id = await draftPromiseRef.current;

      if (!id) {
        const created: any = await window.api?.apiProfile?.create({
          ...patch, provider: selectedProvider,
          apiKey: formApiKey.trim(), enabled: 1, isActive: false, sortOrder: 0,
        });
        const row: any = created?.data ?? created;
        id = row?.id ?? null;
        if (!id) throw new Error('草稿行创建后未返回 id');
        draftRowIdRef.current = id;
        setEditingProfileId(id);
      } else {
        await window.api?.apiProfile?.update(id, patch);
      }
      setSaveError('');
      return true;
    } catch (e: any) {
      setSaveError(cleanIpcErrorMessage(e));
      return false;
    }
  };

  /**
   * 字段失焦即存（感知保存的唯一写入口，替代原「保存」按钮）
   * 未改动过就不写 —— 避免「点开看一眼」也产生无意义写入
   */
  const handleFieldBlur = (field: 'baseUrl' | 'apiKey' | 'models' | 'text') => {
    if (field !== 'text') validateField(field);
    if (!dirtyRef.current) return;
    void persistProfile();
  };

  /**
   * 提交模型变更（勾选复选框 / 回车追加 都走这里）
   *
   * 含「删模型 ⇒ 清受影响管线绑定」的联动确认 —— 原挂在保存按钮上，感知保存后前移到提交时刻。
   * @returns false = 用户取消了确认框（调用方须回滚 UI 勾选态）；写入失败不回滚（用户意图应保留）
   */
  const commitModels = async (next: string[]): Promise<boolean> => {
    const removed = originalModelsRef.current.filter((m) => !next.includes(m));
    if (editingProfileId && removed.length > 0) {
      const affected = (Object.values(bindings) as any[]).filter(
        (b) => b?.profileId === editingProfileId && removed.includes(b?.modelName)
      );
      if (affected.length > 0) {
        const taskList = affected
          .map((b) => ALL_PIPELINE_NODES.find((n) => n.taskType === b.taskType)?.label || b.taskType)
          .join('、');
        const confirmMsg =
          `本次修改删除了模型：${removed.join(', ')}\n` +
          `以下管线节点引用了这些模型：${taskList}\n` +
          `保存后将自动清空上述绑定，是否继续？`;
        if (!window.confirm(confirmMsg)) return false;

        // 先清空受影响的绑定，避免管线节点残留无效 model_name
        for (const b of affected) {
          try { await window.api?.profileBinding?.upsert(b.taskType, null, ''); } catch {}
        }
        setBindings((prev) => {
          const n = { ...prev };
          affected.forEach((b) => { n[b.taskType] = { taskType: b.taskType, profileId: null, modelName: '' }; });
          return n;
        });
      }
    }
    originalModelsRef.current = next;
    await persistProfile({ models: next });
    return true;
  };

  /**
   * 关闭弹窗（感知保存收口）
   *
   * 新增流若只走到「选供应商」就退出（`dirtyRef` 从未置位）⇒ 回滚删除草稿行，避免列表堆积空行。
   * 弹窗期间不调 `loadData()`（每次失焦都重载太重），统一在关闭时刷新一次。
   */
  const handleCloseModal = async () => {
    const draftId = draftRowIdRef.current;
    if (draftId && !dirtyRef.current) {
      try { await window.api?.apiProfile?.delete(draftId); } catch {}
    }
    resetDraftRefs();
    setModalOpen(false);
    await loadData();
  };

  const selectProvider = (type: string) => {
    setSelectedProvider(type);
    const preset = (PROVIDER_CONFIGS as any)[type];
    setFormBaseUrl(preset?.baseUrl || ''); setFormModels([]); setCustomModelsText('');
    setFormKeyVisible(false); setTestStatus('idle'); setApiKeyChanged(false); setFormErrors({});
    setCredentialWarning(''); setSaveError('');
    setModalStep('form');

    // 🔧 方案 1：选定供应商即落**草稿行**（此刻 provider / baseUrl / presetType 才有值；
    //    在「打开弹窗」那一步建行会得到一条 provider 为空的垃圾行）。
    //    之后所有字段失焦一律走 update ⇒ 单一路径，不再需要「保存」按钮。
    resetDraftRefs();
    const isCustomType = type === 'custom';
    draftPromiseRef.current = (async () => {
      try {
        const created: any = await window.api?.apiProfile?.create({
          name: preset?.name || type,
          provider: type,
          apiKey: '',
          baseUrl: preset?.baseUrl || '',
          models: [],
          isActive: false,
          sortOrder: 0,
          alias: '',
          enabled: 1,
          isPreset: isCustomType ? 0 : 1,
          presetType: isCustomType ? null : type,
        });
        const row: any = created?.data ?? created;
        const id: string | null = row?.id ?? null;
        if (id) { draftRowIdRef.current = id; setEditingProfileId(id); }
        return id;
      } catch (e: any) {
        setSaveError(cleanIpcErrorMessage(e));
        return null;
      }
    })();
  };

  /**
   * 统一的模型勾选入口（预设列表与自定义文本两条线都走这里）
   *
   * - 当前列表 = custom ? textarea 按行 : formModels
   * - 保留 `commitModels`「删模型弹确认框、取消则回滚」的既有语义
   */
  const toggleModelSelection = async (model: string) => {
    const current = isCustom
      ? customModelsText.split('\n').map((s) => s.trim()).filter(Boolean)
      : formModels;
    const next = current.includes(model)
      ? current.filter((m) => m !== model)
      : [...current, model];
    const clearModelError = () => {
      if (formErrors.models) setFormErrors((prev) => { const n = { ...prev }; delete n.models; return n; });
    };
    if (isCustom) {
      const prevText = customModelsText;
      setCustomModelsText(next.join('\n'));
      dirtyRef.current = true;
      clearModelError();
      // 用户取消联动确认 ⇒ 回滚勾选态
      const ok = await commitModels(next);
      if (!ok) setCustomModelsText(prevText);
    } else {
      const prevModels = formModels;
      setFormModels(next);
      dirtyRef.current = true;
      clearModelError();
      // 用户取消联动确认 ⇒ 回滚勾选态
      const ok = await commitModels(next);
      if (!ok) setFormModels(prevModels);
    }
  };
  const isCustom = selectedProvider === 'custom';
  // 🔧 修复：仅「新增预设供应商」时 baseUrl 只读（自动填入 preset.baseUrl）
  // 编辑模式（无论预设还是 custom）和新增 custom 模式都允许修改
  // ⚠️ 不能用 `editingProfileId` 判断新增：方案 1 下新增流选定供应商即建草稿行，它立刻非空
  const isBaseUrlReadOnly = isNewProfile && !isCustom;

  const [testFailReason, setTestFailReason] = useState('');
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchHint, setFetchHint] = useState('');
  /** 拉取到的「可选项池」—— 只作为候选来源，不自动勾选、不落库 */
  const [fetchedPool, setFetchedPool] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [modelCategory, setModelCategory] = useState<string>('全部');

  /**
   * 测试连接：POST /chat/completions 真实最小推理验证所选模型可用性
   *
   * 🔧 修复根因：IpcRouter 会把 handler 返回值包装成 { success, data }
   * 旧代码 typeof result === 'string' 永远不成立，导致恒报"后端返回为空"
   * 正确做法：解构 result.data 或 result.error
   */
  const handleTestConnection = async () => {
    // 编辑既有配置时不回用已存的 Key 做测试（避免拿旧凭据误判）
    // ⚠️ 不能用 `editingProfileId` 判断：方案 1 下新增流选定供应商即建草稿行，它立刻非空
    if (!isNewProfile && !formApiKey.trim()) {
      setTestStatus('fail');
      setTestFailReason('请先输入 API Key 再测试（编辑模式不会使用已保存的 Key）');
      return;
    }
    if (!formApiKey.trim()) {
      setTestStatus('fail');
      setTestFailReason('API Key 不能为空');
      return;
    }
    if (!formBaseUrl.trim()) {
      setTestStatus('fail');
      setTestFailReason('接口地址不能为空');
      return;
    }
    // 取当前表单选中的第一个模型作为真实推理测试目标
    const currentModels = isCustom
      ? customModelsText.split('\n').map((s) => s.trim()).filter(Boolean)
      : formModels;
    const testModel = currentModels[0] || '';
    if (!testModel) {
      setTestStatus('fail');
      setTestFailReason('请先选择至少一个模型，再测试连接');
      return;
    }
    setTestStatus('testing');
    setTestFailReason('');
    try {
      const result: any = await window.api?.ai?.testNetwork?.('openai_like', {
        provider: selectedProvider,
        apiKey: formApiKey.trim(),
        baseURL: formBaseUrl.trim(),
        model: testModel,
      });
      // 🔧 修复：IpcRouter 包装层为 { success, data }，需解构
      if (result?.success === false) {
        setTestStatus('fail');
        setTestFailReason(result?.error || '连接失败');
        return;
      }
      const msg = result?.data ?? result;
      if (typeof msg === 'string' && msg.length > 0) {
        setTestStatus('success');
      } else {
        setTestStatus('fail');
        setTestFailReason('后端返回格式异常');
      }
    } catch (err: any) {
      setTestStatus('fail');
      setTestFailReason(err?.message || String(err) || '连接失败');
    }
  };

  /**
   * 拉取账户可用模型列表
   *
   * 调用 OpenAI 兼容 /models 接口，把去重后的结果填入「可选项池」（fetchedPool），
   * **不自动勾选、不落库** —— 由用户从候选列表里挑，避免 230 个模型被全选灌库。
   * - 成功：可选项池变大，已选数量保持原样
   * - 失败：保留 PROVIDER_CONFIGS 参考列表，显示错误提示
   */
  const handleFetchModels = async () => {
    if (!formApiKey.trim()) { setFetchHint('请先填写 API Key'); return; }
    if (!formBaseUrl.trim()) { setFetchHint('请先填写接口地址'); return; }
    setFetchingModels(true);
    setFetchHint('正在拉取模型列表...');
    try {
      const result: any = await window.api?.ai?.fetchModels?.({
        provider: selectedProvider,
        apiKey: formApiKey.trim(),
        baseURL: formBaseUrl.trim(),
      });
      if (result?.success === false) {
        setFetchHint(`拉取失败：${result?.error || '未知错误'}（已保留参考列表）`);
        return;
      }
      const models: string[] = result?.data ?? result;
      if (!Array.isArray(models) || models.length === 0) {
        setFetchHint('拉取成功但返回空列表（已保留参考列表）');
        return;
      }
      // 只填「可选项池」：去重后供搜索/分类筛选，绝不自动勾选、绝不落库
      const deduped = Array.from(new Set(models)).filter((m) => typeof m === 'string' && m.trim() !== '');
      setFetchedPool(deduped);
      const selectedCount = isCustom
        ? customModelsText.split('\n').map((s) => s.trim()).filter(Boolean).length
        : formModels.length;
      setFetchHint(`✓ 拉取成功，共 ${deduped.length} 个模型可选 —— 请勾选需要的（已选 ${selectedCount} 个）`);
    } catch (err: any) {
      setFetchHint(`拉取失败：${err?.message || String(err)}（已保留参考列表）`);
    } finally {
      setFetchingModels(false);
    }
  };

  /* ---------- 构建管线模型选项 ---------- */
  const enabledProfiles = apiProfiles.filter((p: any) => (p.enabled ?? 1) !== 0);
  const modelOptions = enabledProfiles.flatMap((p: any) =>
    (Array.isArray(p.models) ? p.models : []).map((m: string) => ({
      modelName: m, profileId: p.id, profileName: p.alias || p.name || p.provider,
    }))
  );

  /* ---------- 模型选择区（搜索 / 分类 / 候选） ---------- */
  // 当前已选：custom 走 textarea 按行，预设走 formModels
  const selectedModelList = isCustom
    ? customModelsText.split('\n').map((s) => s.trim()).filter(Boolean)
    : formModels;
  // 候选 = 去重(预设 ∪ 拉取池 ∪ 已选)
  const candidateModels = Array.from(new Set([
    ...((PROVIDER_CONFIGS as any)[selectedProvider]?.models || []),
    ...fetchedPool,
    ...selectedModelList,
  ]));
  // 分类计数按「未过滤的池子」算
  const categoryCounts = candidateModels.reduce<Record<string, number>>((acc, m) => {
    const c = classifyModel(m);
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {});
  // 先分类过滤，再按不区分大小写的子串搜索
  const filteredCandidates = candidateModels.filter((m) => {
    const catOk = modelCategory === '全部' || classifyModel(m) === modelCategory;
    const searchOk = !modelSearch || m.toLowerCase().includes(modelSearch.toLowerCase());
    return catOk && searchOk;
  });

  // 搜索 + 分类 + 已选 + 候选列表（预设与 custom 两条线共用同一套 UI）
  const modelSelectionJsx = (
    <div className={`border rounded-md bg-[var(--input)] ${formErrors.models ? 'border-[var(--accent-rose)]' : 'border-[var(--border)]'}`}>
      {/* (a) 已选区块：常驻，不受搜索/分类影响，保证随时可取消 */}
      <div className="px-2.5 py-2 border-b border-[var(--border)]">
        <div className="text-[12px] text-muted-foreground mb-1">已选 {selectedModelList.length} 个</div>
        {selectedModelList.length === 0 ? (
          <div className="text-[12px] text-muted-foreground/60">尚未选择模型</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {selectedModelList.map((model) => (
              <label key={model} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/8 text-[12px] text-foreground cursor-pointer hover:bg-accent/15 transition-colors">
                <input type="checkbox" checked onChange={() => void toggleModelSelection(model)} className="accent-[var(--accent)]" />
                <span className="truncate max-w-[180px]" title={model}>{model}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      {/* (b) 筛选条：搜索框 + 分类 chip */}
      <div className="px-2.5 py-2 border-b border-[var(--border)] flex flex-col gap-1.5">
        <input
          className="w-full px-2 py-1 text-[13px] bg-transparent text-foreground outline-none border border-[var(--border)] rounded focus:border-accent"
          placeholder="搜索模型名…"
          value={modelSearch}
          onChange={(e) => setModelSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1.5">
          {MODEL_CATEGORIES.map((cat) => {
            const count = cat === '全部' ? candidateModels.length : (categoryCounts[cat] || 0);
            const active = modelCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setModelCategory(cat)}
                className={`text-[12px] px-2 py-0.5 rounded border transition-colors cursor-pointer outline-none ${active ? 'border-accent text-accent bg-accent/10' : 'border-[var(--border)] text-muted-foreground hover:border-accent/40'}`}
              >
                {cat} {count}
              </button>
            );
          })}
        </div>
      </div>
      {/* (c) 可选列表 */}
      <div className="max-h-[140px] overflow-y-auto">
        {filteredCandidates.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] text-muted-foreground">无匹配模型</div>
        ) : (
          filteredCandidates.map((model) => (
            <label key={model} className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] transition-colors hover:bg-[var(--bg-hover)] ${selectedModelList.includes(model) ? 'bg-accent/8' : ''}`}>
              <input type="checkbox" checked={selectedModelList.includes(model)} onChange={() => void toggleModelSelection(model)} className="accent-[var(--accent)]" />
              <span className="truncate" title={model}>{model}</span>
              <span className="text-[11px] text-muted-foreground/60 ml-auto shrink-0">{classifyModel(model)}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );

  /* ========== 渲染 ========== */
  return (
    <div className="space-y-8 animate-fade-in-up">

      {/* ===== 模型配置 ===== */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-accent" />
            <h3 className="text-base font-semibold text-foreground">模型配置</h3>
          </div>
          <button onClick={openAddModal}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-dashed transition-all outline-none cursor-pointer shrink-0 border-accent/50 text-accent hover:bg-accent/5 hover:border-accent">
            <Plus size={14} /> 添加模型
          </button>
        </div>

        {apiProfiles.length === 0 ? (
          <div className="text-center py-8 text-xs text-muted-foreground bg-[var(--input)] border border-[var(--border)] rounded-lg">暂无已配置的模型</div>
        ) : (
          <div className="flex flex-col gap-2">
            {apiProfiles.map((p: any) => {
              const enabled = (p.enabled ?? 1) !== 0;
              // 🔧 修复 Bug1：后端返回 camelCase 字段 presetType
              const providerName = (PROVIDER_CONFIGS as any)[p.presetType || p.provider]?.name || p.provider;
              const icon = getIcon(p.presetType || p.provider);
              const displayName = p.alias || p.name || providerName;
              const modelList: string[] = Array.isArray(p.models) ? p.models : [];

              return (
                <div key={p.id} className={`bg-[var(--input)] border border-[var(--border)] rounded-lg overflow-hidden transition-opacity ${!enabled ? 'opacity-45' : ''}`}>
                  {/* 卡片头部 — 扁平设计，不可展开 */}
                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className={`w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold shrink-0 ${icon.className}`}>
                        {icon.text}
                      </div>
                      <div className="flex flex-col gap-px min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-medium text-foreground truncate">{displayName}</span>
                          {p.alias && <span className="text-[12px] text-muted-foreground/60 truncate">({providerName})</span>}
                        </div>
                        <span className="text-[12px] text-muted-foreground">
                          {modelList.length} 个模型
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <ToggleSwitch checked={enabled} onChange={(v) => toggleEnabled(p.id, v)} />
                      <button onClick={() => openEditModal(p)}
                        className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--bg-hover)] hover:text-foreground transition-colors cursor-pointer outline-none" title="编辑">
                        &#9998;
                      </button>
                      <button onClick={() => setDeleteTarget(p)}
                        className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-muted-foreground hover:bg-[rgba(225,29,72,0.12)] hover:text-[var(--accent-rose)] transition-colors cursor-pointer outline-none" title="删除">
                        &#128465;
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ===== 模型映射 ===== */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <Server size={18} className="text-accent-cyan" />
          <h3 className="text-base font-semibold text-foreground">模型映射</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">选择各功能使用的模型，变更即时保存</p>

        {/* 分组 1：LLM 云模型节点 — 2 列网格，紧凑展示 */}
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">云模型</span>
            <div className="flex-1 h-px bg-[var(--border)]/50" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {ALL_PIPELINE_NODES.filter((n) => (n as any).useModelPool).map((node) => {
              const binding = bindings[node.taskType];
              const currentModel = binding?.modelName || '';
              // 🔧 优化：显示当前绑定的 Provider 名作为小标签
              const boundOpt = modelOptions.find((o) => o.modelName === currentModel);
              const boundProviderName = boundOpt?.profileName;
              return (
                <div key={node.taskType} className="bg-[var(--input)] border border-[var(--border)] rounded-lg p-2.5 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-base shrink-0">{node.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-foreground truncate">{node.label}</div>
                      <div className="text-[12px] text-muted-foreground truncate">{node.desc}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select value={currentModel} onChange={(e) => {
                      const val = e.target.value;
                      if (!val) { handleBindingChange(node.taskType, null, ''); return; }
                      const opt = modelOptions.find((o) => o.modelName === val);
                      handleBindingChange(node.taskType, opt?.profileId || null, val);
                    }} className="flex-1 text-[12px] px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border)] text-foreground outline-none cursor-pointer hover:border-accent/40 min-w-0">
                      <option value="">未绑定</option>
                      {modelOptions.map((opt) => (
                        <option key={`${opt.profileId}:${opt.modelName}`} value={opt.modelName}>
                          {opt.modelName} ({opt.profileName})
                        </option>
                      ))}
                    </select>
                    {boundProviderName && currentModel && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0 max-w-[70px] truncate" title={boundProviderName}>
                        {boundProviderName}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 分组 2：本地引擎节点 — 单列，保持原有 select 宽度 */}
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">本地引擎</span>
            <div className="flex-1 h-px bg-[var(--border)]/50" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {ALL_PIPELINE_NODES.filter((n) => (n as any).localOptions).map((node) => {
              const options: string[] = (node as any).localOptions || [];
              const currentVal = bindings[node.taskType]?.modelName || '';
              return (
                <div key={node.taskType} className="bg-[var(--input)] border border-[var(--border)] rounded-lg p-2.5 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-base shrink-0">{node.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-foreground truncate">{node.label}</div>
                      <div className="text-[12px] text-muted-foreground truncate">{node.desc}</div>
                    </div>
                  </div>
                  <select value={currentVal} onChange={(e) => handleBindingChange(node.taskType, null, e.target.value)}
                    className="text-[12px] px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border)] text-foreground outline-none cursor-pointer hover:border-accent/40">
                    <option value="">未绑定</option>
                    {options.map((opt: string) => (<option key={opt} value={opt}>{opt}</option>))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>

        {/* 分组 3：TTS 禁用节点 — 单行提示 */}
        {ALL_PIPELINE_NODES.filter((n) => (n as any).disabled).map((node) => (
          <div key={node.taskType} className="bg-[var(--input)] border border-[var(--border)] rounded-lg p-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base shrink-0">{node.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-foreground truncate">{node.label}</div>
                <div className="text-[12px] text-muted-foreground truncate">{node.desc}</div>
              </div>
            </div>
            <span className="text-[12px] text-muted-foreground italic shrink-0">{(node as any).hint}</span>
          </div>
        ))}
      </section>

      {/* ===== TTS 配置 ===== */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Play size={18} className="text-accent-purple" />
          <h3 className="text-base font-semibold text-foreground">语音合成 (TTS)</h3>
        </div>
        <div className="glass-card-sm p-5 flex flex-col gap-5">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-foreground font-medium">默认合成引擎</span>
              <span className="text-xs text-muted-foreground">选择 TTS 语音合成引擎</span>
            </div>
            <div className="flex items-center gap-3">
              <Select value={aiData.ttsProvider} onValueChange={v => handleValChange('ttsProvider', v)}>
                <SelectTrigger className="w-44 h-9 text-xs bg-bg-secondary border-border/50"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-bg-tertiary border-border/50">
                  <SelectItem value="doubao" className="text-xs">火山引擎 TTS (推荐)</SelectItem>
                  <SelectItem value="edge" className="text-xs">微软 Edge TTS (免费)</SelectItem>
                  <SelectItem value="kokoro" className="text-xs">Kokoro (本地推理)</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={onTestTTS} className="h-9 text-xs px-4 bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 shadow-none shrink-0 gap-1.5">
                <Play size={13} fill="currentColor" /> 试听
              </Button>
            </div>
          </div>
          <div className="pt-4 border-t border-border/30">
            {currentTts === 'edge' && (
              <div className="text-xs text-accent-green bg-accent-green/10 p-3 rounded-lg border border-accent-green/20 flex items-center gap-2">该引擎为免费开源接口，无需额外配置任何密钥。</div>
            )}
            {currentTts === 'kokoro' && (
              <div className="flex flex-col gap-1.5">
                <div className="text-xs text-accent-cyan bg-accent-cyan/10 p-3 rounded-lg border border-accent-cyan/20 flex items-center gap-2">本地 82M 参数轻量推理引擎，音质对标大模型，CPU 实时合成。首次使用需在 模型管理 / 健康检查 中安装运行时依赖。</div>
              </div>
            )}
            {currentTts === 'doubao' && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground font-medium">火山引擎 App ID</span>
                  <Input value={aiData.doubaoTtsAppId || ''} onChange={e => handleValChange('doubaoTtsAppId', e.target.value)} className="text-xs bg-bg-secondary h-9 border-border/50" />
                </div>
                <PasswordField label="火山引擎 Access Token" value={aiData.doubaoTtsToken || ''} onChange={(e: any) => handleValChange('doubaoTtsToken', e.target.value)} onCheck={() => onTest('doubao_tts', '火山引擎语音服务', { appId: aiData.doubaoTtsAppId, token: aiData.doubaoTtsToken })} linkUrl="https://console.volcengine.com/speech/app" />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ===== Add/Edit Modal ===== */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[14px] w-[480px] max-h-[85vh] overflow-y-auto p-[26px]">
            <div className="flex items-center justify-between mb-5">
              <span className="text-[15px] font-semibold text-foreground">{isNewProfile ? '添加模型' : '编辑模型'}</span>
              <button onClick={handleCloseModal} className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--bg-hover)] hover:text-white transition-colors cursor-pointer outline-none text-lg">&times;</button>
            </div>
            {modalStep === 'provider' && (
              <div>
                <h3 className="text-[13px] font-medium text-muted-foreground mb-3">选择模型提供商</h3>
                <div className="grid grid-cols-3 gap-2 mb-0">
                  {Object.entries(PROVIDER_CONFIGS).map(([key, preset]) => {
                    const icon = getIcon(key);
                    return (
                      <button key={key} onClick={() => selectProvider(key)}
                        className="flex flex-col items-center gap-1.5 py-2.5 px-1 rounded-lg border border-[var(--border)] bg-[var(--input)] cursor-pointer hover:border-accent hover:bg-accent/5 transition-colors outline-none">
                        <div className={`w-8 h-8 rounded-md flex items-center justify-center text-base font-bold ${icon.className}`}>{icon.text}</div>
                        <span className="text-xs text-foreground">{preset.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {modalStep === 'form' && (
              <div>
                <h3 className="text-[13px] font-medium text-muted-foreground mb-4">{(PROVIDER_CONFIGS as any)[selectedProvider]?.fullName || selectedProvider}</h3>
                <div className="mb-3.5">
                  <label className="text-xs text-muted-foreground block mb-1.5">别名</label>
                  <input className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border)] bg-[var(--input)] text-[13px] text-foreground outline-none focus:border-accent transition-colors" placeholder="给这个配置起个名字，如「我的豆包」「公司Key」" value={formAlias} onChange={(e) => { setFormAlias(e.target.value); dirtyRef.current = true; }} onBlur={() => handleFieldBlur('text')} />
                </div>
                <div className="mb-3.5">
                  <label className="text-xs text-muted-foreground block mb-1.5">接口地址 <span className="text-[var(--accent-rose)]">*</span></label>
                  {/* 🔧 修复：编辑模式下始终允许修改（用户可能切换 region/代理/转发地址） */}
                  {/* 仅「新增预设供应商」时只读（自动填入 preset.baseUrl），新增 custom 和编辑模式都可改 */}
                  <input className={`w-full px-2.5 py-1.5 rounded-md border bg-[var(--input)] text-[13px] outline-none focus:border-accent transition-colors ${formErrors.baseUrl ? 'border-[var(--accent-rose)]' : 'border-[var(--border)]'} ${isBaseUrlReadOnly ? 'text-muted-foreground' : 'text-foreground'}`} value={formBaseUrl} onChange={(e) => { setFormBaseUrl(e.target.value); dirtyRef.current = true; if (formErrors.baseUrl) setFormErrors(prev => { const n = {...prev}; delete n.baseUrl; return n; }); }} onBlur={() => { if (!isBaseUrlReadOnly) handleFieldBlur('baseUrl'); }} readOnly={isBaseUrlReadOnly} placeholder="https://api.example.com/v1" />
                  {formErrors.baseUrl && <span className="text-[12px] text-[var(--accent-rose)] mt-1 block">{formErrors.baseUrl}</span>}
                </div>
                <div className="mb-3.5">
                  <label className="text-xs text-muted-foreground block mb-1.5">API Key <span className="text-[var(--accent-rose)]">*</span></label>
                  <div className={`flex items-center border rounded-md bg-[var(--input)] overflow-hidden focus-within:border-accent ${formErrors.apiKey ? 'border-[var(--accent-rose)]' : 'border-[var(--border)]'}`}>
                    <input type={formKeyVisible ? 'text' : 'password'} className="flex-1 px-2.5 py-1.5 bg-transparent text-[13px] text-foreground outline-none font-mono" placeholder="sk-..." value={formApiKey} onChange={(e) => { setFormApiKey(e.target.value); setApiKeyChanged(true); dirtyRef.current = true; if (formErrors.apiKey) setFormErrors(prev => { const n = {...prev}; delete n.apiKey; return n; }); }} onBlur={() => handleFieldBlur('apiKey')} />
                    {/* 🔧 修复：用 Eye/EyeOff 图标替换固定 emoji，点击后有明确视觉反馈 */}
                    <button type="button" onClick={() => setFormKeyVisible(!formKeyVisible)} className="px-2.5 py-1.5 text-muted-foreground hover:text-foreground cursor-pointer outline-none transition-colors">
                      {formKeyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  {/* 🔧 修复：编辑模式回填真实 Key，不再需要"Key 已保存"提示 */}
                  {formErrors.apiKey && <span className="text-[12px] text-[var(--accent-rose)] mt-1 block">{formErrors.apiKey}</span>}
                  {/* 🔧 ADR-004 G4：凭据解不开时留空 + 横幅，不回显密文 */}
                  {credentialWarning && (
                    <div className="mt-1.5 text-[12px] text-[var(--accent-rose)] bg-[rgba(225,29,72,0.08)] border border-[rgba(225,29,72,0.25)] rounded px-2 py-1.5 leading-relaxed">
                      {credentialWarning}
                    </div>
                  )}
                  {!isCustom && (PROVIDER_CONFIGS as any)[selectedProvider]?.keyUrl && (
                    <a className="inline-flex items-center gap-1 text-xs text-accent mt-1 cursor-pointer hover:underline" href="#" onClick={(e) => { e.preventDefault(); window.open((PROVIDER_CONFIGS as any)[selectedProvider].keyUrl, '_blank'); }}>
                      <ExternalLink size={11} /> 获取 API Key
                    </a>
                  )}
                </div>
                <div className="mb-3.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs text-muted-foreground">模型 <span className="text-[var(--accent-rose)]">*</span></label>
                    {/* 拉取模型按钮：填入 baseUrl + apiKey 后可用，调用 /models 接口获取真实可用列表 */}
                    <button
                      type="button"
                      onClick={handleFetchModels}
                      disabled={fetchingModels || !formApiKey.trim() || !formBaseUrl.trim()}
                      className="flex items-center gap-1 text-[12px] px-2 py-0.5 rounded border border-accent/30 text-accent hover:bg-accent/5 transition-colors cursor-pointer outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                      title="用当前 API Key 调用 /models 接口，拉取账户实际可用的模型列表"
                    >
                      {fetchingModels ? '拉取中...' : '拉取模型'}
                    </button>
                  </div>
                  {isCustom ? (
                    <>
                      <textarea className={`w-full px-2.5 py-1.5 rounded-md border bg-[var(--input)] text-[13px] text-foreground outline-none focus:border-accent resize-y min-h-[64px] leading-relaxed ${formErrors.models ? 'border-[var(--accent-rose)]' : 'border-[var(--border)]'}`} placeholder={`输入模型名称，每行一个，如：\ngpt-4o\nclaude-sonnet-4`} value={customModelsText} onChange={(e) => { setCustomModelsText(e.target.value); dirtyRef.current = true; if (formErrors.models) setFormErrors(prev => { const n = {...prev}; delete n.models; return n; }); }} onBlur={() => handleFieldBlur('models')} />
                      <div className="text-[12px] text-muted-foreground mt-1">每行一个模型名称</div>
                      {/* 同一套搜索/分类/候选列表：勾选即往 textarea 的行里增删，免手打 */}
                      <div className="mt-1.5">{modelSelectionJsx}</div>
                    </>
                  ) : (
                    <div>
                      {modelSelectionJsx}
                      {/* 🔧 修复：预设模式下也允许追加自定义模型 */}
                      <div className="mt-1.5 border border-[var(--border)] rounded-md bg-[var(--input)] p-2">
                        <input className="w-full px-2 py-1 text-[13px] bg-transparent text-foreground outline-none border border-[var(--border)] rounded focus:border-accent" placeholder="追加自定义模型名，回车添加" onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const val = (e.target as HTMLInputElement).value.trim();
                            if (val && !formModels.includes(val)) {
                              const next = [...formModels, val];
                              setFormModels(next);
                              dirtyRef.current = true;
                              void commitModels(next);
                              (e.target as HTMLInputElement).value = '';
                            }
                          }
                        }} />
                      </div>
                    </div>
                  )}
                  {formErrors.models && <span className="text-[12px] text-[var(--accent-rose)] mt-1 block">{formErrors.models}</span>}
                  {/* 拉取结果提示 */}
                  {fetchHint && (
                    <div className={`text-[12px] mt-1 ${fetchHint.startsWith('✓') ? 'text-[var(--accent-green)]' : 'text-muted-foreground'}`}>{fetchHint}</div>
                  )}
                </div>
                <div className="flex items-center justify-between mt-5 pt-4 border-t border-[var(--border)]">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1.5 text-xs">
                      {testStatus === 'idle' && (
                        <button onClick={handleTestConnection} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer outline-none">
                          <span className="w-[7px] h-[7px] rounded-full bg-muted-foreground" /> 测试连接
                        </button>
                      )}
                      {testStatus === 'testing' && <span className="text-muted-foreground flex items-center gap-1.5"><span className="w-[7px] h-[7px] rounded-full bg-muted-foreground animate-pulse" /> 测试中...</span>}
                      {testStatus === 'success' && <span className="text-[var(--accent-green)] flex items-center gap-1.5"><span className="w-[7px] h-[7px] rounded-full bg-[var(--accent-green)]" /> 连接成功</span>}
                      {testStatus === 'fail' && (
                        <button onClick={handleTestConnection} className="text-[var(--accent-rose)] flex items-center gap-1.5 cursor-pointer outline-none hover:opacity-80 transition-opacity" title="点击重新测试">
                          <span className="w-[7px] h-[7px] rounded-full bg-[var(--accent-rose)]" /> 连接失败
                        </button>
                      )}
                    </div>
                    {/* 🔧 修复：失败时显示具体原因，帮助用户排查 */}
                    {testStatus === 'fail' && testFailReason && (
                      <span className="text-[12px] text-[var(--accent-rose)]/70 max-w-[280px] truncate" title={testFailReason}>{testFailReason}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {/* 感知保存：无「保存」按钮，字段离开即落库 */}
                    <span className="text-[12px] text-muted-foreground">改动离开字段后自动保存</span>
                    <button onClick={handleCloseModal} className="px-4 py-1.5 rounded-md border border-[var(--border)] bg-transparent text-muted-foreground text-[13px] cursor-pointer hover:border-[var(--bg-elevated)] hover:text-foreground transition-colors outline-none">关闭</button>
                  </div>
                </div>
                {/* 🔧 ADR-004 G4：保存失败必须可见（后端拒绝密文保存等） */}
                {saveError && (
                  <div className="mt-3 text-[12px] text-[var(--accent-rose)] bg-[rgba(225,29,72,0.08)] border border-[rgba(225,29,72,0.25)] rounded px-2 py-1.5 leading-relaxed">
                    保存失败：{saveError}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== 删除确认 Modal（复用 ui/dialog 组件） ===== */}
      {deleteTarget && (
        <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
          <DialogContent className="bg-[var(--bg-secondary)] border-[var(--border)] sm:max-w-[380px] p-6 gap-5 rounded-[14px] shadow-[0_10px_40px_-10px_rgba(244,63,94,0.15)]">
            <DialogHeader className="gap-2.5">
              <div className="flex items-center gap-2.5 text-[var(--accent-rose)]">
                <div className="w-9 h-9 rounded-full bg-[var(--accent-rose)]/10 flex items-center justify-center shrink-0">
                  <Trash2 size={16} className="text-[var(--accent-rose)]" />
                </div>
                <DialogTitle className="text-[15px] font-semibold text-foreground">确认删除</DialogTitle>
              </div>
              <DialogDescription className="text-[13px] text-muted-foreground leading-relaxed pl-[46px]">
                确定删除「<strong className="text-foreground">{deleteTarget.alias || deleteTarget.name || deleteTarget.provider}</strong>」的配置？<br />
                删除后不可恢复，正在使用此供应商的管线节点将退回到未绑定状态。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2.5 mt-1">
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-1.5 rounded-md border border-[var(--border)] bg-transparent text-muted-foreground text-[13px] cursor-pointer hover:border-[var(--bg-elevated)] hover:text-foreground transition-colors outline-none">取消</button>
              <button onClick={handleDelete} className="flex items-center gap-1.5 px-4 py-1.5 rounded-md border-none bg-[var(--accent-rose)] text-white text-[13px] font-medium cursor-pointer hover:opacity-90 transition-opacity outline-none">
                <Trash2 size={13} /> 确认删除
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};
