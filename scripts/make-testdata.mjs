/**
 * 手動テスト用のサンプルファイルを生成する。
 *
 *   npm run testdata          → testdata/ に出力
 *   npm run testdata -- 出力先 → 任意のフォルダに出力
 *
 * 店舗の実データを使わずに画面テスト（L5）を回せるようにするのが目的。
 * データの定義は tests/helpers/testdataSet.ts にあり、
 * 自動の画面テスト（tests/ui/）も同じものを参照する。
 * 手動と自動で期待値がずれないよう、内容を変えるときは testdataSet.ts を直す。
 *
 * 生成物はすべて .gitignore の対象（testdata/・*.xlsx・*.csv）でリポジトリには入らない。
 * テストの手順は docs/06_画面テスト手順書.md を参照。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

const outDir = process.argv[2] ?? 'testdata';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const { buildNormalSet, buildAbnormalSet } = await server.ssrLoadModule('/tests/helpers/testdataSet.ts');

const normal = await buildNormalSet();
const files = [...Object.values(normal), ...(await buildAbnormalSet())];

mkdirSync(outDir, { recursive: true });
for (const file of files) {
  writeFileSync(join(outDir, file.name), Buffer.from(file.bytes));
}

await server.close();

console.log(`${outDir}/ に ${files.length} 件を生成しました:`);
const width = Math.max(...files.map((f) => f.name.length));
for (const file of files) {
  console.log(`  ${file.name.padEnd(width)}  ${file.note}`);
}
