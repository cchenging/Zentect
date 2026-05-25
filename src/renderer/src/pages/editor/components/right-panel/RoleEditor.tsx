// 📁 路径: src/renderer/src/pages/Editor/components/RightPanel/RoleEditor.tsx
import React from 'react';
import { Contact, X, Mic } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../components/ui/select';
import { useI18n } from '../../../../store/useI18n';
import { FEATURE_FLAGS } from '../../../../../../shared/config/feature-flags';

const VOICE_OPTIONS = [
  { value: 'none', label: '原声音轨 (保留原声)' },
  { value: 'voice_male_1', label: '成熟大叔音 (云希)' },
  { value: 'voice_female_1', label: '温柔少女音 (晓悠)' },
  { value: 'voice_boy_1', label: '正太音 (云野)' },
  { value: 'voice_narrator', label: '浑厚解说音' }
];

export const RoleEditor: React.FC = () => {
  const { t } = useI18n();

  const selectedItemId = useEditorStore(s => s.selectedItemId);
  const selectedItemType = useEditorStore(s => s.selectedItemType);
  const roles = useEditorStore(s => s.roles);
  const updateRole = useEditorStore(s => s.updateRole);
  const unmergeRole = useEditorStore(s => s.unmergeRole);

  const activeRole = selectedItemType === 'role' ? roles.find(r => r.id === selectedItemId) : null;

  if (!activeRole) {
    return <div className="animate-in fade-in p-4 text-center text-muted-foreground text-caption mt-8">{t.inspector?.empty_role_hint || '未选择角色'}</div>;
  }

  const avatarSrc = activeRole.avatar ? (activeRole.avatar.startsWith('file://') ? activeRole.avatar : `file:///${activeRole.avatar.replace(/\\/g, '/')}`) : '';

  return (
    <div className="animate-in fade-in flex flex-col gap-6 p-4 box-border">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-foreground font-semibold text-caption tracking-wide">
          <Contact size={16} className="text-primary" /> {t.inspector?.role_title || '角色档案'}
        </div>
        <span className="text-muted-foreground text-mini">{t.inspector?.role_desc || '配置角色独立属性'}</span>
      </div>

      <div className="flex gap-4 items-center">
        <div className="relative flex h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted shadow-sm">
          {avatarSrc ? (
            <img src={avatarSrc} className="aspect-square h-full w-full object-cover" alt={activeRole.name} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-mini font-medium text-muted-foreground px-2 text-center">无头像</div>
          )}
        </div>
        <div className="flex flex-col gap-2 flex-1">
           <span className="text-muted-foreground text-mini font-medium">{t.inspector?.role_name_label || '角色名称'}</span>
           <Input
             value={activeRole.name}
             onChange={(e) => updateRole(activeRole.id, { name: e.target.value })}
             className="h-8 text-caption"
           />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {/* V1.1: 绑定音色 — 暂时冻结 */}
        {FEATURE_FLAGS.ENABLE_MULTI_ROLE_VOICE_BINDING && (
          <div className="flex items-center gap-4">
            <span className="text-muted-foreground text-mini font-medium w-16 shrink-0">{t.inspector?.role_voice_label || '绑定音色'}</span>
            <div className="flex-1">
              <Select value={activeRole.voiceId || 'none'} onValueChange={(val) => updateRole(activeRole.id, { voiceId: val })}>
                <SelectTrigger className="h-8 text-caption"><SelectValue placeholder="选择合成音色" /></SelectTrigger>
                <SelectContent>
                  {VOICE_OPTIONS.map(opt => <SelectItem key={opt.value} value={opt.value} className="text-caption">{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-mini font-medium">{t.inspector?.role_prompt_label || '性格与特征 Prompt'}</span>
          <Textarea
            rows={4}
            value={activeRole.description || ''}
            onChange={(e) => updateRole(activeRole.id, { description: e.target.value })}
            placeholder="如: 1boy, handsome, silver hair..."
            className="min-h-[80px] text-caption leading-relaxed resize-y"
          />
        </div>
      </div>

      {activeRole.mergedRoles && activeRole.mergedRoles.length > 0 && (
        <div className="flex flex-col gap-4 p-4 bg-muted/30 border border-border rounded-md">
          <span className="text-muted-foreground text-mini font-medium">🧬 融合子角色记录</span>
          <div className="flex flex-wrap gap-2">
            {activeRole.mergedRoles.map(subRole => (
              <div key={subRole.id} className="flex items-center gap-2 bg-background px-2 py-1 rounded-md border border-border shadow-sm">
                <span className="text-caption text-foreground">{subRole.name}</span>
                <button onClick={() => unmergeRole(subRole.id, activeRole.id)} className="flex items-center justify-center p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-sm transition-colors outline-none">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1" />
      <Button variant="outline" className="w-full gap-2 h-8 text-caption shrink-0">
        <Mic size={14} /> {t.inspector?.role_btn_test || '试听当前音色'}
      </Button>
    </div>
  );
};