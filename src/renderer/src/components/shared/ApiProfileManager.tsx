import React, { useState, useEffect, useCallback } from "react";
import { Plus, Check, Trash2, Edit2, X, Zap } from "lucide-react";

export interface ApiProfileData {
  id?: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
  isActive: boolean;
}

export interface ApiProfileManagerProps {
  provider: string;
  hasBaseUrl: boolean;
  defaultBaseUrl: string;
  onActiveProfileChange?: (profile: ApiProfileData | null) => void;
}

export const ApiProfileManager: React.FC<ApiProfileManagerProps> = ({
  provider, hasBaseUrl, defaultBaseUrl, onActiveProfileChange,
}) => {
  const [profiles, setProfiles] = useState<ApiProfileData[]>([]);
  const [editing, setEditing] = useState<ApiProfileData | null>(null);
  const [showForm, setShowForm] = useState(false);

  const loadProfiles = useCallback(async () => {
    try {
      const raw = await window.api.apiProfile.getByProvider(provider);
      const result = (raw as any)?.data ?? raw;
      if (Array.isArray(result)) {
        setProfiles(result);
        const active = result.find((p: any) => p.isActive);
        onActiveProfileChange?.(active || null);
      }
    } catch { /* ignore */ }
  }, [provider]);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  const handleSave = async () => {
    if (!editing || !editing.name.trim()) return;
    try {
      if (editing.id) {
        await window.api.apiProfile.update(editing.id, {
          name: editing.name, apiKey: editing.apiKey,
          baseUrl: editing.baseUrl, models: editing.models,
        });
      } else {
        const rawCreated = await window.api.apiProfile.create({
          ...editing, provider, sortOrder: profiles.length,
        });
        const created = (rawCreated as any)?.data ?? rawCreated;
        if (profiles.length === 0 && created) {
          await window.api.apiProfile.activate(created.id, provider);
        }
      }
      setEditing(null);
      setShowForm(false);
      loadProfiles();
    } catch (e: any) {
      console.error("保存配置失败:", e);
    }
  };

  const handleActivate = async (id: string) => {
    await window.api.apiProfile.activate(id, provider);
    loadProfiles();
  };

  const handleDelete = async (id: string) => {
    await window.api.apiProfile.delete(id);
    loadProfiles();
  };

  const startEdit = (p: ApiProfileData) => {
    setEditing({ ...p });
    setShowForm(true);
  };

  const startNew = () => {
    setEditing({ name: "", provider, apiKey: "", baseUrl: hasBaseUrl ? "" : defaultBaseUrl, models: [], isActive: false });
    setShowForm(true);
  };

  const inputClass = "flex-1 text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 outline-none focus:border-accent/40";
  const labelClass = "text-[10px] text-muted-foreground font-medium w-16 shrink-0 text-right";

  return (
    <div className="mt-2">
      {/* 已保存的配置列表 */}
      {profiles.length > 0 && !showForm && (
        <div className="flex flex-col gap-1">
          {profiles.map((p) => (
            <div key={p.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] border transition-all ${
              p.isActive ? "border-accent/40 bg-accent/5" : "border-border/20 bg-bg-secondary/50"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${p.isActive ? "bg-accent" : "bg-muted-foreground/30"}`} />
              <span className="flex-1 truncate font-medium">{p.name}</span>
              {p.models && p.models.length > 0 && (
                <span className="text-[9px] text-muted-foreground">{p.models.length} 个模型</span>
              )}
              {!p.isActive && (
                <button onClick={() => handleActivate(p.id!)} title="激活"
                  className="text-muted-foreground hover:text-accent transition-colors cursor-pointer">
                  <Zap size={11} />
                </button>
              )}
              {p.isActive && <Check size={11} className="text-accent" />}
              <button onClick={() => startEdit(p)} title="编辑"
                className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                <Edit2 size={11} />
              </button>
              <button onClick={() => handleDelete(p.id!)} title="删除"
                className="text-muted-foreground hover:text-accent-rose transition-colors cursor-pointer">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 添加配置按钮 */}
      {!showForm && (
        <button onClick={startNew}
          className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-accent transition-colors cursor-pointer">
          <Plus size={11} /> 添加配置
        </button>
      )}

      {/* 新增/编辑表单：左标签右输入框 */}
      {showForm && editing && (
        <div className="mt-1 p-3 rounded-md border border-border/30 bg-bg-secondary/30 flex flex-col gap-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-foreground">{editing.id ? "编辑配置" : "新增配置"}</span>
            <button onClick={() => { setShowForm(false); setEditing(null); }}
              className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={13} /></button>
          </div>

          <div className="flex items-center gap-2">
            <label className={labelClass}>名称</label>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="如：硅基流动-A"
              className={inputClass} autoFocus />
          </div>

          {hasBaseUrl && (
            <div className="flex items-center gap-2">
              <label className={labelClass}>地址</label>
              <input value={editing.baseUrl} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                placeholder="https://api.siliconflow.cn/v1"
                className={inputClass} />
            </div>
          )}

          <div className="flex items-center gap-2">
            <label className={labelClass}>Key</label>
            <input value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
              placeholder="API Key" type="password"
              className={inputClass} />
          </div>

          <div className="flex items-center gap-2">
            <label className={labelClass}>模型</label>
            <input value={(editing.models || []).join(", ")}
              onChange={(e) => setEditing({ ...editing, models: (e.target.value || "").split(",").map((s: string) => s.trim()).filter(Boolean) })}
              placeholder="逗号分隔，如：deepseek-chat, deepseek-reasoner"
              className={inputClass} />
          </div>

          <button onClick={handleSave}
            className="self-end text-[11px] px-4 py-1 rounded-md bg-accent text-white font-medium hover:brightness-110 transition-all cursor-pointer">
            保存
          </button>
        </div>
      )}

      {/* 空状态 */}
      {profiles.length === 0 && !showForm && (
        <div className="text-[10px] text-muted-foreground/60 mt-1">
          暂无保存的配置，点击「添加配置」创建。
        </div>
      )}
    </div>
  );
};
