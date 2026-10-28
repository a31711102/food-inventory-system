/**
 * Tesseract.js による認識エンジン（OcrBackend の実装）。
 *
 * ブラウザでは Web Worker＋WASM で動き、写真は端末の外へ出ない（要件§11.3）。
 * 部品（Worker・WASM・学習データ）は public/ocr/ から読み、CDN は使わない。
 * テストでは Node 版の Tesseract.js に同じコードで差し替える。
 *
 * ワーカーは3つ使う。
 *  - page: 日本語＋英字で写真全体を読む（行と語の位置が要るので blocks を取る）
 *  - digits: 金額の欄だけを数字として読む（日本語モデルは数字を誤読するため分ける）
 *  - line: 全文で読み落とした表記を、その行の左側だけ切り出して読み直す
 */
import { createWorker, PSM, type ImageLike, type Worker, type WorkerOptions } from 'tesseract.js';
import { encodePgm, type Gray } from './gray';
import type { OcrBackend, OcrPageLine } from './journalOcr';

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
  const [page, digits, line] = await Promise.all([make('jpn+eng'), make('eng'), make('jpn')]);
  // PSM.AUTO: 感熱紙のレポートは1段組だが、写真の傾き・重なりで段が分かれて見えることがある
  await page.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  await digits.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789,¥/' });
  await line.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });

  const img = (g: Gray): ImageLike => opts.toImage(encodePgm(g));

  return {
    async readPage(g): Promise<OcrPageLine[]> {
      const { data } = await page.recognize(img(g), {}, { blocks: true });
      return (data.blocks ?? []).flatMap((b) =>
        b.paragraphs.flatMap((p) =>
          p.lines.map((l) => ({
            text: l.text,
            bbox: l.bbox,
            words: l.words.map((w) => ({ text: w.text, bbox: w.bbox })),
          })),
        ),
      );
    },
    async readDigits(g): Promise<string> {
      return (await digits.recognize(img(g))).data.text;
    },
    async readLine(g): Promise<string> {
      return (await line.recognize(img(g))).data.text;
    },
    async terminate(): Promise<void> {
      await Promise.all([page, digits, line].map((w) => w.terminate()));
    },
  };
}
