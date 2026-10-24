/**
 * リアル売上算出の実データ検証（要件§11.10 RS-01〜03）。
 *
 * 店舗の実データと期待値はリポジトリに含めない。
 *  - 商品別売上CSV: 環境変数 REAL_SALES のフォルダ（既定は Downloads 配下）
 *  - 期待値・写真から読んだ値・料率: tests/fixtures/real/expected.json の realSales（gitignore 対象）
 * どちらかが無ければスキップする。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeRealSales } from '@/domain/realSales/compute';
import { toDecimalString } from '@/domain/realSales/fixed';
import { channelRow, DEFAULT_MASTERS, type RealSalesMasters } from '@/domain/realSales/masters';
import { extractContainerQty, readProductSalesCsv } from '@/domain/realSales/productSalesCsv';
import { REAL_EXPECTED } from '../helpers/realExpected';

const DIR = process.env['REAL_SALES'] ?? join('C:', 'Users', 'kimi4', 'Downloads', 'リアル売上計算', 'リアル売上計算');
const CSV = join(DIR, '2026.08商品別売上_20260928135959539.csv');
const EXP = REAL_EXPECTED?.realSales?.august;

describe.skipIf(!existsSync(CSV) || !EXP)('リアル売上 実データ（2026年8月）', () => {
  const e = EXP!;
  const masters: RealSalesMasters = {
    ...DEFAULT_MASTERS,
    channels: e.rates.map((r) => channelRow(r.id, r.rate)),
    containerPrices: [{ price: e.containerPrice, validFrom: '2000-01', validTo: null }],
  };
  const file = readProductSalesCsv(new Uint8Array(readFileSync(CSV)), '商品別売上.csv');
  const x = extractContainerQty(file, masters.extractRules[0]!);

  it('CP932 の実CSVを読める', () => {
    expect(file.issues).toEqual([]);
    expect(file.rows).toHaveLength(e.csvRows);
  });

  it('RS-01 容器対象の行数と出数が出数検証値と一致する', () => {
    expect(x.included).toHaveLength(e.includedRows);
    expect(x.qty).toBe(e.containerQty);
    expect(x.issues).toEqual([]);
  });

  it('CSV の売上金額合計は 総計1 − 値割引合計 + 値割引消費税 と1円単位で一致する', () => {
    const j = e.journal;
    expect(file.amountTotal).toBe(e.csvAmountTotal);
    expect(Number(j.grossTotal) - Number(j.discountTotal) + Number(j.discountTax)).toBe(e.csvAmountTotal);
  });

  it('RS-02・RS-03 容器代・手数料・リアル売上を厳密に再現し、検算①②とも成立する', () => {
    const r = computeRealSales({
      targetYm: '2026-08',
      journal: e.journal,
      container: { source: 'csv', extraction: x, csvAmountTotal: file.amountTotal, fileName: file.fileName },
      masters,
    });
    expect(r.issues).toEqual([]);
    expect(toDecimalString(r.breakdown!.containerCost)).toBe(e.containerCost);
    expect(toDecimalString(r.breakdown!.feeTotal)).toBe(e.feeTotal);
    expect(toDecimalString(r.breakdown!.realSales)).toBe(e.realSales);
    expect(r.breakdown!.checks.receivables.status).toBe('ok');
    expect(r.breakdown!.checks.csv.status).toBe('ok');
  });
});
