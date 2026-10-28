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
    for (const row of r.rows) console.log(row.index, JSON.stringify(row.text), row.candidates.slice(0, 3));
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

  it('売掛欄の内訳の表記をすべて決められる（読めない行は消去法で、注記つき）', () => {
    expect(r.receivables.map((x) => x.label)).toEqual(EXP!.journal.receivables.map((x) => x.label));
    expect(r.receivables.every((x) => x.labelBy !== 'none')).toBe(true);
    for (const x of r.receivables.filter((y) => y.labelBy === 'elimination')) expect(x.note).toMatch(/消去法/);
  });

  it('手数料の対象になる代行チャネルの金額を、すべて正しく読む', () => {
    const channels = new Set(KNOWN_CHANNELS.flatMap((c) => [c.name, ...c.aliases]));
    const expected = EXP!.journal.receivables.filter((x) => channels.has(x.label));
    expect(expected.length).toBe(6);
    expect(r.receivables.filter((x) => channels.has(x.label)).map((x) => ({ label: x.label, amount: x.value }))).toEqual(expected);
  });

  it('検算①が合わない項目は、補正せずに人の確認へ回す（誤った値を確定しない）', () => {
    // 内訳の合計と売掛合計が1桁ずつ違い、どの項目の誤読かを一意に決められない写真。
    // 勝手に直すと誤った値が確定してしまうので、多数決のまま残し、画面で検算①の不一致を示す。
    const sum = r.receivables.reduce((a, x) => a + BigInt(x.value ?? '0'), 0n).toString();
    if (sum !== r.receivableTotal.value) {
      expect(r.receivableTotal.source).not.toBe('checked');
      expect(r.receivables.every((x) => x.source !== 'checked')).toBe(true);
    }
  });

  it('補正した項目には補正した旨が付く（人が確認できるように）', () => {
    const all = [r.grossTotal, r.discountTotal, r.discountTax, r.receivableTotal, ...r.receivables];
    for (const f of all.filter((x) => x.source === 'corrected')) expect(f.note).toMatch(/補正/);
  });
});
