import * as React from 'react'
import { cn } from '../../lib/utils'
import { ChevronDown, ChevronRight } from 'lucide-react'

/** CollapsibleCard 组件属性 */
export interface CollapsibleCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 是否默认展开 */
  defaultExpanded?: boolean
  /** 受控展开状态 */
  expanded?: boolean
  /** 展开/折叠回调 */
  onExpandedChange?: (expanded: boolean) => void
  /** 标题区域内容 */
  title: React.ReactNode
  /** 标题区域右侧附加内容（如状态标签） */
  extra?: React.ReactNode
  /** 左侧边框颜色，用于视觉分组 */
  borderColor?: string
  /** 是否禁用折叠（始终展开） */
  disableCollapse?: boolean
}

/**
 * 可折叠卡片组件
 * 用于步骤子面板、配置面板等可展开/折叠的内容区域
 * 支持受控和非受控两种模式
 */
const CollapsibleCard = React.forwardRef<HTMLDivElement, CollapsibleCardProps>(
  (
    {
      className,
      defaultExpanded = false,
      expanded: controlledExpanded,
      onExpandedChange,
      title,
      extra,
      borderColor,
      disableCollapse = false,
      children,
      ...props
    },
    ref
  ) => {
    /** 内部展开状态（非受控模式） */
    const [internalExpanded, setInternalExpanded] = React.useState(defaultExpanded)

    /** 实际展开状态：优先使用受控值 */
    const isExpanded = controlledExpanded ?? internalExpanded

    /** 切换展开/折叠 */
    const handleToggle = React.useCallback(() => {
      if (disableCollapse) return
      const next = !isExpanded
      setInternalExpanded(next)
      onExpandedChange?.(next)
    }, [isExpanded, disableCollapse, onExpandedChange])

    return (
      <div
        ref={ref}
        className={cn(
          'rounded-lg border border-border/50 overflow-hidden transition-all duration-200',
          borderColor && 'border-l-2',
          className
        )}
        style={borderColor ? { borderLeftColor: borderColor } : undefined}
        {...props}
      >
        {/* 标题栏 */}
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-2 select-none',
            !disableCollapse && 'cursor-pointer hover:bg-muted/20'
          )}
          onClick={handleToggle}
          role={disableCollapse ? undefined : 'button'}
          tabIndex={disableCollapse ? undefined : 0}
          aria-expanded={disableCollapse ? undefined : isExpanded}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleToggle()
            }
          }}
        >
          {/* 展开/折叠指示器 */}
          {!disableCollapse && (
            <span className="text-muted-foreground/60 flex-shrink-0">
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}

          {/* 标题内容 */}
          <div className="flex-1 min-w-0 text-[12px] font-medium">{title}</div>

          {/* 右侧附加区域 */}
          {extra && <div className="flex-shrink-0">{extra}</div>}
        </div>

        {/* 可折叠内容区 */}
        {isExpanded && (
          <div className="px-3 pb-3 pt-1">
            {children}
          </div>
        )}
      </div>
    )
  }
)
CollapsibleCard.displayName = 'CollapsibleCard'

export { CollapsibleCard }
