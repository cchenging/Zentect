import React, { useState, useEffect, useCallback } from "react";
import { Plus, Check, Trash2, Edit2, X, Zap } from "lucide-react";

export interface ApiProfileData {
  id?: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  个模型: string[];
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
  const [editing, set编辑ing] = useState<ApiProfileData | null>(null);
  const [showForm, setShowForm] = useState(false);

  const loadProfiles = useCallback(async () => {
    try {
      const result = await window.api.apiProfile.getByProvider(provider);
      if (Array.isArray(result)) {
        setProfiles(result);
        const active = result.find((p: any) => p.isActive);
        onActiveProfileChange?.(active || null);
      }
    } catch { /* ignore */ }
  }, [provider]);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  const handle保存 = async () => {
    if (!editing || !editing.name.trim()) return;
    try {
      if (editing.id) {
        await window.api.apiProfile.update(editing.id, {
          name: editing.name, apiKey: editing.apiKey,
          baseUrl: editing.baseUrl, 个模型: editing.models,
        });
      } else {
        const created = await window.api.apiProfile.create({
          ...editing, provider, sortOrder: profiles.length,
        });
        if (profiles.length === 0 && created) {
          await window.api.apiProfile.activate(created.id, provider);
        }
      }
      set编辑ing(null);
      setShowForm(false);
      loadProfiles();
    } catch (e: any) {
      console.error("保存 profile failed:", e);
    }
  };

  const handle激活 = async (id: string) => {
    await window.api.apiProfile.activate(id, provider);
    loadProfiles();
  };

  const handle删除 = async (id: string) => {
    await window.api.apiProfile.delete(id);
    loadProfiles();
  };

  const start编辑 = (p: ApiProfileData) => {
    set编辑ing({ ...p });
    setShowForm(true);
  };

  const startNew = () => {
    set编辑ing({ name: "", provider, apiKey: "", baseUrl: hasBaseUrl ? "" : defaultBaseUrl, 个模型: [], isActive: false });
    setShowForm(true);
  };

  return (
    <div className="mt-2">
      {/* 保存d profiles list */}
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
                <button onClick={() => handle激活(p.id!)} title="激活"
                  className="text-muted-foreground hover:text-accent transition-colors cursor-pointer">
                  <Zap size={11} />
                </button>
              )}
              {p.isActive && <Check size={11} className="text-accent" />}
              <button onClick={() => start编辑(p)} title="编辑"
                className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                <编辑2 size={11} />
              </button>
              <button onClick={() => handle删除(p.id!)} title="删除"
                className="text-muted-foreground hover:text-accent-rose transition-colors cursor-pointer">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new button */}
      {!showForm && (
        <button onClick={startNew}
          className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-accent transition-colors cursor-pointer">
          <Plus size={11} /> 添加配置
        </button>
      )}

      {/* 编辑/Create form */}
      {showForm && editing && (
        <div className="mt-1 p-2 rounded-md border border-border/30 bg-bg-secondary/30 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <input value={editing.name} onChange={(e) => set编辑ing({ ...editing, name: e.target.value })}
              placeholder="配置名称（如：硅基流动-A）"
              className="flex-1 text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 outline-none focus:border-accent/40" autoFocus />
            <button onClick={() => { setShowForm(false); set编辑ing(null); }}
              className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={13} /></button>
          </div>
          {hasBaseUrl && (
            <input value={editing.baseUrl} onChange={(e) => set编辑ing({ ...editing, baseUrl: e.target.value })}
              placeholder="接口地址（如：https://api.siliconflow.cn/v1）"
              className="text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 outline-none focus:border-accent/40" />
          )}
          <input value={editing.apiKey} onChange={(e) => set编辑ing({ ...editing, apiKey: e.target.value })}
            placeholder="API Key" type="password"
            className="text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 outline-none focus:border-accent/40" />
          <input value={(editing.models || []).join(", ")}
            onChange={(e) => set编辑ing({ ...editing, 个模型: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
            placeholder="模型列表（逗号分隔）"
            className="text-[11px] px-2 py-1 rounded bg-bg-secondary border border-border/30 outline-none focus:border-accent/40" />
          <button onClick={handle保存}
            className="text-[11px] px-3 py-1 rounded-md bg-accent text-white font-medium hover:brightness-110 transition-all cursor-pointer">
            保存
          </button>
        </div>
      )}

      {/* Empty state */}
      {profiles.length === 0 && !showForm && (
        <div className="text-[10px] text-muted-foreground/60 mt-1">
          暂无保存的配置，点击「添加配置」创建
        </div>
      )}
    </div>
  );
};