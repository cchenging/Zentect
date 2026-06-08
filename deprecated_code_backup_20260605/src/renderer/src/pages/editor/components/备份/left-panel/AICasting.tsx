import React, { useState, useEffect } from 'react';
import { Users, User, MoreVertical, Image as ImageIcon, X } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';
import { AppNotifier } from '../../../../core/AppNotifier';

export const AICasting: React.FC = () => {
  const { roles, selectItem, selectedItemId, mergeRoles } = useEditorStore();
  
  const [previewRole, setPreviewRole] = useState<{ name: string; url: string } | null>(null);
  const [dropdownOpenId, setDropdownOpenId] = useState<string | null>(null);

  useEffect(() => {
    const handleClickOutside = () => setDropdownOpenId(null);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  if (roles.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground animate-in fade-in">
        <Users size={48} className="opacity-20 mb-4" />
        <div className="text-sm font-medium text-foreground mb-2">未检测到角色</div>
        <div className="text-xs opacity-70">完成人脸分析后，自动识别视频中的角色</div>
      </div>
    );
  }

  const handleMerge = (sourceId: string, targetId: string) => {
    mergeRoles(sourceId, targetId);
    AppNotifier.success('角色合并成功');
    setDropdownOpenId(null);
  };

  return (
    <div className="animate-in fade-in flex flex-col h-full">
      <div className="flex justify-between items-center pb-3 border-b border-border shrink-0 px-1">
        <span className="text-[13px] font-semibold text-foreground">
          角色列表 <span className="text-primary ml-1">{roles.length}</span>
        </span>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-3 pt-4 pr-1 pb-5">
        {roles.map((role) => {
          const isActive = selectedItemId === role.id;
          const avatarSrc = getSafeMediaUrl(role.avatar);
          const otherRoles = roles.filter(r => r.id !== role.id);

          return (
            <div 
              key={role.id} 
              onClick={() => selectItem(role.id, 'role')} 
              className={`flex flex-col gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-200 relative
                ${isActive ? 'bg-muted border-primary' : 'bg-card border-border hover:border-primary/50'}`}
            >
              <div className="flex items-center gap-3">
                <div 
                  onClick={(e) => {
                    e.stopPropagation();
                    if (avatarSrc) setPreviewRole({ name: role.name, url: avatarSrc });
                  }}
                  className={`w-12 h-12 rounded-md bg-black shrink-0 flex items-center justify-center overflow-hidden ${avatarSrc ? 'cursor-zoom-in' : 'cursor-default'}`}
                >
                  {avatarSrc ? <img src={avatarSrc} className="w-full h-full object-cover" /> : <User className="text-muted-foreground" size={24} />}
                </div>
                
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-foreground font-semibold text-sm truncate">{role.name}</span>
                    <span className="text-muted-foreground text-[10px]">ID: {role.systemId?.split('_').pop() || ''}</span>
                  </div>
                </div>

                {otherRoles.length > 0 && (
                  <div className="relative" onClick={e => e.stopPropagation()}>
                    <button 
                      onClick={(e) => { e.stopPropagation(); setDropdownOpenId(dropdownOpenId === role.id ? null : role.id); }}
                      className="p-1 rounded hover:bg-background text-muted-foreground transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <MoreVertical size={16} />
                    </button>
                    
                    {dropdownOpenId === role.id && (
                      <div className="absolute right-0 top-full mt-1 w-40 max-h-48 overflow-y-auto bg-popover border border-border rounded-md shadow-lg z-50 animate-in fade-in zoom-in-95">
                        <div className="px-2 py-1.5 text-[11px] text-muted-foreground font-medium sticky top-0 bg-popover/90 backdrop-blur-sm border-b border-border">合并到此角色</div>
                        <div className="p-1 flex flex-col gap-0.5">
                          {otherRoles.map(targetRole => (
                            <button 
                              key={targetRole.id} 
                              onClick={() => handleMerge(role.id, targetRole.id)} 
                              className="flex items-center gap-2 px-2 py-1.5 rounded-sm text-[12px] text-foreground hover:bg-muted transition-colors outline-none"
                            >
                              <div className="w-4 h-4 rounded bg-black overflow-hidden shrink-0">
                                {targetRole.avatar && <img src={getSafeMediaUrl(targetRole.avatar)} className="w-full h-full object-cover" />}
                              </div>
                              <span className="truncate">{targetRole.name}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 px-1 pt-3 border-t border-border">
        <div className="text-[11px] text-muted-foreground">
          💡 角色信息用于解说稿中正确使用人名。配音使用全局 TTS 音色（在设置中配置）。
        </div>
      </div>

      {previewRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in" onClick={() => setPreviewRole(null)}>
          <div className="bg-card border border-border rounded-lg shadow-2xl overflow-hidden flex flex-col w-[400px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
              <span className="font-semibold text-foreground text-sm flex items-center gap-2">
                <ImageIcon size={16} className="text-primary"/> {previewRole.name}
              </span>
              <button onClick={() => setPreviewRole(null)} className="text-muted-foreground hover:text-foreground p-1 rounded-sm hover:bg-muted transition-colors outline-none"><X size={16}/></button>
            </div>
            <div className="w-full bg-black flex items-center justify-center p-2 min-h-[200px]">
              <img src={previewRole.url} alt={previewRole.name} className="max-w-full max-h-[60vh] object-contain rounded" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
