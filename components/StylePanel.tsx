'use client';

import { useRef } from 'react';
import { useEditor } from '@/lib/store';
import type { SafeZonePreset } from '@/lib/types';
import { FontPicker } from './FontPicker';
import { Slider } from './ui/slider';
import { Select } from './ui/select';
import { Button } from './ui/button';

// Right-side panel: all style knobs. Every change is immediately reflected
// in the VideoPreview because both read from the same Zustand store.

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-text">{value}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

export function StylePanel() {
  const {
    style,
    setStyle,
    overlays,
    addOverlay,
    updateOverlay,
    removeOverlay,
    selectedOverlayId,
    selectOverlay,
    safeZone,
    setSafeZonePreset,
  } = useEditor();
  const imageInputRef = useRef<HTMLInputElement>(null);

  const onImageFile = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    addOverlay({
      dataUrl,
      mime: file.type || 'image/png',
      positionX: 0.85,
      positionY: 0.12,
      width: 0.15,
      opacity: 1,
    });
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
        Style
      </h3>

      <FontPicker />

      <Slider
        label="Font size"
        min={16}
        max={120}
        value={style.fontSize}
        unit="px"
        onChange={(v) => setStyle({ fontSize: v })}
      />

      <Slider
        label="Font weight"
        min={100}
        max={900}
        step={100}
        value={style.fontWeight}
        onChange={(v) => setStyle({ fontWeight: v })}
      />

      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">Italic</span>
        <input
          type="checkbox"
          checked={style.italic}
          onChange={(e) => setStyle({ italic: e.target.checked })}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">Text align</span>
        <Select
          className="w-28"
          value={style.textAlign}
          onChange={(e) =>
            setStyle({ textAlign: e.target.value as 'left' | 'center' | 'right' })
          }
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </Select>
      </div>

      <hr className="border-border" />

      <ColorField
        label="Text color"
        value={style.textColor}
        onChange={(v) => setStyle({ textColor: v })}
      />
      <ColorField
        label="Outline color"
        value={style.textOutlineColor}
        onChange={(v) => setStyle({ textOutlineColor: v })}
      />
      <Slider
        label="Outline width"
        min={0}
        max={10}
        value={style.textOutlineWidth}
        unit="px"
        onChange={(v) => setStyle({ textOutlineWidth: v })}
      />

      <hr className="border-border" />

      <ColorField
        label="Background"
        value={style.backgroundColor}
        onChange={(v) => setStyle({ backgroundColor: v })}
      />
      <Slider
        label="Background opacity"
        min={0}
        max={100}
        value={Math.round(style.backgroundOpacity * 100)}
        unit="%"
        onChange={(v) => setStyle({ backgroundOpacity: v / 100 })}
      />
      <Slider
        label="Padding X"
        min={0}
        max={80}
        value={style.backgroundPaddingX}
        unit="px"
        onChange={(v) => setStyle({ backgroundPaddingX: v })}
      />
      <Slider
        label="Padding Y"
        min={0}
        max={80}
        value={style.backgroundPaddingY}
        unit="px"
        onChange={(v) => setStyle({ backgroundPaddingY: v })}
      />
      <Slider
        label="Corner radius"
        min={0}
        max={60}
        value={style.backgroundRadius}
        unit="px"
        onChange={(v) => setStyle({ backgroundRadius: v })}
      />

      <hr className="border-border" />

      <Slider
        label="Position X"
        min={0}
        max={100}
        value={Math.round(style.positionX * 100)}
        unit="%"
        onChange={(v) => setStyle({ positionX: v / 100 })}
      />
      <Slider
        label="Position Y"
        min={0}
        max={100}
        value={Math.round(style.positionY * 100)}
        unit="%"
        onChange={(v) => setStyle({ positionY: v / 100 })}
      />
      <Slider
        label="Max width"
        min={10}
        max={100}
        value={Math.round(style.maxWidth * 100)}
        unit="%"
        onChange={(v) => setStyle({ maxWidth: v / 100 })}
      />

      <hr className="border-border" />

      {/* Image overlays — multiple, draggable, wheel-zoomable on the preview */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          Images
        </h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => imageInputRef.current?.click()}
        >
          + Add image
        </Button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImageFile(f);
            e.target.value = '';
          }}
        />
      </div>

      {overlays.length === 0 && (
        <div className="text-xs text-text-muted">
          Upload logos, watermarks, stickers… then drag on the preview to move
          and scroll to resize.
        </div>
      )}

      {overlays.map((ov) => {
        const isSelected = selectedOverlayId === ov.id;
        return (
          <div
            key={ov.id}
            className={`flex flex-col gap-2 rounded-md border p-2 ${
              isSelected ? 'border-accent bg-accent/5' : 'border-border'
            }`}
            onClick={() => selectOverlay(ov.id)}
          >
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={ov.dataUrl}
                alt="overlay"
                className="h-10 w-10 rounded bg-bg-hi object-contain"
              />
              <div className="flex-1 text-xs text-text-muted">
                Drag on preview · wheel to resize
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  removeOverlay(ov.id);
                }}
                title="Remove"
              >
                ✕
              </Button>
            </div>
            <Slider
              label="Width"
              min={2}
              max={100}
              value={Math.round(ov.width * 100)}
              unit="%"
              onChange={(v) => updateOverlay(ov.id, { width: v / 100 })}
            />
            <Slider
              label="Opacity"
              min={0}
              max={100}
              value={Math.round(ov.opacity * 100)}
              unit="%"
              onChange={(v) => updateOverlay(ov.id, { opacity: v / 100 })}
            />
          </div>
        );
      })}

      <hr className="border-border" />

      {/* Safe-area / dead-zone overlays */}
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
        Dead zones
      </h3>
      <div className="text-xs text-text-muted">
        Red areas are where platform UI covers the video. Preview-only — not
        burned.
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">Preset</span>
        <Select
          className="w-36"
          value={safeZone.preset}
          onChange={(e) =>
            setSafeZonePreset(e.target.value as SafeZonePreset)
          }
        >
          <option value="off">Off</option>
          <option value="instagram">Instagram Reels</option>
          <option value="tiktok">TikTok</option>
          <option value="youtube-shorts">YouTube Shorts</option>
        </Select>
      </div>
    </div>
  );
}
