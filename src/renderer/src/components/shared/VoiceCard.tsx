// VoiceCard - compatibility stub
import React from 'react';

interface VoiceCardProps {
  /** 音色 ID（兼容旧调用方传入） */
  id?: string;
  /** 音色名称 */
  name: string;
  /** 语言标识（兼容旧调用方传入） */
  lang?: string;
  /** 是否选中 */
  selected?: boolean;
  /** 是否预览中 */
  isPreviewing?: boolean;
  /** 选中回调 */
  onSelect?: () => void;
  /** 预览回调（参数为音色 ID） */
  onPreview?: (voiceId: string) => void;
}

export const VoiceCard: React.FC<VoiceCardProps> = ({ name, selected, isPreviewing, onSelect, onPreview, id, lang }) => {
  void id; void lang; void isPreviewing; void onPreview;
  return (
    <div
      onClick={onSelect}
      className={`p-3 border rounded cursor-pointer ${
        selected ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
      }`}
    >
      {name}
    </div>
  );
};

export default VoiceCard;
