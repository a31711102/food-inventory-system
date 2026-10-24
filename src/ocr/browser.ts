/**
 * ブラウザでジャーナル写真を読む。
 *
 * このモジュールは売上確定の画面で必要になったときだけ読み込む（dynamic import）。
 * OCR の部品は合わせて十数MBあるので、リアル売上を使わない月に読み込ませない。
 * 写真はブラウザ内で処理し、外部へは送らない（要件§11.3）。
 */
import { toGray, type Gray, type Rect } from './gray';
import { readJournal, type JournalOcrResult, type OcrOptions } from './journalOcr';
import { createTesseractBackend } from './tesseractBackend';

const assetUrl = (path: string): string => new URL(`${import.meta.env.BASE_URL}ocr/${path}`, window.location.href).href;

export async function decodeImage(file: Blob): Promise<Gray> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return toGray(img.data, img.width, img.height);
}

export async function readJournalInBrowser(file: Blob, opts: OcrOptions): Promise<JournalOcrResult> {
  const photo = await decodeImage(file);
  const backend = await createTesseractBackend({
    worker: {
      workerPath: assetUrl('worker.min.js'),
      corePath: assetUrl('core'),
      langPath: assetUrl('lang'),
      gzip: true,
      // 学習データはブラウザ内（IndexedDB）にだけ保存し、2回目以降の読み込みを速くする
      cacheMethod: 'write',
    },
    toImage: (pgm) => new Blob([pgm.slice().buffer as ArrayBuffer]),
  });
  try {
    return await readJournal(photo, backend, opts);
  } finally {
    await backend.terminate();
  }
}

/** 照合表示用に、基準画像の一部を画像（data URL）にする */
export function cropToDataUrl(base: Gray, r: Rect): string {
  const left = Math.max(0, Math.round(r.left)), top = Math.max(0, Math.round(r.top));
  const w = Math.max(1, Math.min(base.width - left, Math.round(r.width)));
  const h = Math.max(1, Math.min(base.height - top, Math.round(r.height)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = base.data[(top + y) * base.width + left + x]!;
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}
