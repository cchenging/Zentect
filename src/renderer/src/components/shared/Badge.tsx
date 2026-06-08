import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
import { X } from 'lucide-react'

/** Badge 变体样式定义 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap transition-colors',
  {
    variants: {
      /** 语义变体 */
      variant: {
        default: 'bg-muted/30 text-muted-foreground',
        success: 'bg-accent-green/10 text-accent-green',
        danger: 'bg-accent-rose/10 text-accent-rose',
        warning: 'bg-accent-warm/10 text-accent-warm',
        info: 'bg-accent-cyan/10 text-accent-cyan',
        accent: 'bg-accent/15 text-accent',
        purple: 'bg-accent-purple/10 text-accent-purple',
        /** 情绪标签专用 */
        emotion: 'bg-muted/20 text-muted-foreground',
      },
      /** 交互模式 */
      interactive: {
        /** 默认：纯展示 */
        none: '',
        /** 可点击：带 hover 效果和 cursor-pointer */
        clickable: 'cursor-pointer hover:brightness-125 active:scale-95',
        /** 可选中：选中态高亮，未选中态半透明 */
        selectable: 'cursor-pointer hover:brightness-125',
        /** 可移除：右侧带关闭按钮 */
        removable: 'pr-1 cursor-pointer hover:brightness-125',
      },
    },
    defaultVariants: {
      variant: 'default',
      interactive: 'none',
    },
  }
)

/** Badge 组件属性 */
export interface BadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'onClick'>,
    VariantProps<typeof badgeVariants> {
  /** 点击回调（仅在 interactive 非 none 时生效） */
  onClick?: (e: React.MouseEvent<HTMLSpanElement>) => void
  /** 是否选中（仅在 interactive="selectable" 时生效） */
  selected?: boolean
  /** 移除回调（仅在 interactive="removable" 时生效） */
  onRemove?: (e: React.MouseEvent<HTMLButtonElement>) => void
  /** 是否禁用交互 */
  disabled?: boolean
}

/**
 * 标签组件
 * 用于状态标记、分类标签、计数徽标等场景
 * 支持语义变体、自定义颜色覆盖和三种交互模式
 */
const BadgeInner = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, interactive, onClick, selected, onRemove, disabled, children, ...props }, ref) => {
    /** 可选中模式的样式覆盖 */
    const selectedClass = interactive === 'selectable' && selected
      ? ''
      : interactive === 'selectable' && !selected
        ? 'opacity-50'
        : ''

    /** 禁用态样式 */
    const disabledClass = disabled ? 'opacity-40 pointer-events-none' : ''

    return (
      <span
        ref={ref}
        className={cn(badgeVariants({ variant, interactive }), selectedClass, disabledClass, className)}
        onClick={interactive && interactive !== 'none' && !disabled ? onClick : undefined}
        role={interactive && interactive !== 'none' ? 'button' : undefined}
        tabIndex={interactive && interactive !== 'none' && !disabled ? 0 : undefined}
        aria-pressed={interactive === 'selectable' ? selected : undefined}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && onClick && !disabled) {
            e.preventDefault()
            onClick(e as any)
          }
        }}
        {...props}
      >
        {children}
        {interactive === 'removable' && onRemove && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRemove(e)
            }}
            className="ml-0.5 -mr-0.5 rounded-sm hover:bg-white/10 p-0.5 transition-colors outline-none"
            aria-label="移除"
            tabIndex={-1}
          >
            <X size={10} />
          </button>
        )}
      </span>
    )
  }
)
BadgeInner.displayName = 'Badge'

/** 使用 React.memo 防止管线进度更新时的无效重渲染 */
const Badge = React.memo(BadgeInner)

export { Badge, badgeVariants }
