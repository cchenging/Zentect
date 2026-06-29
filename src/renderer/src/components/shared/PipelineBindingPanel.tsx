import React, { useState, useEffect, useCallback } from "react";

const TASK_TYPES = [
  { key: "visual", label: "VLM 画面分析" },
  { key: "script", label: "AI 解说文案" },
  { key: "translate", label: "字幕翻译" },
  { key: "helper", label: "Agent 对话" },
  { key: "tts", label: "TTS 配音" },
];

interface ProfileOption { id: string; name: string; provider: string; models: string[]; }
interface BindingData { taskType: string; profileId: string | null; modelName: string; isActive: boolean; }

export const PipelineBindingPanel: React.FC = () => {
  const [bindings, setBindings] = useState<BindingData[]>([]);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const raw = await window.api.profileBinding.getAll();
        const data = (raw as any)?.data ?? raw;
        if (Array.isArray(data)) setBindings(data);
      } catch {}
      try {
        const raw = await window.api.apiProfile.getAll();
        const data = (raw as any)?.data ?? raw;
        if (Array.isArray(data)) setProfiles(data);
      } catch {}
    })();
  }, []);

  const handleChange = useCallback(async (taskType: string, profileId: string | null, modelName: string) => {
    await window.api.profileBinding.upsert(taskType, profileId, modelName);
    setBindings((prev) =>
      prev.map((b) => (b.taskType === taskType ? { ...b, profileId, modelName } : b))
    );
  }, []);

  const profileOptions = [{ id: "", name: "自动匹配（旧配置）", provider: "" }, ...profiles];

  const selClass = "text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 text-foreground outline-none cursor-pointer hover:border-accent/40 flex-1 truncate";
  const inputClass = "text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 text-foreground outline-none focus:border-accent/40 w-[160px]";

  return (
    <div className="glass-card-sm p-4 flex flex-col gap-3">
      <div className="text-[12px] font-semibold text-foreground">管线-模型映射</div>
      <div className="text-[10px] text-muted-foreground">
        为每个业务节点指定 API 配置和模型。选择「自动匹配」则按模型名匹配旧配置。
      </div>

      <div className="flex flex-col gap-1.5">
        {TASK_TYPES.map((task) => {
          const binding = bindings.find((b) => b.taskType === task.key);
          const selectedProfile = profiles.find((p) => p.id === binding?.profileId);
          const currentModel = binding?.modelName || "";

          return (
            <div key={task.key} className="grid grid-cols-[100px_1fr_160px] gap-2 items-center px-2 py-1 rounded hover:bg-bg-secondary/30 transition-colors">
              <span className="text-[11px] text-foreground">{task.label}</span>
              <select
                value={binding?.profileId || ""}
                onChange={(e) => {
                  const pid = e.target.value || null;
                  const newProfile = profiles.find((p) => p.id === pid);
                  const newModel = pid ? (newProfile?.models?.[0] || currentModel) : currentModel;
                  handleChange(task.key, pid, newModel);
                }}
                className={selClass}
              >
                {profileOptions.map((opt) => (
                  <option key={opt.id || "__default"} value={opt.id}>{opt.name}</option>
                ))}
              </select>
              <input
                value={currentModel}
                onChange={(e) => handleChange(task.key, binding?.profileId || null, e.target.value)}
                placeholder="如：qwen-vl-max"
                className={inputClass}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};
