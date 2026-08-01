// 📁 路径: src/modules/global-characters/frontend/View.tsx
// 🎬 P3 全局人物档案 — 视图组件（纯展示）
// 集成 P3-2（卡片网格列表）+ P3-1（详情对话框编辑/确认/纠正/解绑）

import React from 'react';
import { Users, User, Trash2, Unlink, Save, X, Loader2, Globe } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Textarea } from '@renderer/components/ui/textarea';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { getSafeMediaUrl } from '@renderer/utils/formatUrl';
import type { GlobalCharacter } from '../../../shared/types/entities/editor';

/** 详情对话框中关联的本地角色记录 */
interface LocalRoleRow {
  id: string;
  name: string;
  project_id: string;
  avatar: string | null;
  pronoun: string;
  description: string | null;
  voice_id: string | null;
  global_character_id: string | null;
}

/** View Props 接口 */
interface GlobalCharactersViewProps {
  characters: GlobalCharacter[];
  loading: boolean;
  selected: GlobalCharacter | null;
  localRoles: LocalRoleRow[];
  localRolesLoading: boolean;
  editName: string;
  editDescription: string;
  editPronoun: string;
  editVoiceId: string;
  saving: boolean;
  onSelect: (char: GlobalCharacter) => void;
  onClose: () => void;
  onSave: () => void;
  onUnbindRole: (roleId: string) => void;
  onDelete: () => void;
  onEditName: (v: string) => void;
  onEditDescription: (v: string) => void;
  onEditPronoun: (v: string) => void;
  onEditVoiceId: (v: string) => void;
}

/**
 * 全局人物档案视图组件
 * 纯展示：卡片网格 + 详情对话框
 */
export const GlobalCharactersView: React.FC<GlobalCharactersViewProps> = (props) => {
  const {
    characters, loading, selected, localRoles, localRolesLoading,
    editName, editDescription, editPronoun, editVoiceId, saving,
    onSelect, onClose, onSave, onUnbindRole, onDelete,
    onEditName, onEditDescription, onEditPronoun, onEditVoiceId,
  } = props;

  return (
    <div className="h-full overflow-y-auto bg-background">
      {/* 页面标题栏 */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b border-border/50 px-8 py-5">
        <div className="flex items-center gap-3">
          <Users size={22} className="text-accent" />
          <h1 className="text-lg font-semibold text-foreground">全局人物档案</h1>
          <span className="text-sm text-muted-foreground">({characters.length})</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1.5 ml-9">
          跨集/跨项目人物复用 — 自动匹配的全局人物列表，可编辑信息、纠正匹配、管理关联角色
        </p>
      </div>

      {/* 内容区 */}
      <div className="px-8 py-6">
        {loading ? (
          <CharacterGridSkeleton />
        ) : characters.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-4 gap-4">
            {characters.map((char) => (
              <CharacterCard key={char.id} character={char} onClick={() => onSelect(char)} />
            ))}
          </div>
        )}
      </div>

      {/* 详情对话框 */}
      {selected && (
        <DetailDialog
          character={selected}
          localRoles={localRoles}
          localRolesLoading={localRolesLoading}
          editName={editName}
          editDescription={editDescription}
          editPronoun={editPronoun}
          editVoiceId={editVoiceId}
          saving={saving}
          onClose={onClose}
          onSave={onSave}
          onUnbindRole={onUnbindRole}
          onDelete={onDelete}
          onEditName={onEditName}
          onEditDescription={onEditDescription}
          onEditPronoun={onEditPronoun}
          onEditVoiceId={onEditVoiceId}
        />
      )}
    </div>
  );
};

/** 单张全局人物卡片 */
const CharacterCard: React.FC<{ character: GlobalCharacter; onClick: () => void }> = ({ character, onClick }) => {
  const projectCount = Array.isArray(character.sourceProjectIds)
    ? character.sourceProjectIds.length
    : 0;
  const avatarUrl = getSafeMediaUrl(character.avatar);

  return (
    <div
      onClick={onClick}
      className="group cursor-pointer rounded-xl border border-border/50 bg-card hover:border-accent/40 hover:shadow-lg hover:shadow-accent/5 transition-all overflow-hidden"
    >
      {/* 头像区 */}
      <div className="aspect-square bg-muted/30 flex items-center justify-center overflow-hidden">
        {avatarUrl ? (
          <img src={avatarUrl} alt={character.name} className="w-full h-full object-cover" />
        ) : (
          <User size={40} className="text-muted-foreground/40" />
        )}
      </div>
      {/* 信息区 */}
      <div className="p-3">
        <div className="flex items-center gap-1.5">
          <Globe size={12} className="text-accent-purple shrink-0" />
          <span className="font-medium text-sm text-foreground truncate">{character.name}</span>
        </div>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
          <span>出现 {character.appearanceCount} 次</span>
          <span>·</span>
          <span>{projectCount} 个项目</span>
        </div>
      </div>
    </div>
  );
};

