'use client';

import clsx from 'clsx';
import { forwardRef } from 'react';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={clsx(
        'h-9 w-full rounded-md border border-border bg-bg-hi px-3 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none',
        className,
      )}
      {...rest}
    />
  );
});
