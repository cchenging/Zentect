// AI 服务配置 Tab - V3 设计系统风格
// Provider 卡片（扁平式，不可展开）+ 管线映射 + TTS 配置
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Eye, EyeOff, Server, Play, ExternalLink, Zap, Plus, FolderOpen } from 'lucide-react';
import { Input } from '@renderer/components/ui/input';
import { Button } from '@renderer/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select';
import { FormField } from '@renderer/components/ui/form-field';
import { PROVIDER_CONFIGS } from '../../ai-config/backend/AiConfigService';
import { API } from '@renderer/api';

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
  { taskType: 'asr',       label: '语音识别',  localOptions: ['Whisper 本地版', 'SenseVoiceSmall'], icon: '🎙', desc: '语音转文字' },
  // 禁用节点：由下方独立配置决定
  { taskType: 'tts',       label: '语音合成',  hint: '由下方语音合成配置决定', disabled: true, icon: '🔊', desc: '文字转语音' },
] as const;

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
  const TTS_SETTINGS_KEYS = ['ttsProvider', 'doubaoTtsAppId', 'doubaoTtsToken', 'doubaoTtsVoice', 'fishKey', 'sovitsUrl', 'mossUrl', 'mossModelDir'];
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
  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!formBaseUrl.trim()) errors.baseUrl = '接口地址不能为空';

    // 🔧 修复：编辑模式下若 API Key 未改动（空值 + apiKeyChanged=false），跳过校验
    // 新增模式或用户已输入新 Key 时按正常规则校验
    const isApiKeyPristine = editingProfileId !== null && !apiKeyChanged;
    if (!isApiKeyPristine) {
      if (!formApiKey.trim()) errors.apiKey = 'API Key 不能为空';
      else if (formApiKey.trim().length < 10) errors.apiKey = 'API Key 格式不正确，长度不足';
    }

    const models = isCustom
      ? customModelsText.split('\n').map(s => s.trim()).filter(Boolean)
      : formModels;
    if (models.length === 0) errors.models = '请至少选择一个模型';
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  /* ---------- Modal 操作 ---------- */
  const openAddModal = () => {
    setEditingProfileId(null);
    setModalStep('provider');
    setSelectedProvider(''); setFormBaseUrl(''); setFormApiKey(''); setFormAlias('');
    setFormModels([]); setCustomModelsText(''); setFormKeyVisible(false); setTestStatus('idle');
    setApiKeyChanged(false); setFormErrors({});
    setModalOpen(true);
  };

  const openEditModal = (profile: any) => {
    setEditingProfileId(profile.id);
    // 🔧 修复 Bug1：后端返回 camelCase，旧代码读 snake_case 导致预设类型恒为 undefined
    const presetType = profile.presetType || profile.provider;
    setSelectedProvider(presetType);
    setFormBaseUrl(profile.baseUrl || '');
    // 🔧 修复：编辑模式回填真实 Key（后端已解密），用户可查看和修改
    // apiKeyChanged 保持 false，保存时若未改动则不覆盖原 Key
    setFormApiKey(profile.apiKey || '');
    setFormAlias(profile.alias || profile.name || '');
    setFormModels(Array.isArray(profile.models) ? profile.models : []);
    setCustomModelsText(Array.isArray(profile.models) ? profile.models.join('\n') : '');
    setFormKeyVisible(false); setTestStatus('idle');
    setApiKeyChanged(false); setFormErrors({});
    setModalStep(presetType ? 'form' : 'provider');
    setModalOpen(true);
  };
  const closeModal = () => setModalOpen(false);

  const selectProvider = (type: string) => {
    setSelectedProvider(type);
    const preset = (PROVIDER_CONFIGS as any)[type];
    setFormBaseUrl(preset?.baseUrl || ''); setFormModels([]); setCustomModelsText('');
    setFormKeyVisible(false); setTestStatus('idle'); setApiKeyChanged(false); setFormErrors({});
    setModalStep('form');
  };
  const togglePresetModel = (model: string) => {
    setFormModels((prev) => prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model]);
  };
  const isCustom = selectedProvider === 'custom';
  // 🔧 修复：仅「新增预设供应商」时 baseUrl 只读（自动填入 preset.baseUrl）
  // 编辑模式（无论预设还是 custom）和新增 custom 模式都允许修改
  const isBaseUrlReadOnly = !editingProfileId && !isCustom;

  /**
   * 保存 Profile（新增/编辑）
   *
   * 推荐方案：模型信息修改与管线绑定联动
   * - 编辑模式下，对比原始模型列表与新模型列表，找出被删除的模型
   * - 查询当前所有绑定，定位引用了被删除模型（且 profileId 匹配）的管线节点
   * - 若存在受影响绑定，弹确认框提示用户
   * - 用户确认后，先清空受影响绑定（upsert 置空），再保存 Profile
   * - 用户取消则中止保存，保留原数据
   */
  const handleSaveProfile = async () => {
    if (!validateForm()) return;
    const baseUrl = formBaseUrl.trim();
    const alias = formAlias.trim();
    const preset = (PROVIDER_CONFIGS as any)[selectedProvider];
    let models: string[];
    if (isCustom) {
      models = customModelsText.split('\n').map((s) => s.trim()).filter(Boolean);
    } else {
      models = formModels;
    }

    // 🔧 联动清理：编辑模式下检测被删除的模型，弹确认框后清空受影响的管线绑定
    if (editingProfileId) {
      const originalProfile = apiProfiles.find((p) => p.id === editingProfileId);
      const originalModels: string[] = Array.isArray(originalProfile?.models)
        ? (originalProfile as any).models
        : [];
      const deletedModels = originalModels.filter((m: string) => !models.includes(m));

      if (deletedModels.length > 0) {
        // 找出引用了被删除模型且绑定到当前 Profile 的管线节点
        const affectedBindings = (Object.values(bindings) as any[]).filter(
          (b) => b?.profileId === editingProfileId && deletedModels.includes(b?.modelName)
        );

        if (affectedBindings.length > 0) {
          const taskList = affectedBindings
            .map((b) => {
              const node = ALL_PIPELINE_NODES.find((n) => n.taskType === b.taskType);
              return node?.label || b.taskType;
            })
            .join('、');
          const confirmMsg =
            `本次修改删除了模型：${deletedModels.join(', ')}\n` +
            `以下管线节点引用了这些模型：${taskList}\n` +
            `保存后将自动清空上述绑定，是否继续？`;
          if (!window.confirm(confirmMsg)) return;

          // 用户确认：先清空受影响的绑定，避免保存后管线节点残留无效 model_name
          for (const b of affectedBindings) {
            try { await window.api?.profileBinding?.upsert(b.taskType, null, ''); } catch {}
          }
          // 乐观更新本地 bindings，保持 UI 与 DB 一致
          setBindings((prev) => {
            const next = { ...prev };
            affectedBindings.forEach((b) => {
              next[b.taskType] = { taskType: b.taskType, profileId: null, modelName: '' };
            });
            return next;
          });
        }
      }
    }

    const profileData: any = {
      name: alias || preset?.name || selectedProvider, provider: selectedProvider,
      baseUrl, models, alias: alias || '',
      enabled: editingProfileId ? undefined : 1,
      isPreset: isCustom ? 0 : 1, presetType: isCustom ? null : selectedProvider,
    };
    // 🔧 修复：编辑模式下仅当用户实际输入了新 Key（apiKeyChanged=true）才传给后端
    // 否则不传 apiKey 字段，后端 update 不会覆盖原 Key
    if (apiKeyChanged && formApiKey.trim()) {
      profileData.apiKey = formApiKey.trim();
    } else if (!editingProfileId) {
      profileData.apiKey = formApiKey.trim();
    }
    try {
      if (editingProfileId) { await window.api?.apiProfile?.update(editingProfileId, profileData); }
      else { await window.api?.apiProfile?.create(profileData); }
      await loadData(); closeModal();
    } catch {}
  };

  const [testFailReason, setTestFailReason] = useState('');
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchHint, setFetchHint] = useState('');

  /**
   * 测试连接：调用 /models 接口验证鉴权
   *
   * 🔧 修复根因：IpcRouter 会把 handler 返回值包装成 { success, data }
   * 旧代码 typeof result === 'string' 永远不成立，导致恒报"后端返回为空"
   * 正确做法：解构 result.data 或 result.error
   */
  const handleTestConnection = async () => {
    if (editingProfileId && !formApiKey.trim()) {
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
    setTestStatus('testing');
    setTestFailReason('');
    try {
      const result: any = await window.api?.ai?.testNetwork?.('openai_like', {
        provider: selectedProvider,
        apiKey: formApiKey.trim(),
        baseURL: formBaseUrl.trim(),
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
   * 调用 OpenAI 兼容 /models 接口，用真实数据覆盖硬编码列表
   * - 成功：用拉取到的模型列表（全选）替换 formModels / customModelsText
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
      // 拉取成功：用真实数据覆盖，默认全选
      setFormModels(models);
      if (isCustom) setCustomModelsText(models.join('\n'));
      setFetchHint(`✓ 拉取成功，共 ${models.length} 个模型（已全选）`);
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
                          <span className="text-[13px] font-medium text-foreground truncate">{displayName}</span>
                          {p.alias && <span className="text-[10px] text-muted-foreground/60 truncate">({providerName})</span>}
                        </div>
                        <span className="text-[10px] text-muted-foreground">
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
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">云模型</span>
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
                      <div className="text-[12px] font-medium text-foreground truncate">{node.label}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{node.desc}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select value={currentModel} onChange={(e) => {
                      const val = e.target.value;
                      if (!val) { handleBindingChange(node.taskType, null, ''); return; }
                      const opt = modelOptions.find((o) => o.modelName === val);
                      handleBindingChange(node.taskType, opt?.profileId || null, val);
                    }} className="flex-1 text-[11px] px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border)] text-foreground outline-none cursor-pointer hover:border-accent/40 min-w-0">
                      <option value="">未绑定</option>
                      {modelOptions.map((opt) => (
                        <option key={`${opt.profileId}:${opt.modelName}`} value={opt.modelName}>
                          {opt.modelName} ({opt.profileName})
                        </option>
                      ))}
                    </select>
                    {boundProviderName && currentModel && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0 max-w-[70px] truncate" title={boundProviderName}>
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
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">本地引擎</span>
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
                      <div className="text-[12px] font-medium text-foreground truncate">{node.label}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{node.desc}</div>
                    </div>
                  </div>
                  <select value={currentVal} onChange={(e) => handleBindingChange(node.taskType, null, e.target.value)}
                    className="text-[11px] px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border)] text-foreground outline-none cursor-pointer hover:border-accent/40">
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
                <div className="text-[12px] font-medium text-foreground truncate">{node.label}</div>
                <div className="text-[10px] text-muted-foreground truncate">{node.desc}</div>
              </div>
            </div>
            <span className="text-[11px] text-muted-foreground italic shrink-0">{(node as any).hint}</span>
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
                  <SelectItem value="moss" className="text-xs">MOSS 本地模型 (需下载)</SelectItem>
                  <SelectItem value="sovits" className="text-xs">本地 SoVITS</SelectItem>
                  <SelectItem value="fish" className="text-xs">Fish Audio (API)</SelectItem>
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
            {currentTts === 'moss' && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground font-medium">MOSS 模型路径</span>
                  <div className="flex gap-3">
                    <Input value={aiData.mossModelDir || ''} onChange={e => handleValChange('mossModelDir', e.target.value)} placeholder="F:\Tools\Zentect\resources\models\moss-tts-nano" className="flex-1 text-xs bg-bg-secondary h-9 border-border/50 font-mono" />
                    <Button variant="outline" onClick={async () => {
                      const dir = await window.api?.ipc?.invoke?.('dialog:openDirectory');
                      if (dir) handleValChange('mossModelDir', dir);
                    }} className="h-9 text-xs text-accent-cyan hover:text-accent-cyan border-accent-cyan/20 bg-accent-cyan/5 hover:bg-accent-cyan/10 px-4 shadow-none shrink-0 gap-1.5 cursor-pointer">
                      <FolderOpen size={13} /> 选择
                    </Button>
                  </div>
                  <span className="text-xs text-muted-foreground mt-1">选择 moss-tts-nano 文件夹所在路径，包含 MOSS-TTS-Nano-100M-ONNX 和 MOSS-Audio-Tokenizer-Nano-ONNX 子目录</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground font-medium">服务地址（自动启动）</span>
                  <Input value={aiData.mossUrl || 'http://127.0.0.1:9881'} onChange={e => handleValChange('mossUrl', e.target.value)} className="text-xs bg-bg-secondary h-9 border-border/50 font-mono" />
                </div>
              </div>
            )}
            {currentTts === 'sovits' && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground font-medium">本地服务端点</span>
                <div className="flex gap-3">
                  <Input value={aiData.sovitsUrl || ''} onChange={e => handleValChange('sovitsUrl', e.target.value)} placeholder="http://127.0.0.1:9880" className="flex-1 text-xs bg-bg-secondary h-9 border-border/50" />
                  <Button variant="outline" onClick={onTestTTS} className="h-9 text-xs text-accent-cyan hover:text-accent-cyan border-accent-cyan/20 bg-accent-cyan/5 hover:bg-accent-cyan/10 px-4 shadow-none shrink-0 gap-1.5">
                    <Server size={13} /> 检测
                  </Button>
                </div>
              </div>
            )}
            {currentTts === 'fish' && (
              <PasswordField label="Fish Audio API Key" value={aiData.fishKey || ''} onChange={(e: any) => handleValChange('fishKey', e.target.value)} onCheck={onTestTTS} linkUrl="https://fish.audio/zh-CN/go-api/" />
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
              <span className="text-[15px] font-semibold text-foreground">{editingProfileId ? '编辑模型' : '添加模型'}</span>
              <button onClick={closeModal} className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--bg-hover)] hover:text-white transition-colors cursor-pointer outline-none text-lg">&times;</button>
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
                  <input className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border)] bg-[var(--input)] text-[13px] text-foreground outline-none focus:border-accent transition-colors" placeholder="给这个配置起个名字，如「我的豆包」「公司Key」" value={formAlias} onChange={(e) => setFormAlias(e.target.value)} />
                </div>
                <div className="mb-3.5">
                  <label className="text-xs text-muted-foreground block mb-1.5">接口地址 <span className="text-[var(--accent-rose)]">*</span></label>
                  {/* 🔧 修复：编辑模式下始终允许修改（用户可能切换 region/代理/转发地址） */}
                  {/* 仅「新增预设供应商」时只读（自动填入 preset.baseUrl），新增 custom 和编辑模式都可改 */}
                  <input className={`w-full px-2.5 py-1.5 rounded-md border bg-[var(--input)] text-[13px] outline-none focus:border-accent transition-colors ${formErrors.baseUrl ? 'border-[var(--accent-rose)]' : 'border-[var(--border)]'} ${isBaseUrlReadOnly ? 'text-muted-foreground' : 'text-foreground'}`} value={formBaseUrl} onChange={(e) => { setFormBaseUrl(e.target.value); if (formErrors.baseUrl) setFormErrors(prev => { const n = {...prev}; delete n.baseUrl; return n; }); }} readOnly={isBaseUrlReadOnly} placeholder="https://api.example.com/v1" />
                  {formErrors.baseUrl && <span className="text-[10px] text-[var(--accent-rose)] mt-1 block">{formErrors.baseUrl}</span>}
                </div>
                <div className="mb-3.5">
                  <label className="text-xs text-muted-foreground block mb-1.5">API Key <span className="text-[var(--accent-rose)]">*</span></label>
                  <div className={`flex items-center border rounded-md bg-[var(--input)] overflow-hidden focus-within:border-accent ${formErrors.apiKey ? 'border-[var(--accent-rose)]' : 'border-[var(--border)]'}`}>
                    <input type={formKeyVisible ? 'text' : 'password'} className="flex-1 px-2.5 py-1.5 bg-transparent text-[13px] text-foreground outline-none font-mono" placeholder="sk-..." value={formApiKey} onChange={(e) => { setFormApiKey(e.target.value); setApiKeyChanged(true); if (formErrors.apiKey) setFormErrors(prev => { const n = {...prev}; delete n.apiKey; return n; }); }} />
                    {/* 🔧 修复：用 Eye/EyeOff 图标替换固定 emoji，点击后有明确视觉反馈 */}
                    <button type="button" onClick={() => setFormKeyVisible(!formKeyVisible)} className="px-2.5 py-1.5 text-muted-foreground hover:text-foreground cursor-pointer outline-none transition-colors">
                      {formKeyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  {/* 🔧 修复：编辑模式回填真实 Key，不再需要"Key 已保存"提示 */}
                  {formErrors.apiKey && <span className="text-[10px] text-[var(--accent-rose)] mt-1 block">{formErrors.apiKey}</span>}
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
                      className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-accent/30 text-accent hover:bg-accent/5 transition-colors cursor-pointer outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                      title="用当前 API Key 调用 /models 接口，拉取账户实际可用的模型列表"
                    >
                      {fetchingModels ? '拉取中...' : '拉取模型'}
                    </button>
                  </div>
                  {isCustom ? (
                    <>
                      <textarea className={`w-full px-2.5 py-1.5 rounded-md border bg-[var(--input)] text-[13px] text-foreground outline-none focus:border-accent resize-y min-h-[64px] leading-relaxed ${formErrors.models ? 'border-[var(--accent-rose)]' : 'border-[var(--border)]'}`} placeholder={`输入模型名称，每行一个，如：\ngpt-4o\nclaude-sonnet-4`} value={customModelsText} onChange={(e) => { setCustomModelsText(e.target.value); if (formErrors.models) setFormErrors(prev => { const n = {...prev}; delete n.models; return n; }); }} />
                      <div className="text-[11px] text-muted-foreground mt-1">每行一个模型名称</div>
                    </>
                  ) : (
                    <div className={`border rounded-md bg-[var(--input)] ${formErrors.models ? 'border-[var(--accent-rose)]' : 'border-[var(--border)]'}`}>
                      <div className="max-h-[140px] overflow-y-auto">
                        {(PROVIDER_CONFIGS as any)[selectedProvider]?.models?.map((model: string) => (
                          <label key={model} className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] transition-colors hover:bg-[var(--bg-hover)] ${formModels.includes(model) ? 'bg-accent/8' : ''}`}>
                            <input type="checkbox" checked={formModels.includes(model)} onChange={() => { togglePresetModel(model); if (formErrors.models) setFormErrors(prev => { const n = {...prev}; delete n.models; return n; }); }} className="accent-[var(--accent)]" /> {model}
                          </label>
                        ))}
                        {/* 🔧 修复：显示已保存但不在预设列表中的额外模型（可取消勾选） */}
                        {formModels.filter((m: string) => !(PROVIDER_CONFIGS as any)[selectedProvider]?.models?.includes(m)).map((model: string) => (
                          <label key={model} className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] transition-colors hover:bg-[var(--bg-hover)] ${formModels.includes(model) ? 'bg-accent/8' : ''}`}>
                            <input type="checkbox" checked={formModels.includes(model)} onChange={() => { togglePresetModel(model); if (formErrors.models) setFormErrors(prev => { const n = {...prev}; delete n.models; return n; }); }} className="accent-[var(--accent)]" />
                            {model}
                            <span className="text-[10px] text-muted-foreground ml-auto">自定义</span>
                          </label>
                        ))}
                      </div>
                      {/* 🔧 修复：预设模式下也允许追加自定义模型 */}
                      <div className="border-t border-[var(--border)] p-2">
                        <input className="w-full px-2 py-1 text-[12px] bg-transparent text-foreground outline-none border border-[var(--border)] rounded focus:border-accent" placeholder="追加自定义模型名，回车添加" onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const val = (e.target as HTMLInputElement).value.trim();
                            if (val && !formModels.includes(val)) {
                              setFormModels((prev) => [...prev, val]);
                              (e.target as HTMLInputElement).value = '';
                            }
                          }
                        }} />
                      </div>
                    </div>
                  )}
                  {formErrors.models && <span className="text-[10px] text-[var(--accent-rose)] mt-1 block">{formErrors.models}</span>}
                  {/* 拉取结果提示 */}
                  {fetchHint && (
                    <div className={`text-[11px] mt-1 ${fetchHint.startsWith('✓') ? 'text-[var(--accent-green)]' : 'text-muted-foreground'}`}>{fetchHint}</div>
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
                      <span className="text-[10px] text-[var(--accent-rose)]/70 max-w-[280px] truncate" title={testFailReason}>{testFailReason}</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={closeModal} className="px-4 py-1.5 rounded-md border border-[var(--border)] bg-transparent text-muted-foreground text-[13px] cursor-pointer hover:border-[var(--bg-elevated)] hover:text-foreground transition-colors outline-none">取消</button>
                    <button onClick={handleSaveProfile} className="px-4 py-1.5 rounded-md border-none bg-[var(--accent)] text-white text-[13px] font-medium cursor-pointer hover:opacity-90 transition-opacity outline-none">保存</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== 删除确认 Modal ===== */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[14px] w-[360px] p-[26px]">
            <div className="text-[15px] font-semibold text-foreground mb-3">确认删除</div>
            <div className="text-[13px] text-muted-foreground mb-4 leading-relaxed">
              确定删除「<strong className="text-foreground">{deleteTarget.alias || deleteTarget.name || deleteTarget.provider}</strong>」的配置？<br />
              删除后不可恢复，正在使用此供应商的管线节点将退回到未绑定状态。
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-1.5 rounded-md border border-[var(--border)] bg-transparent text-muted-foreground text-[13px] cursor-pointer hover:border-[var(--bg-elevated)] hover:text-foreground transition-colors outline-none">取消</button>
              <button onClick={handleDelete} className="px-4 py-1.5 rounded-md border-none bg-[var(--accent-rose)] text-white text-[13px] font-medium cursor-pointer hover:opacity-90 transition-opacity outline-none">确认删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
