// 📁 路径：src/renderer/src/pages/editor/components/inspectors/configs/ScriptGenConfig.tsx
import React from 'react';
import { Slider } from '../../../../../components/ui/slider';
import { Switch } from '../../../../../components/ui/switch';
import { Textarea } from '../../../../../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../../components/ui/select';
import { BrainCircuit, Sparkles, MessageSquare } from 'lucide-react';

interface ScriptGenConfigProps {
  data: any;
  updateParams: (payload: any) => void;
}

export const ScriptGenConfig: React.FC<ScriptGenConfigProps> = ({ data, updateParams }) => {
  return (
    <div className="space-y-5 animate-in fade-in duration-300">
       
       {/* --- 1. 核心 AI 引擎与语言 --- */}
       <div className="space-y-3">
          <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest border-b border-zinc-800 pb-1 flex items-center gap-1.5">
             <BrainCircuit size={12} /> 引擎与输出目标
          </div>
          
          <div className="grid grid-cols-2 gap-3">
             <div className="flex flex-col gap-1.5">
                <label className="text-[11px] text-zinc-300">推理大模型</label>
                <Select value={data.llmEngine || 'deepseek-v3'} onValueChange={(v) => updateParams({ llmEngine: v })}>
                   <SelectTrigger className="h-7 text-[11px] bg-background border-zinc-800">
                      <SelectValue />
                   </SelectTrigger>
                   <SelectContent>
                      <SelectItem value="gpt-4o">GPT-4o (逻辑最优)</SelectItem>
                      <SelectItem value="claude-3-5">Claude 3.5 (文笔最佳)</SelectItem>
                      <SelectItem value="deepseek-v3">DeepSeek V3 (性价比)</SelectItem>
                   </SelectContent>
                </Select>
             </div>
             
             <div className="flex flex-col gap-1.5">
                <label className="text-[11px] text-zinc-300">输出语种 (含配音适配)</label>
                <Select value={data.targetLanguage || 'zh'} onValueChange={(v) => updateParams({ targetLanguage: v })}>
                   <SelectTrigger className="h-7 text-[11px] bg-background border-zinc-800 text-blue-400">
                      <SelectValue />
                   </SelectTrigger>
                   <SelectContent>
                      <SelectItem value="zh">中文 (普通话)</SelectItem>
                      <SelectItem value="fr">法语 (Français) - 国际化</SelectItem>
                      <SelectItem value="en">英语 (English)</SelectItem>
                      <SelectItem value="ja">日语 (日本語)</SelectItem>
                   </SelectContent>
                </Select>
             </div>
          </div>
       </div>

       {/* --- 2. 创作流派与网感预设 --- */}
       <div className="space-y-3 p-3 bg-zinc-900/50 border border-zinc-800/80 rounded-md">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-300 pb-1">
             <Sparkles size={12} className="text-purple-400" /> 剧本流派与网感
          </div>
          
          <Select value={data.scriptStyle || 'workplace_drama'} onValueChange={(v) => updateParams({ scriptStyle: v })}>
             <SelectTrigger className="h-8 text-[11px] bg-zinc-950 border-zinc-800 text-zinc-200">
                <SelectValue placeholder="选择剧本预设流派" />
             </SelectTrigger>
             <SelectContent>
                <SelectItem value="workplace_drama">职场爽文 (高反转/打脸)</SelectItem>
                <SelectItem value="domestic_conflict">家庭抓马 (夫妻逻辑冲突)</SelectItem>
                <SelectItem value="nonsense_humor">废话文学 (荒诞无厘头)</SelectItem>
                <SelectItem value="movie_recap">经典影视解说 (悬疑感)</SelectItem>
                <SelectItem value="custom">完全自定义</SelectItem>
             </SelectContent>
          </Select>

          {/* 只有选择了具体预设，才显示生成目标时长 */}
          <div className="pt-2 space-y-3">
            <div className="flex justify-between items-center">
               <label className="text-[11px] text-zinc-400">目标完播时长限制</label>
               <span className="text-[10px] text-zinc-400 font-mono bg-zinc-950 px-1.5 py-0.5 rounded border border-zinc-800">
                 约 {data.targetDuration || 60} 秒
               </span>
            </div>
            <Slider 
               value={[data.targetDuration || 60]} min={15} max={180} step={15} 
               onValueChange={(v) => updateParams({ targetDuration: v[0] })} 
            />
            <p className="text-[9px] text-zinc-500">AI 将根据语速自动控制字数（中文约 4 字/秒，外语约 2.5 词/秒）</p>
          </div>
       </div>

       {/* --- 3. 自定义系统指令 (System Prompt) --- */}
       <div className="space-y-2">
          <div className="flex justify-between items-center">
             <label className="text-[11px] text-zinc-300 flex items-center gap-1.5">
               <MessageSquare size={12} /> 导演系统指令 (System Prompt)
             </label>
             <Switch 
               checked={data.useCustomPrompt ?? true} 
               onCheckedChange={(v) => updateParams({ useCustomPrompt: v })} 
             />
          </div>
          
          <div className={`transition-all duration-200 ${data.useCustomPrompt ?? true ? 'opacity-100 h-auto' : 'opacity-50 pointer-events-none'}`}>
             <Textarea 
               value={data.customPrompt || ''}
               onChange={(e) => updateParams({ customPrompt: e.target.value })}
               placeholder="例如：你是一个毒舌电影解说，请用极其夸张和逻辑谬误的方式，将提取到的画面重写为一段包含夫妻争吵情节的台词。避免出现具体的品牌名，用通用道具替代。"
               className="min-h-[100px] text-[11px] bg-background border-zinc-800 text-zinc-300 resize-y focus-visible:ring-1 focus-visible:ring-purple-500 p-2.5 leading-relaxed placeholder:text-zinc-600"
             />
          </div>
       </div>

       {/* --- 4. 底层采样参数 --- */}
       <div className="space-y-3 pt-2 border-t border-zinc-800">
          <div className="flex justify-between items-center">
             <label className="text-[11px] text-zinc-300">AI 想象力 (Temperature)</label>
             <span className="text-[10px] text-zinc-400 font-mono bg-zinc-900 px-1.5 rounded">{data.temperature || 0.7}</span>
          </div>
          <Slider 
             value={[data.temperature || 0.7]} min={0.0} max={2.0} step={0.1} 
             onValueChange={(v) => updateParams({ temperature: v[0] })} 
          />
          <div className="flex justify-between text-[9px] text-zinc-500 font-mono pt-0.5">
             <span>0.0 (严谨死板)</span>
             <span>2.0 (天马行空)</span>
          </div>
       </div>

    </div>
  );
};