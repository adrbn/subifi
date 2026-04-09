'use client';

import clsx from 'clsx';
import { forwardRef } from 'react';

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={clsx(
        'h-9 w-full rounded-md border border-border bg-bg-hi px-2 text-sm text-text focus:border-accent focus:outline-none',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});
