// 📁 路径：src/renderer/src/components/ui/slider.tsx
import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '../../lib/utils';

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      'relative flex w-full touch-none select-none items-center group',
      className
    )}
    {...props}
  >
    {/* 💥 暗黑美学：轨道压榨至极细 2px，悬浮时微微变粗至 3px 提升手感 */}
    <SliderPrimitive.Track className="relative h-[2px] w-full grow overflow-hidden rounded-full bg-white/10 transition-all duration-200 group-hover:h-[3px]">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    {/* 💥 暗黑美学：游标默认隐藏或极小，悬浮时化作精致光点，去除廉价实线边框 */}
    <SliderPrimitive.Thumb className="block h-2.5 w-2.5 rounded-full bg-primary shadow-[0_0_10px_rgba(229,193,88,0.8)] transition-all duration-200 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 cursor-grab active:cursor-grabbing border-[1.5px] border-black/50" />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
