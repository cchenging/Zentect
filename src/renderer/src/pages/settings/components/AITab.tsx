// 📁 路径: src/renderer/src/pages/settings/components/AITab.tsx
// AI 服务配置 Tab - V3 设计系统风格
// 专注于 LLM 供应商配置 + 管线模型映射 + TTS 配置
// 本地模型管理已移至独立 ModelTab
import React, { useState } from 'react';
import { Eye, EyeOff, Server, Play, ExternalLink, ChevronDown, ChevronUp, Zap, AlertCircle, FolderOpen } from 'lucide-react';
import { Input } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select';
import { ApiProfileManager } from '../../../components/shared/ApiProfileManager';
import { FormField } from '../../../components/ui/form-field';

interface AITabProps {
  data: any;
  onUpdate: (section: string, key: string, value: any) => void;
  onTest: (type: string, providerName: string, configData: any, saveKey?: string) => void;
  onTestTTS: () => void;
  isTesting: boolean;
  modelPool: string[];
}

/** 供应商配置定义 */
const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek 深度求索', keyField: 'deepseekKey', modelsField: 'deepseekModels', baseURL: 'https://api.deepseek.com/v1', link: 'https://platform.deepseek.com/', color: '#6366f1', hasBaseUrl: false },
  { id: 'qwen', name: '阿里云 通义千问', keyField: 'qwenKey', modelsField: 'qwenModels', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', link: 'https://dashscope.console.aliyun.com/api-key', color: '#8b5cf6', hasBaseUrl: false },
  { id: 'tencent', name: '腾讯 混元大模型', keyField: 'tencentKey', modelsField: 'tencentModels', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', link: 'https://console.cloud.tencent.com/hunyuan/api-key', color: '#06b6d4', hasBaseUrl: false },
  { id: 'doubao', name: '字节跳动 豆包大模型', keyField: 'doubaoKey', modelsField: 'doubaoModels', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', link: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', color: '#f59e0b', hasBaseUrl: false },
  { id: 'openai', name: 'OpenAI 协议中转', keyField: 'openaiKey', modelsField: 'openaiModels', baseURL: '', link: 'https://cloud.siliconflow.cn/', color: '#22c55e', hasBaseUrl: true },
];

/** 管线节点映射定义 - V3 原型6节点
 *  💥 关键设计：LLM 类节点的选项从用户配置的 modelPool 动态生成，
 *  本地引擎类节点（音频分离/ASR/TTS）保留固定选项
 */
const PIPELINE_NODES = [
  { key: 'taskAudioSeparate', label: '音频分离', icon: '🎵', localOptions: ['本地轻量模型', 'Spleeter', 'UVR5'] },
  { key: 'taskASR', label: '台词识别 (ASR)', icon: '🎤', localOptions: ['Whisper 本地版', 'SenseVoiceSmall'] },
  { key: 'taskVisualModel', label: 'VLM 图片分析', icon: '👁️', useModelPool: true },
  { key: 'taskSentiment', label: '情绪识别', icon: '😊', useModelPool: true },
  { key: 'taskScriptModel', label: 'AI 故事生成', icon: '✍️', useModelPool: true },
  { key: 'taskTTS', label: 'TTS 配音合成', icon: '🎙️', localOptions: ['Edge TTS', '本地 SoVITS', 'Fish Audio', '火山引擎'] },
] as const;

/**
 * 密码输入字段组件（含内联校验）
 */
const PasswordField = ({ label, value, onChange, onCheck, linkUrl, placeholder = "sk-...", forceShow }: any) => {
  const [localShow, setLocalShow] = useState(false);
  const [touched, setTouched] = useState(false);
  const isRevealed = forceShow || localShow;
  const hasValue = !!value;

  const validateApiKey = (val: string): string | null => {
    if (touched && (!val || val.trim() === '')) {
      return 'API Key 不能为空';
    }
    if (val && val.trim().length < 10) {
      return 'API Key 格式不正确，长度不足';
    }
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
        <div className="text-[10px] mt-0.5 pl-0.5">
          <span className="text-muted-foreground mr-1.5">没有密钥？</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.open(linkUrl, '_blank'); }} className="text-accent hover:underline cursor-pointer">点击获取</a>
        </div>
      )}
    </FormField>
  );
};

