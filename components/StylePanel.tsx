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

// Aspect-ratio buckets used to gate which dead-zone presets make sense for
// the current video. We're loose on the boundaries because real footage
// rarely matches a "perfect" 9:16 — anything taller than ~1.05× wide is
// portrait, anything wider than ~1.05× tall is landscape, and the rest is
// effectively square.
type AspectBucket = 'portrait' | 'landscape' | 'square';

function bucketForAspect(w: number, h: number): AspectBucket {
  if (!w || !h) return 'landscape';
  const ratio = h / w;
  if (ratio > 1.05) return 'portrait';
  if (ratio < 0.95) return 'landscape';
  return 'square';
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
    textOverlays,
    addTextOverlay,
    updateTextOverlay,
    removeTextOverlay,
    selectedTextOverlayId,
    selectTextOverlay,
    safeZone,
    setSafeZonePreset,
    videoWidth,
    videoHeight,
  } = useEditor();
  const aspectBucket = bucketForAspect(videoWidth, videoHeight);
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
    <div
      data-tour="style-panel"
      className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-3"
    >
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

      <Slider
        label="Line height"
        min={80}
        max={220}
        step={5}
        // Stored as a multiplier (1.0..2.2), shown as a percentage so the
        // slider feels like the rest of the panel.
        value={Math.round((style.lineHeight ?? 1.2) * 100)}
        unit="%"
        onChange={(v) => setStyle({ lineHeight: v / 100 })}
      />
      <Slider
        label="Letter spacing"
        min={-5}
        max={20}
        value={style.letterSpacing ?? 0}
        unit="px"
        onChange={(v) => setStyle({ letterSpacing: v })}
      />

      <hr className="border-border" />

      {/* Karaoke / word-pop. Requires per-word timings (block.words) which
          come from Whisper by default — when off, blocks render as one
          uniform string and karaokeBaseColor is ignored. */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">Karaoke (word-pop)</span>
        <input
          type="checkbox"
          checked={style.karaoke}
          onChange={(e) => setStyle({ karaoke: e.target.checked })}
        />
      </div>
      {style.karaoke && (
        <ColorField
          label="Unspoken color"
          value={style.karaokeBaseColor}
          onChange={(v) => setStyle({ karaokeBaseColor: v })}
        />
      )}

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

      {/* Manual text overlays — separate from auto-generated subtitle blocks. */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          Texts
        </h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const id = addTextOverlay();
            selectTextOverlay(id);
          }}
        >
          + Add text
        </Button>
      </div>

      {textOverlays.length === 0 && (
        <div className="text-xs text-text-muted">
          Free-form titles, callouts, captions… added independently from the
          AI-generated subtitles. Drag on the preview to move; double-click
          to edit text.
        </div>
      )}

      {textOverlays.map((ov) => {
        const isSelected = selectedTextOverlayId === ov.id;
        return (
          <div
            key={ov.id}
            className={`flex flex-col gap-2 rounded-md border p-2 ${
              isSelected ? 'border-accent bg-accent/5' : 'border-border'
            }`}
            onClick={() => selectTextOverlay(ov.id)}
          >
            <div className="flex items-start gap-2">
              <textarea
                value={ov.text}
                onChange={(e) =>
                  updateTextOverlay(ov.id, { text: e.target.value })
                }
                rows={Math.max(1, ov.text.split('\n').length)}
                className="flex-1 resize-none rounded bg-bg-hi px-1.5 py-1 text-xs text-text outline-none"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTextOverlay(ov.id);
                }}
                title="Remove"
              >
                ✕
              </Button>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-text-muted">
              <label className="flex items-center gap-1">
                <span>start</span>
                <input
                  type="number"
                  step={0.05}
                  value={ov.start.toFixed(2)}
                  onChange={(e) =>
                    updateTextOverlay(ov.id, { start: Number(e.target.value) })
                  }
                  className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono"
                />
              </label>
              <label className="flex items-center gap-1">
                <span>end</span>
                <input
                  type="number"
                  step={0.05}
                  value={ov.end.toFixed(2)}
                  onChange={(e) =>
                    updateTextOverlay(ov.id, { end: Number(e.target.value) })
                  }
                  className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono"
                />
              </label>
            </div>

            {/* Per-overlay font picker — drives only this overlay (controlled
                mode) so changing it doesn't touch the global subtitle style. */}
            <FontPicker
              compact
              value={{ family: ov.fontFamily, weight: ov.fontWeight }}
              onChange={(family) =>
                updateTextOverlay(ov.id, { fontFamily: family })
              }
            />
            <Slider
              label="Font weight"
              min={100}
              max={900}
              step={100}
              value={ov.fontWeight}
              onChange={(v) => updateTextOverlay(ov.id, { fontWeight: v })}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted">Italic</span>
              <input
                type="checkbox"
                checked={ov.italic}
                onChange={(e) =>
                  updateTextOverlay(ov.id, { italic: e.target.checked })
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted">Text align</span>
              <Select
                className="w-28"
                value={ov.textAlign}
                onChange={(e) =>
                  updateTextOverlay(ov.id, {
                    textAlign: e.target.value as 'left' | 'center' | 'right',
                  })
                }
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </Select>
            </div>

            <Slider
              label="Size"
              min={12}
              max={200}
              value={ov.fontSize}
              unit="px"
              onChange={(v) => updateTextOverlay(ov.id, { fontSize: v })}
            />
            <div className="grid grid-cols-2 gap-2">
              <ColorField
                label="Text"
                value={ov.textColor}
                onChange={(v) => updateTextOverlay(ov.id, { textColor: v })}
              />
              <ColorField
                label="Outline"
                value={ov.textOutlineColor}
                onChange={(v) =>
                  updateTextOverlay(ov.id, { textOutlineColor: v })
                }
              />
            </div>
            <Slider
              label="Outline width"
              min={0}
              max={10}
              value={ov.textOutlineWidth}
              unit="px"
              onChange={(v) =>
                updateTextOverlay(ov.id, { textOutlineWidth: v })
              }
            />

            <ColorField
              label="Background"
              value={ov.backgroundColor}
              onChange={(v) =>
                updateTextOverlay(ov.id, { backgroundColor: v })
              }
            />
            <Slider
              label="Background opacity"
              min={0}
              max={100}
              value={Math.round(ov.backgroundOpacity * 100)}
              unit="%"
              onChange={(v) =>
                updateTextOverlay(ov.id, { backgroundOpacity: v / 100 })
              }
            />
            <Slider
              label="Padding X"
              min={0}
              max={80}
              value={ov.backgroundPaddingX}
              unit="px"
              onChange={(v) =>
                updateTextOverlay(ov.id, { backgroundPaddingX: v })
              }
            />
            <Slider
              label="Padding Y"
              min={0}
              max={80}
              value={ov.backgroundPaddingY}
              unit="px"
              onChange={(v) =>
                updateTextOverlay(ov.id, { backgroundPaddingY: v })
              }
            />
            <Slider
              label="Corner radius"
              min={0}
              max={60}
              value={ov.backgroundRadius}
              unit="px"
              onChange={(v) =>
                updateTextOverlay(ov.id, { backgroundRadius: v })
              }
            />

            <Slider
              label="Position X"
              min={0}
              max={100}
              value={Math.round(ov.positionX * 100)}
              unit="%"
              onChange={(v) =>
                updateTextOverlay(ov.id, { positionX: v / 100 })
              }
            />
            <Slider
              label="Position Y"
              min={0}
              max={100}
              value={Math.round(ov.positionY * 100)}
              unit="%"
              onChange={(v) =>
                updateTextOverlay(ov.id, { positionY: v / 100 })
              }
            />
            <Slider
              label="Max width"
              min={10}
              max={100}
              value={Math.round(ov.maxWidth * 100)}
              unit="%"
              onChange={(v) =>
                updateTextOverlay(ov.id, { maxWidth: v / 100 })
              }
            />
          </div>
        );
      })}

      <hr className="border-border" />

      {/* Safe-area / dead-zone overlays.
          Only the presets that match the current video's aspect bucket are
          shown — Instagram/TikTok/Shorts dead zones are vertical-only and
          would be misleading on a 16:9 clip. If the user has a stale
          selection (e.g. they loaded a 9:16 session then dropped a 16:9
          video), we silently keep showing it but the gate stops them from
          *picking* one that doesn't match.
          The check below is intentionally loose — see bucketForAspect. */}
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
        Dead zones
      </h3>
      <div className="text-xs text-text-muted">
        Red areas are where platform UI covers the video. Preview-only — not
        burned.{' '}
        {aspectBucket !== 'portrait' && (
          <span className="text-amber-300/80">
            Vertical presets are hidden — your video is{' '}
            {aspectBucket === 'square' ? 'square' : 'landscape'}.
          </span>
        )}
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
          {aspectBucket === 'portrait' && (
            <>
              <option value="instagram">Instagram Reels</option>
              <option value="tiktok">TikTok</option>
              <option value="youtube-shorts">YouTube Shorts</option>
            </>
          )}
        </Select>
      </div>
    </div>
  );
}
