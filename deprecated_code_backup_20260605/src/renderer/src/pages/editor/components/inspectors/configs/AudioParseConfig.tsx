// 📁 路径：src/renderer/src/pages/editor/components/inspectors/configs/AudioParseConfig.tsx
import React from 'react';
import { Slider } from '../../../../../components/ui/slider';
import { Switch } from '../../../../../components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../../components/ui/select';
import { Mic2, AlignLeft } from 'lucide-react';

interface AudioParseConfigProps {
  data: any;
  updateParams: (payload: any) => void;
}

export const AudioParseConfig: React.FC<AudioParseConfigProps> = ({ data, updateParams }) => {
  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      {/* --- 1. 核心识别引擎配置 --- */}
      <div className="space-y-3">
        <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest border-b border-zinc-800 pb-1 flex items-center gap-1.5">
          <Mic2 size={12} /> 识别引擎配置
        </div>
        
        <div className="flex flex-col gap-2">
          <label className="text-[11px] text-zinc-300">声学模型精度 (Model Size)</label>
          <Select value={data.modelSize || 'base'} onValueChange={(v) => updateParams({ modelSize: v })}>
            <SelectTrigger className="h-7 text-[11px] bg-background border-zinc-800">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tiny">Tiny (极速/显存占用极小)</SelectItem>
              <SelectItem value="base">Base (性能与精度均衡)</SelectItem>
              <SelectItem value="large">Large-V3 (极高精度/耗时较长)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2 pt-1">
          <label className="text-[11px] text-zinc-300">强制语言对齐 (Language)</label>
          <Select value={data.language || 'auto'} onValueChange={(v) => updateParams({ language: v })}>
            <SelectTrigger className="h-7 text-[11px] bg-background border-zinc-800 text-blue-400">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">🤖 自动检测语言</SelectItem>
              <SelectItem value="zh">🇨🇳 中文 (Mandarin)</SelectItem>
              <SelectItem value="en">🇺🇸 英文 (English)</SelectItem>
              <SelectItem value="ja">🇯🇵 日语 (Japanese)</SelectItem>
            </SelectContent>
          </Select>
          {data.language === 'auto' && (
            <span className="text-[9px] text-zinc-500">建议在多语言混杂时指定具体语言以提高准确率。</span>
          )}
        </div>
      </div>

      {/* --- 2. 深度处理与格式 --- */}
      <div className="space-y-3 p-3 bg-zinc-900/50 border border-zinc-800/80 rounded-md">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-300 pb-1">
          <AlignLeft size={12} className="text-purple-400" /> 字幕与时间戳过滤
        </div>
        
        <div className="flex items-center justify-between pt-1">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-zinc-300">词级时间戳 (Word-level)</span>
            <span className="text-[9px] text-zinc-500">用于生成卡拉OK高亮样式的字幕</span>
          </div>
          <Switch 
            checked={data.wordLevelTimestamps ?? false} 
            onCheckedChange={(v) => updateParams({ wordLevelTimestamps: v })} 
          />
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-zinc-300">VAD 底噪与静音过滤</span>
            <span className="text-[9px] text-zinc-500">自动剔除无有效语音的片段</span>
          </div>
          <Switch 
            checked={data.useVAD ?? true} 
            onCheckedChange={(v) => updateParams({ useVAD: v })} 
          />
        </div>

        {data.useVAD && (
          <div className="pt-2 pl-2 border-l-2 border-zinc-800 space-y-3">
            <div className="flex justify-between items-center">
              <label className="text-[10px] text-zinc-400">静音判定阈值</label>
              <span className="text-[9px] text-zinc-500 font-mono bg-zinc-950 px-1 rounded border border-zinc-800">
                {data.vadThreshold || -40} dB
              </span>
            </div>
            <Slider 
              value={[data.vadThreshold || -40]} min={-60} max={-10} step={5} 
              onValueChange={(v) => updateParams({ vadThreshold: v[0] })} 
            />
          </div>
        )}
      </div>
    </div>
  );
};