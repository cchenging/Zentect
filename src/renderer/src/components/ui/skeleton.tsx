import { cn } from '../../lib/utils'

interface SkeletonProps {
  className?: string
  variant?: 'text' | 'card' | 'circle' | 'rect'
  width?: string | number
  height?: string | number
}

/**
 * 骨架屏组件
 * 4种形态：文本行(text)、卡片(card)、圆形(circle)、矩形(rect)
 * 1500ms shimmer脉冲动画
 * 支持 width/height 自定义尺寸
 */
const Skeleton = ({ className, variant = 'text', width, height }: SkeletonProps) => {
  const baseClass = 'animate-shimmer bg-muted rounded-md relative overflow-hidden'

  const variantClasses: Record<string, string> = {
    text: 'h-4 w-full',
    card: 'h-32 w-full rounded-lg',
    circle: 'h-10 w-10 rounded-full',
    rect: 'h-20 w-full rounded-lg',
  }

  const style: React.CSSProperties = {}
  if (width) style.width = typeof width === 'number' ? `${width}px` : width
  if (height) style.height = typeof height === 'number' ? `${height}px` : height

  return (
    <div
      className={cn(baseClass, variantClasses[variant], className)}
      style={style}
      aria-hidden="true"
    />
  )
}

Skeleton.displayName = 'Skeleton'

export { Skeleton }
export type { SkeletonProps }