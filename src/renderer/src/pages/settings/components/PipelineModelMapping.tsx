import React, { useState, useEffect } from "react";
import { Server } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";

const PIPELINE_NODES = [
  { key: "taskAudioSeparate", label: "音频分离", icon: "🎵", localOptions: ["本地分离模型", "Spleeter", "UVR5"], bindingKey: "" },
  { key: "taskASR", label: "台词识别 (ASR)", icon: "🎤", localOptions: ["Whisper 本地版", "SenseVoiceSmall"], bindingKey: "" },
  { key: "taskVisualModel", label: "VLM 画面分析", icon: "👁", useModelPool: true, bindingKey: "visual" },
  { key: "taskSentiment", label: "情绪识别", icon: "💭", useModelPool: true, bindingKey: "translate" },
  { key: "taskScriptModel", label: "AI 解说文案", icon: "✍", useModelPool: true, bindingKey: "script" },
  { key: "taskTTS", label: "TTS 配音合成", icon: "🔊", localOptions: ["Edge TTS", "本地 SoVITS", "Fish Audio", "火山引擎"], bindingKey: "tts" },
] as const;

interface ProfileOption { id: string; name: string; provider: string; }

interface PipelineModelMappingProps {
  aiData: any;
  modelPool: string[];
  onModelChange: (key: string, value: string) => void;
}

export const PipelineModelMapping: React.FC<PipelineModelMappingProps> = ({ aiData, modelPool, onModelChange }) => {
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [bindings, setBindings] = useState<Record<string, { profileId: string | null; modelName: string }>>({});

  useEffect(() => {
    (async () => {
      try {
        const rawP = await window.api.apiProfile?.getAll();
        const pData = (rawP as any)?.data ?? rawP;
        if (Array.isArray(pData)) setProfiles(pData);
      } catch {}
      try {
        const rawB = await window.api.profileBinding?.getAll();
        const bData = (rawB as any)?.data ?? rawB;
        if (Array.isArray(bData)) {
          const map: Record<string, any> = {};
          bData.forEach((b: any) => { map[b.taskType] = { profileId: b.profileId, modelName: b.modelName }; });
          setBindings(map);
        }
      } catch {}
    })();
  }, []);

  const handleBindingChange = async (bindingKey: string, profileId: string | null, modelName: string) => {
    if (!bindingKey) return;
    setBindings((prev) => ({ ...prev, [bindingKey]: { profileId, modelName } }));
    try { await window.api.profileBinding?.upsert(bindingKey, profileId, modelName); } catch {}
  };

  const profileOptions = [{ id: "", name: "自动匹配", provider: "" }, ...profiles];

  return (
    <section>
      <div className="flex items-center gap-2 mb-1">
        <Server size={18} className="text-accent-cyan" />
        <h3 className="text-base font-semibold text-foreground">管线-模型映射</h3>
      </div>
      <p className="text-[11px] text-muted-foreground mb-4">为每个管线节点选择 API 配置和模型。选「自动匹配」则按模型名匹配供应商。</p>
      <div className="glass-card-sm p-5 flex flex-col gap-3">
        {PIPELINE_NODES.map((node) => {
          const isLLM = "useModelPool" in node;
          const options: string[] = isLLM ? (modelPool && modelPool.length > 0 ? modelPool : []) : (node as any).localOptions || [];
          const currentValue = (aiData as any)[node.key] || bindings[node.bindingKey]?.modelName || "";
          const finalOptions = currentValue && !options.includes(currentValue) ? [currentValue, ...options] : options;
          const binding = bindings[node.bindingKey];
          const hasBinding = node.bindingKey && isLLM;

          return (
            <div key={node.key} className="grid grid-cols-[140px_1fr_1fr] gap-2 items-center">
              <div className="flex items-center gap-2">
                <span className="text-sm">{node.icon}</span>
                <span className="text-xs text-foreground font-medium">{node.label}</span>
              </div>

              {/* API 配置选择（仅 LLM 节点） */}
              {hasBinding ? (
                <select
                  value={binding?.profileId || ""}
                  onChange={(e) => {
                    const pid = e.target.value || null;
                    const p = profiles.find((x) => x.id === pid);
                    const newModel = pid ? (p?.models?.[0] || currentValue) : currentValue;
                    handleBindingChange(node.bindingKey, pid, newModel);
                    if (isLLM) onModelChange(node.key, newModel);
                  }}
                  className="text-[11px] px-2 py-1.5 rounded bg-bg-secondary border border-border/30 text-foreground outline-none cursor-pointer hover:border-accent/40"
                >
                  {profileOptions.map((opt) => (
                    <option key={opt.id || "__auto"} value={opt.id}>{opt.name}</option>
                  ))}
                </select>
              ) : (
                <div />
              )}

              {/* 模型选择 */}
              {isLLM ? (
                <Select
                  value={currentValue}
                  onValueChange={(v) => {
                    onModelChange(node.key, v);
                    if (hasBinding) handleBindingChange(node.bindingKey, binding?.profileId || null, v);
                  }}
                >
                  <SelectTrigger className="h-9 text-xs bg-bg-secondary border-border/50">
                    <SelectValue placeholder={finalOptions.length > 0 ? "选择模型" : "先配置供应商模型"} />
                  </SelectTrigger>
                  <SelectContent className="bg-bg-tertiary border-border/50">
                    {finalOptions.map((opt: string) => (
                      <SelectItem key={opt} value={opt} className="text-xs">{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={currentValue} onValueChange={(v) => onModelChange(node.key, v)}>
                  <SelectTrigger className="h-9 text-xs bg-bg-secondary border-border/50">
                    <SelectValue placeholder="选择选项" />
                  </SelectTrigger>
                  <SelectContent className="bg-bg-tertiary border-border/50">
                    {options.map((opt: string) => (
                      <SelectItem key={opt} value={opt} className="text-xs">{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};