/**
 * AI 服务配置 Tab
 * 供应商卡片 + 管线模型映射 + TTS 配置
 */
export const AITab: React.FC<AITabProps> = ({ data, onUpdate, onTest, onTestTTS, isTesting: _isTesting, modelPool }) => {
  const aiData = data || {};
  const [expandedProvider, setExpandedProvider] = useState<string | null>('deepseek');
  const [showAllKeys, setShowAllKeys] = useState(false);
  const [currentTts, setCurrentTts] = useState(aiData.ttsProvider || 'edge');

  /** 更新 AI 配置值 */
  const handleValChange = (field: string, val: any) => {
    onUpdate('ai', field, val);
    if (field === 'ttsProvider') setCurrentTts(val);
  };

  /** 切换供应商卡片展开 */
  const toggleProvider = (id: string) => {
    setExpandedProvider(prev => prev === id ? null : id);
  };

  return (
    <div className="space-y-8 animate-fade-in-up">
      {/* ===== API Key 获取引导 ===== */}
      <div className="glass-card-sm p-4 flex flex-col gap-3 glow-border-accent">
        <div className="flex items-center gap-2">
          <ExternalLink size={15} className="text-accent" />
          <span className="text-sm font-medium text-foreground">获取 API Key</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          使用 Zentect 需要第三方云服务的 API Key，点击下方链接注册并获取。
        </p>
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map(p => (
            <a key={p.id} href="#" onClick={(e) => { e.preventDefault(); if (p.link) window.open(p.link, '_blank'); }}
               className="text-[10px] text-accent hover:underline flex items-center gap-1 px-2 py-1 rounded-md bg-accent/5 hover:bg-accent/10 transition-colors">
              <ExternalLink size={10} /> {p.name.split(' ')[0]}
            </a>
          ))}
        </div>
      </div>

      {/* ===== LLM 供应商配置 ===== */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-accent" />
            <h3 className="text-base font-semibold text-foreground">大语言模型 (LLM) 配置</h3>
          </div>
          <button
            onClick={() => setShowAllKeys(!showAllKeys)}
            className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg border transition-all outline-none cursor-pointer shrink-0 border-border/50 bg-bg-secondary/50 text-muted-foreground hover:border-accent/40 hover:text-foreground"
          >
            {showAllKeys ? <EyeOff size={12} /> : <Eye size={12} />}
            {showAllKeys ? '隐藏密钥' : '显示密钥'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">`r`n          {PROVIDERS.map((provider) => {
            const isExpanded = expandedProvider === provider.id;
            const hasKey = !!(aiData as any)[provider.keyField];

            return (
              <div key={provider.id} className="glass-card-sm overflow-hidden">
                {/* 供应商标题行 */}
                <button
                  onClick={() => toggleProvider(provider.id)}
                  className="w-full flex items-center justify-between p-4 cursor-pointer outline-none hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: provider.color }} />
                    <span className="text-[13px] font-semibold text-foreground">{provider.name}</span>
                    {hasKey && <span className="badge-success">已配置</span>}
                  </div>
                  {isExpanded ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
                </button>

                {/* 展开的配置内容 */}
                {isExpanded && (
                  <div className="px-4 pb-4 pt-0 flex flex-col gap-4 border-t border-border/30">
                    {/* OpenAI 中转的 Base URL */}
                    {provider.hasBaseUrl && (
                      <div className="flex flex-col gap-1.5 mt-4">
                        <span className="text-xs text-muted-foreground font-medium">代理地址 (Base URL)</span>
                        <Input value={aiData.openaiBaseUrl || ''} onChange={e => handleValChange('openaiBaseUrl', e.target.value)} placeholder="https://api.siliconflow.cn/v1" className="text-xs bg-bg-secondary h-9 border-border/50" />
                      </div>
                    )}

                    {/* API Key */}
                    <div className={provider.hasBaseUrl ? '' : 'mt-4'}>
                      <PasswordField
                        label="API Key"
                        value={(aiData as any)[provider.keyField] || ''}
                        onChange={(e: any) => handleValChange(provider.keyField, e.target.value)}
                        onCheck={() => onTest('openai_like', provider.name, { provider: provider.id, apiKey: (aiData as any)[provider.keyField] || '', baseURL: provider.hasBaseUrl ? aiData.openaiBaseUrl : provider.baseURL }, provider.keyField)}
                        linkUrl={provider.link}
                        forceShow={showAllKeys}
                      />
                    </div>

                    {/* 模型列表 */}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs text-muted-foreground font-medium">支持的模型列表</span>
                      <Input value={(aiData as any)[provider.modelsField]?.join(', ') || ''} onChange={e => handleValChange(provider.modelsField, e.target.value.split(','))} className="text-xs bg-bg-secondary h-9 border-border/50" />
                    </div>
                    <ApiProfileManager provider={provider.id} hasBaseUrl={provider.hasBaseUrl} defaultBaseUrl={provider.baseURL} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ===== 管线模型调度映射 ===== */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <Server size={18} className="text-accent-cyan" />
          <h3 className="text-base font-semibold text-foreground">管线-模型映射</h3>
        </div>
        <p className="text-[11px] text-muted-foreground mb-4">为每个管线节点选择使用的模型供应商</p>
        <div className="glass-card-sm p-5 flex flex-col gap-4">
          {PIPELINE_NODES.map((node) => {
            /** LLM 节点从用户配置的 modelPool 动态取选项，本地引擎节点用固定选项 */
            const options: string[] = 'useModelPool' in node
              ? (modelPool && modelPool.length > 0 ? modelPool : [])
              : (node as any).localOptions || [];
            const currentValue = (aiData as any)[node.key];
            /** 当前值不在选项中时（旧数据或手动输入），追加到选项列表保证显示 */
            const finalOptions = currentValue && !options.includes(currentValue)
              ? [currentValue, ...options]
              : options;

            return (
              <div key={node.key} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{node.icon}</span>
                  <span className="text-xs text-foreground font-medium">{node.label}</span>
                </div>
                <Select value={currentValue} onValueChange={v => handleValChange(node.key, v)}>
                  <SelectTrigger className="w-56 h-9 text-xs bg-bg-secondary border-border/50">
                    <SelectValue placeholder={finalOptions.length > 0 ? '选择模型' : '请先配置供应商模型'} />
                  </SelectTrigger>
                  <SelectContent className="bg-bg-tertiary border-border/50">
                    {finalOptions.map((opt: string) => (
                      <SelectItem key={opt} value={opt} className="text-xs">{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
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
              <span className="text-[10px] text-muted-foreground">选择 TTS 语音合成引擎</span>
            </div>
            <div className="flex items-center gap-3">
              <Select value={aiData.ttsProvider} onValueChange={v => handleValChange('ttsProvider', v)}>
                <SelectTrigger className="w-44 h-9 text-xs bg-bg-secondary border-border/50">
                  <SelectValue />
                </SelectTrigger>
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

          {/* TTS 引擎子配置 */}
          <div className="pt-4 border-t border-border/30">
            {currentTts === 'edge' && (
              <div className="text-xs text-accent-green bg-accent-green/10 p-3 rounded-lg border border-accent-green/20 flex items-center gap-2">
                该引擎为免费开源接口，无需额外配置任何密钥。
              </div>
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
                  <span className="text-[10px] text-muted-foreground mt-1">选择 moss-tts-nano 文件夹所在路径，包含 MOSS-TTS-Nano-100M-ONNX 和 MOSS-Audio-Tokenizer-Nano-ONNX 子目录</span>
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
              <PasswordField
                label="Fish Audio API Key"
                value={aiData.fishKey || ''}
                onChange={(e: any) => handleValChange('fishKey', e.target.value)}
                onCheck={onTestTTS}
                linkUrl="https://fish.audio/zh-CN/go-api/"
              />
            )}

            {currentTts === 'doubao' && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground font-medium">火山引擎 App ID</span>
                  <Input value={aiData.doubaoTtsAppId || ''} onChange={e => handleValChange('doubaoTtsAppId', e.target.value)} className="text-xs bg-bg-secondary h-9 border-border/50" />
                </div>
                <PasswordField
                  label="火山引擎 Access Token"
                  value={aiData.doubaoTtsToken || ''}
                  onChange={(e: any) => handleValChange('doubaoTtsToken', e.target.value)}
                  onCheck={() => onTest('doubao_tts', '火山引擎语音服务', { appId: aiData.doubaoTtsAppId, token: aiData.doubaoTtsToken })}
                  linkUrl="https://console.volcengine.com/speech/app"
                />
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
