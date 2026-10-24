/**
 * OCR の部品を public/ocr/ にコピーする（dev と build の前に自動で実行）。
 *
 * 写真は端末外へ送らない（要件§11.3）。OCR の実行環境と学習データも CDN から取らず、
 * 本システムと同じ配信元（GitHub Pages）から配る。
 * コピー先は gitignore 対象で、npm ci 済みの node_modules から毎回作り直す。
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'ocr');

const files = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js'],
  ['@tesseract.js-data/jpn/4.0.0_best_int/jpn.traineddata.gz', 'lang/jpn.traineddata.gz'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz'],
];

for (const [from, to] of files) {
  const src = join(nm, from);
  if (!existsSync(src)) {
    console.error(`OCR の部品が見つかりません: ${from}（npm install を実行してください）`);
    process.exit(1);
  }
  const dst = join(out, to);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}
console.log(`OCR の部品を ${files.length} 件コピーしました → public/ocr/`);
