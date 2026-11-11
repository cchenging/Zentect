// 📁 src/renderer/src/components/brand-mark.tsx
// 品牌标记「折带 Z」：24 网格、等宽圆端，末段降透明度表示光在折角处衰减。
// 侧栏 24、登录弹窗 48、应用图标共用同一份路径，避免三处各自变形。
import React from 'react';

interface BrandMarkProps {
  className?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      d="M6.4 7H17.6L6.4 17"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M6.4 17H17.6"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.2}
      strokeLinecap="round"
      opacity={0.6}
    />
  </svg>
);
