import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
import { CheckCircle2, Loader2, XCircle, AlertCircle, Clock, AlertTriangle } from 'lucide-react'

/** StatusIcon 状态变体样式 */
const statusIconVariants = cva('', {
  variants: {
    /** 状态类型 */
    status: {
      completed: 'text-accent-green',
      running: 'text-accent animate-spin',
      failed: 'text-accent-rose',
      pending: 'text-muted-foreground',
      warning: 'text-accent-warm',
      disabled: 'text-muted-foreground/50',
    },
  },
  defaultVariants: {
    status: 'pending',
  },
})

/** 状态到图标的映射 */
const statusIconMap = {
  completed: CheckCircle2,
  running: Loader2,
  failed: XCircle,
  pending: Clock,
  warning: AlertTriangle,
  disabled: AlertCircle,
} as const

/** StatusIcon 组件属性 */
export interface StatusIconProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusIconVariants> {
  /** 图标尺寸，默认 14 */
  size?: number
}

/**
 * 状态图标组件
 * 统一 completed/running/failed/pending/warning/disabled 六种状态的图标+颜色
 * 用于步骤状态、子步骤状态、任务状态等场景
 */
const StatusIconInner = React.forwardRef<HTMLSpanElement, StatusIconProps>(
  ({ className, status, size = 14, ...props }, ref) => {
    /** 获取对应状态的图标组件 */
    const IconComponent = statusIconMap[status ?? 'pending']

    return (
      <span
        ref={ref}
        className={cn('inline-flex items-center justify-center', statusIconVariants({ status }), className)}
        role="img"
        aria-label={status ?? 'pending'}
        {...props}
      >
        <IconComponent size={size} />
      </span>
    )
  }
)
StatusIconInner.displayName = 'StatusIcon'

/** 使用 React.memo 防止管线进度更新时的无效重渲染 */
const StatusIcon = React.memo(StatusIconInner)

export { StatusIcon, statusIconVariants }
