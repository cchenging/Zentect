// Module: editor/preview/frontend/components/Player
// 原 editor/components/player/index.tsx — 已迁移

import React from 'react';
import { VideoCanvas } from './VideoCanvas';
import { PlayerControls } from './PlayerControls';

export const Player: React.FC = () => {
  return (
    <div id="player-container" className="w-full h-full flex flex-col bg-bg-main overflow-hidden">
      <VideoCanvas />
      <PlayerControls />
    </div>
  );
};

export default Player;
