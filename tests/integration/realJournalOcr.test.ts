/**
 * ジャーナル写真の OCR（要件§11.6・RS-04 の前提）。実写真で検証する。
 *
 * 写真と期待値は店舗の実データなのでリポジトリに含めない。無ければスキップする。
 *  - 写真: 環境変数 REAL_SALES のフォルダ
 *  - 期待値: tests/fixtures/real/expected.json の realSales.august.journal
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import jpeg from 'jpeg-js';
import { toGray } from '@/ocr/gray';
import { readJournal, type JournalOcrResult } from '@/ocr/journalOcr';
import { createTesseractBackend, type TesseractBackend } from '@/ocr/tesseractBackend';
import { KNOWN_CHANNELS, DEFAULT_MASTERS } from '@/domain/realSales/masters';
import { REAL_EXPECTED } from '../helpers/realExpected';

const DIR = process.env['REAL_SALES'] ?? join('C:', 'Users', 'kimi4', 'Downloads', 'リアル売上計算', 'リアル売上計算');
const PHOTO = join(DIR, '2026.08リアル売上用ジャーナル写真.jpg');
const EXP = REAL_EXPECTED?.realSales?.august;
const LANG = resolve('public', 'ocr', 'lang');

describe.skipIf(!existsSync(PHOTO) || !EXP)('ジャーナル写真の OCR（実写真）', () => {
  let backend: TesseractBackend;
  let r: JournalOcrResult;

  beforeAll(async () => {
    if (!existsSync(join(LANG, 'jpn.traineddata.gz'))) execFileSync('node', ['scripts/copy-ocr-assets.mjs']);
    const img = jpeg.decode(readFileSync(PHOTO), { useTArray: true, maxMemoryUsageInMB: 1024 });
    backend = await createTesseractBackend({
      worker: { langPath: LANG, gzip: true, cacheMethod: 'none' },
      toImage: (pgm) => Buffer.from(pgm),
    });
    const groups = [
      ...KNOWN_CHANNELS.map((c) => ({ id: c.id, labels: [c.name, ...c.aliases] })),
      ...DEFAULT_MASTERS.ignoredPayments.map((l) => ({ id: `ignored:${l}`, labels: [l] })),
    ];
    const t0 = Date.now();
    r = await readJournal(toGray(img.data, img.width, img.height), backend, {
      receivableGroups: groups,
      csvAmountTotal: EXP!.csvAmountTotal,
    });
    console.log(`OCR ${((Date.now() - t0) / 1000).toFixed(1)} 秒・行 ${r.rows.length}`);
    for (const row of r.rows) console.log(row.index, JSON.stringify(row.labelJpn), JSON.stringify(row.labelEng), row.candidates.slice(0, 3));
    console.log('営業月', r.businessYm, '店舗', r.storeName);
    console.log('総計1', r.grossTotal.value, r.grossTotal.source, '/ 値割引', r.discountTotal.value, r.discountTotal.source, '/ 税', r.discountTax.value, r.discountTax.source, '/ 売掛', r.receivableTotal.value, r.receivableTotal.source);
    for (const x of r.receivables) console.log('  ', x.label, x.labelBy, x.value, x.source, x.note ?? '');
  }, 600_000);

  afterAll(async () => {
    await backend?.terminate();
  });

  it('営業月を読む', () => {
    expect(r.businessYm.value).toBe(EXP!.journal.businessYm);
  });

  it('総計1・値割引合計・値割引消費税を読む（検算②の補正込み）', () => {
    expect(r.grossTotal.value).toBe(EXP!.journal.grossTotal);
    expect(r.discountTotal.value).toBe(EXP!.journal.discountTotal);
    expect(r.discountTax.value).toBe(EXP!.journal.discountTax);
  });

  it('売掛合計と売掛欄の内訳を、表記つきで読む（検算①の補正込み）', () => {
    expect(r.receivableTotal.value).toBe(EXP!.journal.receivableTotal);
    expect(r.receivables.map((x) => ({ label: x.label, amount: x.value }))).toEqual(EXP!.journal.receivables);
  });

  it('補正した項目には補正した旨が付く（人が確認できるように）', () => {
    const all = [r.grossTotal, r.discountTotal, r.discountTax, r.receivableTotal, ...r.receivables];
    for (const f of all.filter((x) => x.source === 'corrected')) expect(f.note).toMatch(/補正/);
  });
});