/** 详情对话框：编辑信息 + 关联本地角色列表 */
const DetailDialog: React.FC<{
  character: GlobalCharacter;
  localRoles: LocalRoleRow[];
  localRolesLoading: boolean;
  editName: string;
  editDescription: string;
  editPronoun: string;
  editVoiceId: string;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
  onUnbindRole: (roleId: string) => void;
  onDelete: () => void;
  onEditName: (v: string) => void;
  onEditDescription: (v: string) => void;
  onEditPronoun: (v: string) => void;
  onEditVoiceId: (v: string) => void;
}> = (props) => {
  const {
    character, localRoles, localRolesLoading,
    editName, editDescription, editPronoun, editVoiceId, saving,
    onClose, onSave, onUnbindRole, onDelete,
    onEditName, onEditDescription, onEditPronoun, onEditVoiceId,
  } = props;

  const avatarUrl = getSafeMediaUrl(character.avatar);
  const projectIds = Array.isArray(character.sourceProjectIds) ? character.sourceProjectIds : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[760px] max-h-[85vh] bg-card rounded-2xl border border-border/50 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 对话框头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
          <h2 className="text-base font-semibold text-foreground">全局人物详情</h2>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* 对话框内容 */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex gap-6">
            {/* 左侧：头像 + 编辑表单 */}
            <div className="w-[280px] shrink-0 space-y-4">
              {/* 头像 */}
              <div className="w-full aspect-square rounded-xl bg-muted/30 flex items-center justify-center overflow-hidden border border-border/50">
                {avatarUrl ? (
                  <img src={avatarUrl} alt={editName} className="w-full h-full object-cover" />
                ) : (
                  <User size={48} className="text-muted-foreground/40" />
                )}
              </div>

              {/* 编辑表单 */}
              <div className="space-y-3">
                <FormField label="名称">
                  <Input value={editName} onChange={(e) => onEditName(e.target.value)} placeholder="全局人物名" />
                </FormField>
                <FormField label="代词">
                  <Input value={editPronoun} onChange={(e) => onEditPronoun(e.target.value)} placeholder="他/她/它" />
                </FormField>
                <FormField label="音色 ID">
                  <Input value={editVoiceId} onChange={(e) => onEditVoiceId(e.target.value)} placeholder="TTS 音色 ID（可选）" />
                </FormField>
                <FormField label="描述">
                  <Textarea value={editDescription} onChange={(e) => onEditDescription(e.target.value)} placeholder="人物描述..." rows={3} />
                </FormField>
              </div>

              {/* 统计信息 */}
              <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t border-border/30">
                <div>出现次数：<span className="text-foreground">{character.appearanceCount}</span></div>
                <div>关联项目：<span className="text-foreground">{projectIds.length}</span></div>
                <div className="truncate">ID：<span className="text-foreground/70">{character.id}</span></div>
              </div>
            </div>

            {/* 右侧：关联本地角色列表 */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <Users size={14} className="text-muted-foreground" />
                <h3 className="text-sm font-medium text-foreground">关联的本地角色</h3>
                <span className="text-xs text-muted-foreground">({localRoles.length})</span>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                以下角色已匹配到此全局人物。若匹配错误，可点击「解绑」纠正（P3-1 纠正回写）。
              </p>

              {localRolesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={20} className="animate-spin text-muted-foreground" />
                </div>
              ) : localRoles.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  暂无关联的本地角色
                </div>
              ) : (
                <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                  {localRoles.map((role) => (
                    <div
                      key={role.id}
                      className="flex items-center gap-3 p-2.5 rounded-lg border border-border/40 bg-background/50 hover:border-border transition-colors"
                    >
                      {/* 角色头像 */}
                      <div className="w-10 h-10 rounded-lg bg-muted/30 flex items-center justify-center overflow-hidden shrink-0">
                        {role.avatar ? (
                          <img src={getSafeMediaUrl(role.avatar)} alt={role.name} className="w-full h-full object-cover" />
                        ) : (
                          <User size={16} className="text-muted-foreground/40" />
                        )}
                      </div>
                      {/* 角色信息 */}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">{role.name}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          项目: {role.project_id}
                          {role.pronoun ? ` · ${role.pronoun}` : ''}
                        </div>
                      </div>
                      {/* 解绑按钮 */}
                      <button
                        onClick={() => onUnbindRole(role.id)}
                        className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
                        title="解绑此角色（纠正匹配错误）"
                      >
                        <Unlink size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 对话框底部：操作按钮 */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border/50">
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={saving}
            className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
          >
            <Trash2 size={14} className="mr-1.5" />
            删除全局人物
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button size="sm" onClick={onSave} disabled={saving}>
              {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Save size={14} className="mr-1.5" />}
              保存修改
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** 表单字段容器（label + children） */
const FormField: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
    {children}
  </div>
);

/** 空状态 */
const EmptyState: React.FC = () => (
  <div className="flex flex-col items-center justify-center py-24 text-center">
    <Users size={48} className="text-muted-foreground/30 mb-4" />
    <h3 className="text-base font-medium text-foreground mb-1">暂无全局人物</h3>
    <p className="text-sm text-muted-foreground max-w-md">
      处理素材时，系统会自动识别并匹配全局人物。完成第一步素材分析后，识别出的人物将自动出现在此处。
    </p>
  </div>
);

/** 加载骨架屏 */
const CharacterGridSkeleton: React.FC = () => (
  <div className="grid grid-cols-4 gap-4">
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="rounded-xl border border-border/50 bg-card overflow-hidden">
        <Skeleton className="aspect-square w-full" />
        <div className="p-3 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    ))}
  </div>
);
