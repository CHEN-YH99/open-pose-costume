import { useEffect, useRef } from 'react';
import { cropPixels, cropViews } from './three-view';
import type { CropRect, CropView, ThreeViewCrops } from './three-view';
import type { ThreeViewSheet } from './three-view-crop';
import { threeViewCopy } from './three-view-copy';
import type { Lang } from './types';

function CropPreview({
  sheet,
  crop,
  label,
}: {
  sheet: ThreeViewSheet;
  crop: CropRect;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const preview = canvas.current;
    if (!preview) return;
    const context = preview.getContext('2d');
    if (!context) return;
    preview.width = 320;
    preview.height = 420;
    context.clearRect(0, 0, 320, 420);
    if (
      ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
      crop.x < 0 ||
      crop.y < 0 ||
      crop.width <= 0 ||
      crop.height <= 0 ||
      crop.x + crop.width > 1 + 1e-9 ||
      crop.y + crop.height > 1 + 1e-9
    )
      return;
    const pixels = cropPixels(crop, sheet.width, sheet.height);
    if (pixels.width <= 0 || pixels.height <= 0) return;
    const scale = Math.min(300 / pixels.width, 400 / pixels.height);
    const width = pixels.width * scale,
      height = pixels.height * scale;
    context.drawImage(
      sheet.image,
      pixels.left,
      pixels.top,
      pixels.width,
      pixels.height,
      (320 - width) / 2,
      (420 - height) / 2,
      width,
      height,
    );
  }, [sheet, crop]);
  return <canvas ref={canvas} role="img" aria-label={label} />;
}

export function ThreeViewEditor({
  sheet,
  crops,
  lang,
  disabled,
  onChange,
}: {
  sheet: ThreeViewSheet;
  crops: ThreeViewCrops;
  lang: Lang;
  disabled: boolean;
  onChange: (view: CropView, field: keyof CropRect, value: number) => void;
}) {
  const text = threeViewCopy[lang];
  return (
    <div className="three-view-crop-grid">
      {cropViews.map((view) => {
        const crop = crops[view];
        const pixels = cropPixels(crop, sheet.width, sheet.height);
        return (
          <fieldset className="three-view-crop-card" key={view} disabled={disabled}>
            <legend>{text[view]}</legend>
            <CropPreview sheet={sheet} crop={crop} label={text[view]} />
            <div className="three-view-crop-fields">
              {(['x', 'y', 'width', 'height'] as const).map((field) => (
                <label key={field}>
                  <span>{text[field]}</span>
                  <input
                    type="number"
                    min={field === 'x' || field === 'y' ? 0 : 0.1}
                    max={100}
                    step="0.001"
                    required
                    value={
                      Number.isFinite(crop[field]) ? Number((crop[field] * 100).toFixed(3)) : ''
                    }
                    aria-label={`${text[view]} ${text[field]}`}
                    onChange={(event) => onChange(view, field, event.target.valueAsNumber / 100)}
                  />
                </label>
              ))}
            </div>
            <small>
              {Number.isFinite(pixels.width) && Number.isFinite(pixels.height)
                ? `${pixels.width}×${pixels.height} px`
                : '—'}
            </small>
          </fieldset>
        );
      })}
    </div>
  );
}
