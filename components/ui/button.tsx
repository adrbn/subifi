'use client';

import clsx from 'clsx';
import { forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-accent hover:bg-accent-hi text-white border border-transparent',
  secondary:
    'bg-bg-hi hover:bg-border text-text border border-border',
  ghost:
    'bg-transparent hover:bg-bg-hi text-text-muted hover:text-text border border-transparent',
  danger:
    'bg-red-600 hover:bg-red-500 text-white border border-transparent',
};

const sizeClasses: Record<Size, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-9 px-3 text-sm',
  lg: 'h-11 px-5 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent/40',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...rest}
    />
  );
});
