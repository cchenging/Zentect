/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class', // 支持暗黑模式
  theme: {
    extend: {
      // 📐 1. 强制接管字族 (Font Family)：优先原生，中文字体兜底
      fontFamily: {
        sans: ['system-ui', '"Segoe UI"', '"Microsoft YaHei"', '"PingFang SC"', 'sans-serif'],
        mono: ['Consolas', 'Menlo', 'monospace'], // 专供时间戳、文件大小，解决数字跳动
      },
      // 📏 2. 强制接管字号与行高 (Font Size & Line Height)
      fontSize: {
        mini: ['var(--font-size-mini)', { lineHeight: '1' }],           // 10px, 极度紧凑
        caption: ['var(--font-size-caption)', { lineHeight: '1.2' }],   // 12px, 辅助信息
        body: ['var(--font-size-body)', { lineHeight: '1.4' }],         // 13px, 黄金正文，1.4倍舒适行高
        subtitle: ['var(--font-size-subtitle)', { lineHeight: '1.5' }], // 16px, 二级标题
        title: ['var(--font-size-title)', { lineHeight: '1.5' }],       // 20px, 大标题
      },
      // 🔲 3. 强制接管圆角 (Border Radius)
      borderRadius: {
        base: 'var(--radius-base)', // 4px
        card: 'var(--radius-card)', // 12px
      },
      // 🎨 4. 颜色变量代理 (将 base.css 映射到 Tailwind 体系)
      colors: {
        background: 'var(--my-bg-main)',
        card: 'var(--my-bg-card)',
        border: 'var(--my-border)',
        foreground: 'var(--my-text-main)',
        'muted-foreground': 'var(--my-text-sub)',
        primary: {
          DEFAULT: 'var(--my-brand)',
          foreground: '#FFFFFF',
        }
      }
    },
  },
  plugins: [],
}
