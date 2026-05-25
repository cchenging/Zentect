// 📁 路径：src/renderer/src/pages/editor/components/inspectors/configs/TTSConfig.tsx
import React from 'react';
import { Slider } from '../../../../../components/ui/slider';
import { Switch } from '../../../../../components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../../components/ui/select';
import { User, Settings2, Sparkles } from 'lucide-react';

interface TTSConfigProps {
  data: any;
  updateParams: (payload: any) => void;
}

export const TTSConfig: React.FC<TTSConfigProps> = ({ data, updateParams }) => {
  return (
    <div className="space-y-5 animate-in fade-in duration-300">
       
       {/* --- 1. 音色配置 --- */}
       <div className="space-y-3">
          <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest border-b border-zinc-800 pb-1 flex items-center gap-1.5">
             <User size={12} /> 发音人与音色
          </div>
          
          <div className="flex flex-col gap-2">
             <label className="text-[11px] text-zinc-300">解说配音音色（全局）</label>
             <Select value={data.voiceId || 'zh-CN-YunxiNeural'} onValueChange={(v) => updateParams({ voiceId: v })}>
                <SelectTrigger className="h-8 text-[11px] bg-background border-zinc-800 text-blue-400">
                   <SelectValue />
                </SelectTrigger>
                <SelectContent>
                   <SelectItem value="zh-CN-YunxiNeural">云希 (阳光男声/解说标配)</SelectItem>
                   <SelectItem value="zh-CN-XiaoxiaoNeural">晓晓 (温暖女声)</SelectItem>
                   <SelectItem value="zh-CN-YunyeNeural">云野 (成熟男声)</SelectItem>
                   <SelectItem value="custom-clone-01">🌟 [克隆音色] 毒舌导演</SelectItem>
                   <SelectItem value="moss-narrative">🧠 沉稳叙事 (本地TTS)</SelectItem>
                   <SelectItem value="moss-emotional">🧠 情感丰富 (本地TTS)</SelectItem>
                   <SelectItem value="moss-brisk">🧠 轻快解说 (本地TTS)</SelectItem>
                </SelectContent>
             </Select>
          </div>

          <div className="flex flex-col gap-2 pt-1">
             <div className="flex justify-between items-center">
               <label className="text-[11px] text-zinc-300">发音风格 (Style)</label>
               <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                 PRO 专属
               </span>
             </div>
             <Select value={data.voiceStyle || 'neutral'} onValueChange={(v) => updateParams({ voiceStyle: v })}>
                <SelectTrigger className="h-7 text-[11px] bg-background border-zinc-800">
                   <SelectValue />
                </SelectTrigger>
                <SelectContent>
                   <SelectItem value="neutral">自然平静 (Neutral)</SelectItem>
                   <SelectItem value="cheerful">激情激昂 (Cheerful)</SelectItem>
                   <SelectItem value="angry">愤怒/抓马 (Angry)</SelectItem>
                   <SelectItem value="sad">低沉悲伤 (Sad)</SelectItem>
                </SelectContent>
             </Select>
          </div>
       </div>

       {/* --- 2. 声音表现力微调 --- */}
       <div className="space-y-4 p-3 bg-zinc-900/50 border border-zinc-800/80 rounded-md">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-300 pb-1 border-b border-zinc-800/50">
             <Settings2 size={12} className="text-emerald-400" /> 表现力参数
          </div>

          <div className="space-y-3 pt-1">
            <div className="flex justify-between items-center">
               <label className="text-[11px] text-zinc-400">全局语速 (Speed)</label>
               <span className="text-[10px] text-zinc-400 font-mono bg-zinc-950 px-1.5 py-0.5 rounded border border-zinc-800">
                 {data.speed || 1.0}x
               </span>
            </div>
            <Slider 
               value={[data.speed || 1.0]} min={0.5} max={2.0} step={0.1} 
               onValueChange={(v) => updateParams({ speed: v[0] })} 
            />
          </div>

          <div className="space-y-3 pt-2">
            <div className="flex justify-between items-center">
               <label className="text-[11px] text-zinc-400">情感强度 (Style Degree)</label>
               <span className="text-[10px] text-zinc-400 font-mono bg-zinc-950 px-1.5 py-0.5 rounded border border-zinc-800">
                 {data.styleDegree || 1.0}
               </span>
            </div>
            <Slider 
               value={[data.styleDegree || 1.0]} min={0.1} max={2.0} step={0.1} 
               disabled={data.voiceStyle === 'neutral'}
               onValueChange={(v) => updateParams({ styleDegree: v[0] })} 
            />
          </div>
       </div>

       {/* --- 3. 剧本与多角色联动 [V1.1] --- */}
       <div className="space-y-2 pt-2 border-t border-zinc-800 opacity-50 pointer-events-none">
          <div className="flex items-center justify-between">
             <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-zinc-300 flex items-center gap-1.5">
                  <Sparkles size={11} className="text-amber-400"/> 启用多角色智能分发 [V1.1]
                </span>
                <span className="text-[9px] text-zinc-500 max-w-[200px]">
                  V1.0 统一使用一种解说音色，暂不支持按角色分配独立音色。
                </span>
             </div>
             <Switch 
               checked={data.useMultiRole ?? true} 
               onCheckedChange={(v) => updateParams({ useMultiRole: v })} 
             />
          </div>
       </div>

    </div>
  );
};