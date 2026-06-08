import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../../components/ui/select';
import { useI18n } from '../../../../../store/useI18n';
// 💥 导入全局协议处理器
import { getSafeMediaUrl } from '../../../../../utils/formatUrl';

interface AudioSeparateConfigProps {
  nodeId: string;
  data: any;
  updateParams: (params: any) => void;
}

const _ENABLE_CLOUD_AUDIO = false as const;
void _ENABLE_CLOUD_AUDIO;

export const AudioSeparateConfig: React.FC<AudioSeparateConfigProps> = ({ nodeId: _nodeId, data, updateParams }) => {
  const { t } = useI18n();
  const params = data.params || {};
  
  // 💥 强力提取 results
  const results = data.results || {};
  const computeMode = params.computeMode || 'local';
  const model = params.model || 'htdemucs';
  const isolateType = params.isolateType || 'vocals_bgm';

  const handleParamChange = (key: string, value: string) => {
    updateParams({ ...params, [key]: value });
  };

  // 渲染单条轨道
  const renderTrack = (labelKey: string, url: string | undefined, isExcluded: boolean) => {
    // 💥 修复：调用全局协议洗地，确保拿到的是 magic:// 前缀的安全路径
    const safeAudioUrl = url ? getSafeMediaUrl(url) : '';

    return (
      <div className={`flex flex-col gap-1.5 p-3 rounded border ${isExcluded ? 'bg-gray-900/30 border-gray-800 opacity-50' : 'bg-black/20 border-gray-700'}`}>
        <div className="flex justify-between items-center">
          <span className="text-[11px] font-medium text-gray-400">{t.panel?.audio?.[labelKey] || (labelKey === 'vocalTrack' ? '人声轨道' : '伴奏轨道')}</span>
          {isExcluded && <span className="text-[10px] text-gray-600 px-1.5 py-0.5 bg-gray-800 rounded">{t.panel?.audio?.notExtracted || '未提取'}</span>}
        </div>
        {!isExcluded && (
          safeAudioUrl ? (
             // 💥 强制添加 key 属性，当 url 变化时强制重新挂载 audio 标签，防止浏览器缓存卡死
            <audio key={safeAudioUrl} controls src={safeAudioUrl} className="h-6 w-full filter invert opacity-80" preload="metadata" />
          ) : (
            <div className="h-6 flex items-center text-[10px] text-gray-500 italic">{t.panel?.audio?.waiting || '等待处理...'}</div>
          )
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-5 py-2 px-1">
      {/* 引擎切换 - 紧凑行 */}
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-gray-400 whitespace-nowrap">{t.panel?.audio?.routeLabel || '推理引擎'}</span>
        <div className="flex bg-gray-900 p-1 rounded-md border border-gray-800">
          {['local', 'cloud'].map(mode => (
            <button
              key={mode}
              disabled={mode === 'cloud'}
              onClick={() => handleParamChange('computeMode', mode)}
              className={`px-3 py-1 text-[10px] rounded transition-all ${
                computeMode === mode ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500'
              } ${mode === 'cloud' ? 'opacity-30 cursor-not-allowed' : ''}`}
            >
              {mode === 'local' ? (t.panel?.audio?.localGpu || '本地显卡') : (t.panel?.audio?.cloudApi || '云端 API (锁定)')}
            </button>
          ))}
        </div>
      </div>

      {/* 参数配置组 */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] text-gray-500">{t.panel?.audio?.modelLabel || 'AI 模型'}</label>
          <Select value={model} onValueChange={(v) => handleParamChange('model', v)}>
            <SelectTrigger className="h-8 text-xs bg-gray-900 border-gray-800">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="htdemucs">HTDemucs</SelectItem>
              <SelectItem value="mdx-net">MDX-Net HQ</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] text-gray-500">{t.panel?.audio?.modeLabel || '分离模式'}</label>
          <Select value={isolateType} onValueChange={(v) => handleParamChange('isolateType', v)}>
            <SelectTrigger className="h-8 text-xs bg-gray-900 border-gray-800">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vocals_bgm">{t.panel?.audio?.modeAll || '人声 + 伴奏'}</SelectItem>
              <SelectItem value="vocals_only">{t.panel?.audio?.modeVocal || '仅人声'}</SelectItem>
              <SelectItem value="bgm_only">{t.panel?.audio?.modeBgm || '仅伴奏'}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 试听总线映射区 */}
      <div className="flex flex-col gap-2 mt-2">
        <span className="text-[10px] font-bold text-gray-600 uppercase tracking-tighter">{t.panel?.audio?.auditionLabel || '结果预览'}</span>
        {renderTrack('vocalTrack', results.vocalUrl, isolateType === 'bgm_only')}
        {renderTrack('bgmTrack', results.bgmUrl, isolateType === 'vocals_only')}
      </div>
    </div>
  );
};