import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

/** Progress 尺寸变体 */
const progressVariants = cva(
  'relative w-full overflow-hidden rounded-full bg-muted/30',
  {
    variants: {
      /** 进度条高度 */
      size: {
        sm: 'h-1',
        md: 'h-2',
        lg: 'h-3',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  }
)

/** Progress 填充色变体 */
const indicatorVariants = cva('h-full rounded-full transition-all duration-300 ease-out', {
  variants: {
    /** 填充颜色 */
    color: {
      accent: 'bg-accent',
      cyan: 'bg-accent-cyan',
      green: 'bg-accent-green',
      rose: 'bg-accent-rose',
      primary: 'bg-primary',
    },
  },
  defaultVariants: {
    color: 'accent',
  },
})

/** Progress 组件属性 */
export interface ProgressProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'>,
    VariantProps<typeof progressVariants> {
  /** 当前进度值 0-100 */
  value?: number
  /** 填充颜色变体 */
  color?: VariantProps<typeof indicatorVariants>['color']
  /** 是否显示进度百分比文字 */
  showLabel?: boolean
}

/**
 * 进度条组件
 * 用于任务进度、下载进度、管线执行进度等场景
 * 支持多种尺寸和颜色变体
 */
const ProgressInner = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, size, value = 0, color, showLabel = false, ...props }, ref) => {
    /** 限制进度值在 0-100 范围内 */
    const clampedValue = Math.min(100, Math.max(0, value))

    return (
      <div className="flex items-center gap-2 w-full">
        <div
          ref={ref}
          role="progressbar"
          aria-valuenow={clampedValue}
          aria-valuemin={0}
          aria-valuemax={100}
          className={cn(progressVariants({ size }), className)}
          {...props}
        >
          <div
            className={cn(indicatorVariants({ color }))}
            style={{ width: `${clampedValue}%` }}
          />
        </div>
        {showLabel && (
          <span className="text-[11px] text-muted-foreground tabular-nums min-w-[32px] text-right">
            {Math.round(clampedValue)}%
          </span>
        )}
      </div>
    )
  }
)
ProgressInner.displayName = 'Progress'

/** 使用 React.memo 防止管线进度更新时的无效重渲染 */
const Progress = React.memo(ProgressInner)

export { Progress, progressVariants }
