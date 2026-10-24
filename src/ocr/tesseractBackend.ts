/**
 * Tesseract.js による認識エンジン（OcrBackend の実装）。
 *
 * ブラウザでは Web Worker＋WASM で動き、写真は端末の外へ出ない（要件§11.3）。
 * 部品（Worker・WASM・学習データ）は public/ocr/ から読み、CDN は使わない。
 * テストでは Node 版の Tesseract.js に同じコードで差し替える。
 */
import { createWorker, PSM, type ImageLike, type Worker, type WorkerOptions } from 'tesseract.js';
import { encodePgm, type Gray } from './gray';
import type { OcrBackend, OcrLine } from './journalOcr';

export interface TesseractBackendOptions {
  /** createWorker に渡す部品の置き場所。ブラウザは public/ocr/ を指す */
  worker?: Partial<WorkerOptions>;
  /** PGM のバイト列を Tesseract.js が受け取れる形にする（ブラウザは Blob、Node は Buffer） */
  toImage: (pgm: Uint8Array) => ImageLike;
}

export interface TesseractBackend extends OcrBackend {
  terminate(): Promise<void>;
}

export async function createTesseractBackend(opts: TesseractBackendOptions): Promise<TesseractBackend> {
  const make = (lang: string): Promise<Worker> => createWorker(lang, 1, { ...opts.worker });
  const [digits, jpnLine, engLine, jpnBlock] = await Promise.all([make('eng'), make('jpn'), make('eng'), make('jpn')]);
  await digits.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789,¥/' });
  await jpnLine.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
  await engLine.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
  await jpnBlock.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });

  const img = (g: Gray): ImageLike => opts.toImage(encodePgm(g));
  const text = async (w: Worker, g: Gray): Promise<string> => (await w.recognize(img(g))).data.text;

  return {
    readDigits: (g) => text(digits, g),
    readJpnLine: (g) => text(jpnLine, g),
    readEngLine: (g) => text(engLine, g),
    async readJpnBlock(g): Promise<OcrLine[]> {
      const { data } = await jpnBlock.recognize(img(g), {}, { blocks: true });
      return (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => ({ text: l.text, bbox: l.bbox }))));
    },
    async terminate(): Promise<void> {
      await Promise.all([digits, jpnLine, engLine, jpnBlock].map((w) => w.terminate()));
    },
  };
}
