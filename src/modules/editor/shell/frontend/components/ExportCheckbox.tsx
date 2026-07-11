import React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { AppIcon } from '../../../../../renderer/src/components/app-icon';

interface ExportCheckboxProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  children?: React.ReactNode;
}

export const ExportCheckbox: React.FC<ExportCheckboxProps> = ({
  id,
  checked,
  onCheckedChange,
  label,
  children
}) => (
  <div className="flex flex-col gap-3">
    <div className="flex items-center gap-2">
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={(c) => onCheckedChange(!!c)}
        className="peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground transition-colors"
      >
        <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
          <AppIcon name="Check" size={12} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label
        htmlFor={id}
        className="text-foreground font-medium text-caption cursor-pointer select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
      >
        {label}
      </label>
    </div>
    {checked && children && <div className="ml-6 flex flex-col gap-2.5">{children}</div>}
  </div>
);
