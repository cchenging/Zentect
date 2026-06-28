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
      const raw = await window.api.apiProfile.getByProvider(provider);`r`n      const result = (raw as any)?.data ?? raw;
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
        const created = (rawCreated as any)?.data ?? rawCreated;`r`n      if (profiles.length === 0 && created) {
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

  return (
    <div className="mt-2">
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

      {!showForm && (
        <button onClick={startNew}
          className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-accent transition-colors cursor-pointer">
          <Plus size={11} /> 添加配置
        </button>
      )}

      {showForm && editing && (
        <div className="mt-1 p-2 rounded-md border border-border/30 bg-bg-secondary/30 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="配置名称（如：硅基流动-A）"
              className="flex-1 text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 outline-none focus:border-accent/40" autoFocus />
            <button onClick={() => { setShowForm(false); setEditing(null); }}
              className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={13} /></button>
          </div>
          {hasBaseUrl && (
            <input value={editing.baseUrl} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
              placeholder="接口地址（如：https://api.siliconflow.cn/v1）"
              className="text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 outline-none focus:border-accent/40" />
          )}
          <input value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
            placeholder="API Key" type="password"
            className="text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 outline-none focus:border-accent/40" />
          <input value={(editing.models || []).join(", ")}
            onChange={(e) => setEditing({ ...editing, models: (e.target.value || "").split(",").map((s: string) => s.trim()).filter(Boolean) })}
            placeholder="模型列表（逗号分隔）"
            className="text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 outline-none focus:border-accent/40" />
          <button onClick={handleSave}
            className="text-[11px] px-3 py-1 rounded-md bg-accent text-white font-medium hover:brightness-110 transition-all cursor-pointer">
            保存
          </button>
        </div>
      )}

      {profiles.length === 0 && !showForm && (
        <div className="text-[10px] text-muted-foreground/60 mt-1">
          暂无保存的配置，点击「添加配置」创建。
        </div>
      )}
    </div>
  );
};