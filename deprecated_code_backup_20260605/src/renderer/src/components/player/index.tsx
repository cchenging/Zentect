import React from 'react';
import { VideoCanvas } from './VideoCanvas';
import { PlayerControls } from './PlayerControls';

export const Player: React.FC = () => {
  return (
    // 💥 修复点：加入 id="player-container" 锚点，以便后续真正调用浏览器全屏 API
    <div id="player-container" className="w-full h-full flex flex-col bg-bg-main overflow-hidden">
      <VideoCanvas />
      <PlayerControls />
    </div>
  );
};

export default Player;