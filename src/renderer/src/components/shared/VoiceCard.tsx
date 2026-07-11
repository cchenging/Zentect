// VoiceCard - compatibility stub
import React from 'react';

interface VoiceCardProps {
  name: string;
  selected?: boolean;
  onSelect?: () => void;
}

export const VoiceCard: React.FC<VoiceCardProps> = ({ name, selected, onSelect }) => {
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
