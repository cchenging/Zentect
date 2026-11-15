// 📁 路径: src/renderer/src/components/brand-wordmark.tsx
// 品牌字标 W1「首字母即图标」：图标 Z 直接当首字母，后接 Bold 的 ENTECT
import React from 'react';

interface BrandWordmarkProps {
  className?: string;
}

/**
 * W1 字标（1024 画布几何，viewBox 620×104）
 * 图标组 scale(0.176) translate(-262 -222) → 占 x 0..88 / y 0..100
 * 文字 142px/700/-3，与 Z 共用 100 字高
 * 界面里 18px：割口按 44 画（图标本体是 32），18px 下约 1.34 CSS px，才看得出「剪辑点」
 */
export const BrandWordmark: React.FC<BrandWordmarkProps> = ({ className }) => {
  const cutId = `wmcut-${React.useId().replace(/:/g, '')}`;
  return (
    <svg viewBox="0 0 620 104" className={className} role="img" aria-label="Zentect">
      <mask id={cutId} maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
        <rect width="1024" height="1024" fill="#fff" />
        <line x1="398" y1="455" x2="580" y2="611" stroke="#000" strokeWidth="44" />
        {/* 倒角三角延伸到形状外：避免与 Z 的边共用边、抗锯齿被乘两次 */}
        <polygon points="730,216 800,216 800,252 766,252" fill="#000" />
        <polygon points="294,796 224,796 224,760 258,760" fill="#000" />
      </mask>
      <g transform="scale(0.176) translate(-262 -222)">
        <g mask={`url(#${cutId})`} fill="var(--accent)">
          <rect x="262" y="222" width="500" height="118" />
          <rect x="262" y="672" width="500" height="118" />
          <line x1="706" y1="281" x2="318" y2="731" stroke="var(--accent)" strokeWidth="124" />
        </g>
      </g>
      <text
        x="100"
        y="100"
        fontFamily="'Segoe UI', Inter, system-ui, sans-serif"
        fontSize="142"
        fontWeight="700"
        letterSpacing="-3"
        fill="currentColor"
      >
        ENTECT
      </text>
    </svg>
  );
};
