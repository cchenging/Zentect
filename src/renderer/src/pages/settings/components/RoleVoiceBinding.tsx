import React, { useState, useEffect } from 'react';
import { Play, Loader2, Check, User, AlertCircle, Mic } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { API } from '../../../api';
import { AppNotifier } from '../../../core/AppNotifier';
import { useI18n } from '../../../store/useI18n';

interface VoiceOption {
  id: string;
  name: string;
  gender: string;
  locale: string;
}

interface RoleRecord {
  id: string;
  name: string;
  voice_id: string | null;
  project_id: string;
  pronoun: string;
}

interface RoleVoiceBindingProps {
  projectId?: string;
}

/** V1.1: 角色音色绑定面板 — 为每个角色分配 TTS 音色，支持试听 */
export const RoleVoiceBinding: React.FC<RoleVoiceBindingProps> = ({ projectId }) => {
  const { t } = useI18n();
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [ttsEngine, setTtsEngine] = useState<string>('edge');
  const [loading, setLoading] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  /** 加载角色列表 */
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    API.roles.list(projectId)
      .then((list: RoleRecord[]) => setRoles(list || []))
      .catch(() => setRoles([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  /** 加载音色列表 */
  useEffect(() => {
    API.voice.listByEngine(ttsEngine)
      .then((list: VoiceOption[]) => setVoices(list || []))
      .catch(() => setVoices([]));
  }, [ttsEngine]);

  /** 音色试听 */
  const handlePreview = async (voiceId: string) => {
    setPreviewingId(voiceId);
    try {
      const { audioPath } = await API.voice.preview(ttsEngine, voiceId);
      const audio = new Audio(`file://${audioPath}`);
      audio.play();
      audio.onended = () => setPreviewingId(null);
      audio.onerror = () => { setPreviewingId(null); AppNotifier.warn('音频播放失败'); };
    } catch (err: any) {
      setPreviewingId(null);
      AppNotifier.error(err.message || '试听失败，请检查 TTS 引擎连通性');
    }
  };

  /** 保存角色的音色绑定 */
  const handleAssignVoice = async (roleId: string, voiceId: string) => {
    setSavingId(roleId);
    try {
      await API.roles.updateVoice(roleId, voiceId);
      setRoles(prev => prev.map(r => r.id === roleId ? { ...r, voice_id: voiceId } : r));
      AppNotifier.success('音色已绑定');
    } catch (err: any) {
      AppNotifier.error(err.message || '绑定失败');
    } finally {
      setSavingId(null);
    }
  };

  /** TTS 引擎选项 */
  const engineOptions = [
    { value: 'edge', label: 'Edge TTS (免费)' },
    { value: 'doubao', label: '火山引擎 TTS' },
    { value: 'fish', label: 'Fish Audio' },
    { value: 'sovits', label: '本地 SoVITS' },
  ];

  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      {/* 引擎选择 */}
      <div className="flex flex-col gap-2">
        <span className="text-caption text-muted-foreground font-medium">
          {t.settings?.tts_default_service || '默认合成引擎'}
        </span>
        <div className="flex flex-wrap gap-2">
          {engineOptions.map(opt => (
            <button
              key={opt.value}
              onClick={() => setTtsEngine(opt.value)}
              className={`text-xs px-3 py-1.5 rounded-md border transition-all outline-none cursor-pointer ${
                ttsEngine === opt.value
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-zinc-800 bg-transparent text-zinc-400 hover:border-zinc-600'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 可用音色列表 + 试听 */}
      <div className="flex flex-col gap-2">
        <span className="text-caption text-muted-foreground font-medium flex items-center gap-1.5">
          <Mic size={13} /> 可用音色 (试听)
        </span>
        <div className="space-y-1.5 max-h-[200px] overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
          {voices.map(voice => (
            <div key={voice.id} className="flex items-center justify-between bg-zinc-900/50 border border-zinc-800/80 rounded-md px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-4 h-4 rounded-full shrink-0 ${voice.gender === 'female' ? 'bg-pink-500/30' : voice.gender === 'male' ? 'bg-blue-500/30' : 'bg-zinc-500/30'}`} />
                <div className="flex flex-col min-w-0">
                  <span className="text-caption text-zinc-200 truncate">{voice.name}</span>
                  <span className="text-mini text-zinc-600 font-mono">{voice.id}</span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handlePreview(voice.id)}
                disabled={previewingId === voice.id}
                className="h-7 text-caption text-green-400 hover:text-green-300 px-2 gap-1.5 shrink-0"
              >
                {previewingId === voice.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                试听
              </Button>
            </div>
          ))}
          {voices.length === 0 && (
            <div className="text-caption text-zinc-600 text-center py-4">
              {t.common?.no_data || '暂无音色数据'}
            </div>
          )}
        </div>
      </div>

      {/* 角色列表 + 音色分配 */}
      {roles.length > 0 && (
        <div className="flex flex-col gap-2 pt-2 border-t border-zinc-800/60">
          <span className="text-caption text-muted-foreground font-medium flex items-center gap-1.5">
            <User size={13} /> 工程角色音色绑定
          </span>
          <div className="space-y-2">
            {roles.map(role => {
              const currentVoice = role.voice_id ? voices.find(v => v.id === role.voice_id) : null;
              return (
                <div key={role.id} className="bg-zinc-900/50 border border-zinc-800/80 rounded-md px-3 py-2.5">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-200 font-medium">{role.name}</span>
                      {role.pronoun && <span className="text-mini text-zinc-500">({role.pronoun})</span>}
                    </div>
                    {currentVoice && (
                      <span className="text-mini text-green-400 flex items-center gap-1">
                        <Check size={10} /> {currentVoice.name}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {voices.slice(0, 5).map(voice => (
                      <button
                        key={voice.id}
                        onClick={() => handleAssignVoice(role.id, voice.id)}
                        disabled={savingId === role.id}
                        className={`text-mini px-2.5 py-1 rounded border transition-all outline-none cursor-pointer ${
                          role.voice_id === voice.id
                            ? 'border-primary/30 bg-primary/10 text-primary'
                            : 'border-zinc-700 bg-transparent text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {savingId === role.id ? <Loader2 size={10} className="animate-spin inline" /> : null}
                        {voice.name}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 空状态提示 */}
      {!loading && roles.length === 0 && projectId && (
        <div className="flex items-center gap-2 text-caption text-zinc-500 bg-zinc-900/30 border border-zinc-800/60 rounded-md p-3">
          <AlertCircle size={13} />
          {t.roles?.empty_hint || '当前工程暂无角色数据，导入媒体后 AI 将自动识别角色。'}
        </div>
      )}
    </div>
  );
};
