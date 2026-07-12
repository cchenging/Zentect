/* ============================================================
   颜色解析工具
   Canvas 2D 无法直接读 CSS var()，须 getComputedStyle 运行时解析
   ============================================================ */

export function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace('#', '').trim()
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ]
  }
  if (h.length >= 6) {
    return [
      parseInt(h.substring(0, 2), 16),
      parseInt(h.substring(2, 4), 16),
      parseInt(h.substring(4, 6), 16),
    ]
  }
  return null
}

export function parseColor(value: string): [number, number, number] | null {
  if (!value) return null
  if (value.startsWith('#')) return hexToRgb(value)
  const m = value.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])]
  return null
}

/** 从 CSS 变量名列表解析为 "rgba(R,G,B,VAR)" 模板数组（VAR 为帧级透明度占位） */
export function resolveColors(tokenNames: string[]): string[] {
  const style = getComputedStyle(document.documentElement)
  const colors: string[] = []
  for (const name of tokenNames) {
    const raw = style.getPropertyValue(name).trim()
    if (!raw) continue
    const rgb = parseColor(raw)
    if (rgb) colors.push(`rgba(${rgb[0]},${rgb[1]},${rgb[2]},VAR)`)
  }
  // 兜底：accent 解析失败时用 v3 默认靛紫
  if (colors.length === 0) colors.push('rgba(99,102,241,VAR)')
  return colors
}
