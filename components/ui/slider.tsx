'use client';

import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

export type SliderProps = {
  label?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  className?: string;
};

// Clickable value label. Click to type a value manually (respecting min/max),
// Enter or blur to commit, Esc to cancel.
function EditableValue({
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const cleaned = draft.replace(/[^\d.,-]/g, '').replace(',', '.');
    const n = Number(cleaned);
    if (!Number.isNaN(n)) {
      const clamped = Math.max(min, Math.min(max, n));
      onChange(clamped);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="w-16 rounded bg-bg-hi px-1 py-0.5 text-right font-mono text-xs tabular-nums text-text outline-none focus:ring-1 focus:ring-accent"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={commit}
        inputMode="decimal"
        step={step}
      />
    );
  }

  return (
    <button
      type="button"
      className="tabular-nums rounded px-1 text-text hover:bg-bg-hi"
      onClick={() => {
        setDraft(`${value}`);
        setEditing(true);
      }}
      title="Click to edit"
    >
      {value}
      {unit}
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
  className,
}: SliderProps) {
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      {label && (
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>{label}</span>
          <EditableValue
            value={value}
            min={min}
            max={max}
            step={step}
            unit={unit}
            onChange={onChange}
          />
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
