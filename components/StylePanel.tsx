'use client';

import { useRef } from 'react';
import { useEditor } from '@/lib/store';
import type { SafeZonePreset, Style } from '@/lib/types';
import { FontPicker } from './FontPicker';
import { Slider } from './ui/slider';
import { Select } from './ui/select';
import { Button } from './ui/button';
import { GOOGLE_FONTS, loadGoogleFont } from '@/lib/google-fonts';

// Right-side panel: all style knobs. Three editing modes:
//
//   1. Text overlay selected → controls edit that overlay's properties
//   2. Subtitle block selected → controls edit that block's styleOverride
//   3. Nothing selected → controls edit the global subtitle style
//
// Every change is immediately reflected in the VideoPreview because both
// read from the same Zustand store.

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
    blocks,
    selectedBlockId,
    selectBlock,
    updateBlock,
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

  // --- Mode detection ---
  // Priority: text overlay > selected subtitle block > global
  const selectedText = selectedTextOverlayId
    ? textOverlays.find((t) => t.id === selectedTextOverlayId)
    : null;
  const selectedBlock = !selectedText && selectedBlockId
    ? blocks.find((b) => b.id === selectedBlockId)
    : null;

  const isTextMode = !!selectedText;
  const isBlockMode = !!selectedBlock;
  const isGlobalMode = !isTextMode && !isBlockMode;

  // Effective style values: merge block override on top of global for display
  const blockStyle: Style | null = selectedBlock
    ? { ...style, ...(selectedBlock.styleOverride ?? {}) }
    : null;

  // Helpers to read/write the active style target.
  const val = {
    fontFamily: isTextMode ? selectedText!.fontFamily : isBlockMode ? blockStyle!.fontFamily : style.fontFamily,
    fontSize: isTextMode ? selectedText!.fontSize : isBlockMode ? blockStyle!.fontSize : style.fontSize,
    fontWeight: isTextMode ? selectedText!.fontWeight : isBlockMode ? blockStyle!.fontWeight : style.fontWeight,
    italic: isTextMode ? selectedText!.italic : isBlockMode ? (blockStyle!.italic ?? style.italic) : style.italic,
    textAlign: isTextMode ? selectedText!.textAlign : isBlockMode ? (blockStyle!.textAlign ?? style.textAlign) : style.textAlign,
    textColor: isTextMode ? selectedText!.textColor : isBlockMode ? blockStyle!.textColor : style.textColor,
    textOutlineColor: isTextMode ? selectedText!.textOutlineColor : isBlockMode ? blockStyle!.textOutlineColor : style.textOutlineColor,
    textOutlineWidth: isTextMode ? selectedText!.textOutlineWidth : isBlockMode ? blockStyle!.textOutlineWidth : style.textOutlineWidth,
    backgroundColor: isTextMode ? selectedText!.backgroundColor : isBlockMode ? blockStyle!.backgroundColor : style.backgroundColor,
    backgroundOpacity: isTextMode ? selectedText!.backgroundOpacity : isBlockMode ? blockStyle!.backgroundOpacity : style.backgroundOpacity,
    backgroundPaddingX: isTextMode ? selectedText!.backgroundPaddingX : isBlockMode ? (blockStyle!.backgroundPaddingX ?? style.backgroundPaddingX) : style.backgroundPaddingX,
    backgroundPaddingY: isTextMode ? selectedText!.backgroundPaddingY : isBlockMode ? (blockStyle!.backgroundPaddingY ?? style.backgroundPaddingY) : style.backgroundPaddingY,
    backgroundRadius: isTextMode ? selectedText!.backgroundRadius : isBlockMode ? (blockStyle!.backgroundRadius ?? style.backgroundRadius) : style.backgroundRadius,
    positionX: isTextMode ? selectedText!.positionX : isBlockMode ? (blockStyle!.positionX ?? style.positionX) : style.positionX,
    positionY: isTextMode ? selectedText!.positionY : isBlockMode ? blockStyle!.positionY : style.positionY,
    maxWidth: isTextMode ? selectedText!.maxWidth : isBlockMode ? blockStyle!.maxWidth : style.maxWidth,
  };

  const set = (patch: Record<string, unknown>) => {
    if (isTextMode) {
      updateTextOverlay(selectedText!.id, patch);
    } else if (isBlockMode) {
      // Merge into the block's styleOverride
      updateBlock(selectedBlock!.id, {
        styleOverride: { ...(selectedBlock!.styleOverride ?? {}), ...patch } as Partial<Style>,
      });
    } else {
      setStyle(patch);
    }
  };

  const modeLabel = isTextMode
    ? 'Text layer style'
    : isBlockMode
      ? 'Subtitle block style'
      : 'Subtitle style';

  return (
    <div
      data-tour="style-panel"
      className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-3"
    >
      {/* Mode indicator */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          {modeLabel}
        </h3>
        {isTextMode && (
          <button
            type="button"
            onClick={() => selectTextOverlay(null)}
            className="text-[10px] text-text-muted hover:text-text"
          >
            Back to subs
          </button>
        )}
        {isBlockMode && (
          <div className="flex items-center gap-2">
            {selectedBlock!.styleOverride &&
              Object.keys(selectedBlock!.styleOverride).length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    updateBlock(selectedBlock!.id, { styleOverride: undefined })
                  }
                  className="text-[10px] text-text-muted hover:text-text"
                >
                  Reset to global
                </button>
              )}
            <button
              type="button"
              onClick={() => selectBlock(null)}
              className="text-[10px] text-text-muted hover:text-text"
            >
              Back to global
            </button>
          </div>
        )}
      </div>

      {/* Block info hint */}
      {isBlockMode && (
        <div className="rounded bg-accent/10 px-2 py-1 text-[10px] text-text-muted">
          Editing block: &ldquo;{selectedBlock!.text.slice(0, 40)}{selectedBlock!.text.length > 40 ? '...' : ''}&rdquo;
        </div>
      )}

      {/* Text content + timing — only shown in text overlay mode */}
      {isTextMode && (
        <>
          <textarea
            value={selectedText!.text}
            onChange={(e) =>
              updateTextOverlay(selectedText!.id, { text: e.target.value })
            }
            rows={Math.max(1, selectedText!.text.split('\n').length)}
            className="w-full resize-none rounded bg-bg-hi px-1.5 py-1 text-xs text-text outline-none"
          />
          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            <label className="flex items-center gap-1">
              <span>start</span>
              <input
                type="number"
                step={0.05}
                value={selectedText!.start.toFixed(2)}
                onChange={(e) =>
                  updateTextOverlay(selectedText!.id, {
                    start: Number(e.target.value),
                  })
                }
                className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono"
              />
            </label>
            <label className="flex items-center gap-1">
              <span>end</span>
              <input
                type="number"
                step={0.05}
                value={selectedText!.end.toFixed(2)}
                onChange={(e) =>
                  updateTextOverlay(selectedText!.id, {
                    end: Number(e.target.value),
                  })
                }
                className="w-14 rounded bg-bg-hi px-1 py-0.5 font-mono"
              />
            </label>
          </div>
        </>
      )}

      <FontPicker
        compact={isTextMode || isBlockMode}
        value={
          isTextMode
            ? { family: selectedText!.fontFamily, weight: selectedText!.fontWeight }
            : isBlockMode
              ? { family: blockStyle!.fontFamily, weight: blockStyle!.fontWeight }
              : undefined
        }
        onChange={(family) => {
          if ((isBlockMode || isGlobalMode) && GOOGLE_FONTS.includes(family)) {
            loadGoogleFont(family, val.fontWeight);
          }
          set({ fontFamily: family });
        }}
      />

      <Slider
        label="Font size"
        min={isTextMode ? 12 : 16}
        max={isTextMode ? 200 : isBlockMode ? 300 : 120}
        value={val.fontSize}
        unit="px"
        onChange={(v) => set({ fontSize: v })}
      />

      <Slider
        label="Font weight"
        min={100}
        max={900}
        step={100}
        value={val.fontWeight}
        onChange={(v) => set({ fontWeight: v })}
      />

      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">Italic</span>
        <input
          type="checkbox"
          checked={val.italic}
          onChange={(e) => set({ italic: e.target.checked })}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">Text align</span>
        <Select
          className="w-28"
          value={val.textAlign}
          onChange={(e) =>
            set({ textAlign: e.target.value as 'left' | 'center' | 'right' })
          }
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </Select>
      </div>

      {/* Line height / letter / word spacing — subtitle-only (global or per-block) */}
      {!isTextMode && (
        <>
          <Slider
            label="Line height"
            min={80}
            max={220}
            step={5}
            value={Math.round(((isBlockMode ? blockStyle!.lineHeight : style.lineHeight) ?? 1.2) * 100)}
            unit="%"
            onChange={(v) => set({ lineHeight: v / 100 })}
          />
          <Slider
            label="Letter spacing"
            min={-5}
            max={20}
            value={(isBlockMode ? blockStyle!.letterSpacing : style.letterSpacing) ?? 0}
            unit="px"
            onChange={(v) => set({ letterSpacing: v })}
          />
          <Slider
            label="Word spacing"
            min={-5}
            max={30}
            value={(isBlockMode ? blockStyle!.wordSpacing : style.wordSpacing) ?? 0}
            unit="px"
            onChange={(v) => set({ wordSpacing: v })}
          />
        </>
      )}

      {/* Karaoke — subtitle-only */}
      {!isTextMode && (
        <>
          <hr className="border-border" />
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted">Karaoke (word-pop)</span>
            <input
              type="checkbox"
              checked={isBlockMode ? (blockStyle!.karaoke ?? style.karaoke) : style.karaoke}
              onChange={(e) => set({ karaoke: e.target.checked })}
            />
          </div>
          {(isBlockMode ? (blockStyle!.karaoke ?? style.karaoke) : style.karaoke) && (
            <ColorField
              label="Unspoken color"
              value={isBlockMode ? (blockStyle!.karaokeBaseColor ?? style.karaokeBaseColor) : style.karaokeBaseColor}
              onChange={(v) => set({ karaokeBaseColor: v })}
            />
          )}
        </>
      )}

      <hr className="border-border" />

      <ColorField
        label="Text color"
        value={val.textColor}
        onChange={(v) => set({ textColor: v })}
      />
      <ColorField
        label="Outline color"
        value={val.textOutlineColor}
        onChange={(v) => set({ textOutlineColor: v })}
      />
      <Slider
        label="Outline width"
        min={0}
        max={10}
        value={val.textOutlineWidth}
        unit="px"
        onChange={(v) => set({ textOutlineWidth: v })}
      />

      <hr className="border-border" />

      <ColorField
        label="Background"
        value={val.backgroundColor}
        onChange={(v) => set({ backgroundColor: v })}
      />
      <Slider
        label="Background opacity"
        min={0}
        max={100}
        value={Math.round(val.backgroundOpacity * 100)}
        unit="%"
        onChange={(v) => set({ backgroundOpacity: v / 100 })}
      />
      <Slider
        label="Padding X"
        min={0}
        max={80}
        value={val.backgroundPaddingX}
        unit="px"
        onChange={(v) => set({ backgroundPaddingX: v })}
      />
      <Slider
        label="Padding Y"
        min={0}
        max={80}
        value={val.backgroundPaddingY}
        unit="px"
        onChange={(v) => set({ backgroundPaddingY: v })}
      />
      <Slider
        label="Corner radius"
        min={0}
        max={60}
        value={val.backgroundRadius}
        unit="px"
        onChange={(v) => set({ backgroundRadius: v })}
      />

      <hr className="border-border" />

      <Slider
        label="Position X"
        min={0}
        max={100}
        value={Math.round(val.positionX * 100)}
        unit="%"
        onChange={(v) => set({ positionX: v / 100 })}
      />
      <Slider
        label="Position Y"
        min={0}
        max={100}
        value={Math.round(val.positionY * 100)}
        unit="%"
        onChange={(v) => set({ positionY: v / 100 })}
      />
      <Slider
        label="Max width"
        min={10}
        max={100}
        value={Math.round(val.maxWidth * 100)}
        unit="%"
        onChange={(v) => set({ maxWidth: v / 100 })}
      />

      <hr className="border-border" />

      {/* Image overlays */}
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

      {/* Text overlays — list of cards. Clicking one selects it and switches
          the main controls above to edit that overlay's style. */}
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
            className={`flex items-center gap-2 rounded-md border p-2 cursor-pointer ${
              isSelected ? 'border-accent bg-accent/5' : 'border-border hover:border-border-hi'
            }`}
            onClick={() => selectTextOverlay(ov.id)}
          >
            <div className="min-w-0 flex-1 truncate text-xs text-text">
              {ov.text || '(empty)'}
            </div>
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
        );
      })}

      <hr className="border-border" />

      {/* Safe-area / dead-zone overlays */}
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
