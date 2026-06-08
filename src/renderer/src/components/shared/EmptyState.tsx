import * as React from 'react'
import { cn } from '../../lib/utils'

/** 空状态图标映射 */
const defaultIcons: Record<string, string> = {
  default: '📭',
  search: '🔍',
  data: '📊',
  media: '🎬',
  audio: '🎵',
  text: '📝',
  user: '👤',
}

/** EmptyState 组件属性 */
export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 标题文字 */
  title: string
  /** 描述文字 */
  description?: string
  /** 预设图标类型 */
  iconType?: keyof typeof defaultIcons
  /** 自定义图标节点，优先于 iconType */
  icon?: React.ReactNode
  /** 操作按钮区域 */
  action?: React.ReactNode
  /** 尺寸变体 */
  size?: 'sm' | 'md' | 'lg'
}

/**
 * 空状态组件
 * 用于数据为空时的占位展示
 * 统一空状态文案风格和视觉层级
 */
const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ className, title, description, iconType = 'default', icon, action, size = 'md', ...props }, ref) => {
    /** 尺寸映射 */
    const sizeClasses = {
      sm: 'py-3 px-2',
      md: 'py-6 px-4',
      lg: 'py-10 px-6',
    }

    /** 图标尺寸映射 */
    const iconSizes = {
      sm: 'text-lg',
      md: 'text-2xl',
      lg: 'text-4xl',
    }

    /** 标题尺寸映射 */
    const titleSizes = {
      sm: 'text-[11px]',
      md: 'text-xs',
      lg: 'text-sm',
    }

    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col items-center justify-center text-center',
          sizeClasses[size],
          className
        )}
        {...props}
      >
        {/* 图标区域 */}
        <div className={cn('mb-2 opacity-40', iconSizes[size])}>
          {icon || defaultIcons[iconType]}
        </div>

        {/* 标题 */}
        <p className={cn('text-muted-foreground font-medium', titleSizes[size])}>
          {title}
        </p>

        {/* 描述 */}
        {description && (
          <p className="text-[11px] text-muted-foreground/60 mt-1 max-w-[240px]">
            {description}
          </p>
        )}

        {/* 操作按钮 */}
        {action && (
          <div className="mt-3">
            {action}
          </div>
        )}
      </div>
    )
  }
)
EmptyState.displayName = 'EmptyState'

export { EmptyState }
