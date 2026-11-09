import { readResultBlob } from './generation-history';
import { cropPixels, cropViews, validateThreeViewCrops } from './three-view';
import type { CropView, ThreeViewCrops } from './three-view';

export interface ThreeViewSheet {
  image: HTMLImageElement;
  source: string;
  width: number;
  height: number;
  dispose: () => void;
}

export async function loadThreeViewSheet(
  source: string,
  signal: AbortSignal,
): Promise<ThreeViewSheet> {
  const blob = await readResultBlob(source, signal, 20 * 1024 * 1024);
  signal.throwIfAborted();
  if (blob.size > 20 * 1024 * 1024) throw Error('imageFailed');
  const owned = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        image.onload = null;
        image.onerror = null;
      };
      const abort = () => {
        cleanup();
        image.src = '';
        reject(signal.reason);
      };
      image.onload = () => {
        cleanup();
        resolve();
      };
      image.onerror = () => {
        cleanup();
        reject(Error('imageFailed'));
      };
      signal.addEventListener('abort', abort, { once: true });
      image.src = owned;
    });
    signal.throwIfAborted();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 40_000_000
    )
      throw Error('imageFailed');
    return {
      image,
      source: owned,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(owned),
    };
  } catch (error) {
    URL.revokeObjectURL(owned);
    throw error;
  }
}

export async function cropThreeViewImages(
  sheet: ThreeViewSheet,
  crops: ThreeViewCrops,
  signal: AbortSignal,
): Promise<Record<CropView, Blob>> {
  const error = validateThreeViewCrops(crops, sheet.width, sheet.height);
  if (error) throw Error(error);
  const images = {} as Record<CropView, Blob>;
  for (const view of cropViews) {
    signal.throwIfAborted();
    const pixels = cropPixels(crops[view], sheet.width, sheet.height);
    const scale = Math.min(1, 2048 / Math.max(pixels.width, pixels.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(pixels.width * scale);
    canvas.height = Math.round(pixels.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw Error('imageFailed');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      sheet.image,
      pixels.left,
      pixels.top,
      pixels.width,
      pixels.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    images[view] = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob && blob.size <= 5 * 1024 * 1024 ? resolve(blob) : reject(Error('imageFailed')),
        'image/png',
      );
    });
    canvas.width = 0;
    canvas.height = 0;
  }
  signal.throwIfAborted();
  return images;
}
