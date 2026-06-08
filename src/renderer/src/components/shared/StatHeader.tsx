import * as React from 'react'
import { cn } from '../../lib/utils'

/** StatHeader 组件属性 */
export interface StatHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 主要统计数字 */
  value: number | string
  /** 数字后的单位/描述（如"帧画面"、"句台词"） */
  unit?: string
  /** 次要统计（如"已确认 5 帧"） */
  secondary?: string
  /** 分隔符，默认 "·" */
  separator?: string
}

/**
 * 统计标题组件
 * 用于步骤面板顶部的数据概览展示
 * 格式：共 {value} {unit}，{secondary}
 * 或：{value} {unit} · {secondary}
 */
const StatHeaderInner = React.forwardRef<HTMLDivElement, StatHeaderProps>(
  ({ className, value, unit, secondary, separator = '·', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn('text-[11px] text-muted-foreground leading-tight', className)}
        {...props}
      >
        {unit ? (
          <>
            共 <span className="text-foreground font-medium tabular-nums">{value}</span> {unit}
            {secondary && (
              <>
                <span className="mx-1 opacity-50">{separator}</span>
                {secondary}
              </>
            )}
          </>
        ) : (
          <>
            <span className="text-foreground font-medium tabular-nums">{value}</span>
            {secondary && (
              <>
                <span className="mx-1 opacity-50">{separator}</span>
                {secondary}
              </>
            )}
          </>
        )}
      </div>
    )
  }
)
StatHeaderInner.displayName = 'StatHeader'

/** 使用 React.memo 防止管线进度更新时的无效重渲染 */
const StatHeader = React.memo(StatHeaderInner)

export { StatHeader }
