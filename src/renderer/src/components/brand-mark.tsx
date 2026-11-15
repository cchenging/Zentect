/**
 * 品牌标记「Z + 剪辑点」
 *
 * 几何取自原型定稿的 B 版（1024 画布 118/124/32/26 缩到 24 网格）：
 * 横杠 11.72×2.77、斜笔宽 2.91、斜笔中段一道 0.76 的割口、两处 45° 倒角。
 * 割口用 mask 挖出，割线必须沿斜笔的垂线，否则缺口会变成楔形。
 * 侧栏 24px、登录弹窗 48px、应用图标共用同一份几何，别各自手改。
 */
import React from 'react';

interface BrandMarkProps {
  className?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({ className }) => {
  // mask id 必须唯一：侧栏与登录弹窗可能同时挂载
  const cutId = `zcut-${React.useId().replace(/:/g, '')}`;

  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <mask id={cutId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="#fff" />
        <line x1="9.33" y1="10.66" x2="13.59" y2="14.32" stroke="#000" strokeWidth="0.76" />
        <polygon points="17.25,5.2 18.09,5.2 18.09,6.05" fill="#000" />
        <polygon points="5.91,17.67 5.91,18.52 6.75,18.52" fill="#000" />
      </mask>
      <g mask={`url(#${cutId})`} fill="currentColor">
        <rect x="6.14" y="5.2" width="11.72" height="2.77" />
        <rect x="6.14" y="15.75" width="11.72" height="2.77" />
        <line x1="16.55" y1="6.59" x2="7.45" y2="17.13" stroke="currentColor" strokeWidth="2.91" />
      </g>
    </svg>
  );
};
