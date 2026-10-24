import { describe, it, expect } from 'vitest';
import { DEFAULT_EXTRACT_RULE } from '@/domain/realSales/masters';
import { extractContainerQty, readProductSalesCsv } from '@/domain/realSales/productSalesCsv';
import { TEST_EXPECTED, TEST_SALES_ROWS, buildProductSalesCsv, type SalesRow } from '../../helpers/realSalesData';

const rule = DEFAULT_EXTRACT_RULE;

describe('商品別売上CSVの読み取り', () => {
  it('販売数を出数として読み、売上金額を合計する', () => {
    const f = readProductSalesCsv(buildProductSalesCsv(), 'sales.csv');
    expect(f.issues).toEqual([]);
    expect(f.rows).toHaveLength(TEST_SALES_ROWS.length);
    expect(f.amountTotal).toBe(TEST_EXPECTED.csvAmountTotal);
  });

  it('列名が「出数」でも読める（要件の表記）', () => {
    const header = '大分類,中分類,小分類,商品コード,商品名,価格,出数,販売数構成比,一日当たり平均販売数,10万円当たり,売上金額,売上金額構成比';
    const f = readProductSalesCsv(buildProductSalesCsv(TEST_SALES_ROWS, header), 'sales.csv');
    expect(f.issues).toEqual([]);
    expect(extractContainerQty(f, rule).qty).toBe(TEST_EXPECTED.containerQty);
  });

  it('販売数が数値でない行は E018 にまとめる', () => {
    const bytes = new TextEncoder().encode(
      new TextDecoder().decode(buildProductSalesCsv()).replace(',100,', ',百,'),
    );
    const f = readProductSalesCsv(bytes, 'sales.csv');
    expect(f.issues.map((i) => i.code)).toEqual(['E018']);
    expect(f.issues[0]!.message).toContain('百');
  });
});

describe('容器対象出数の抽出（要件§11.4）', () => {
  const f = readProductSalesCsv(buildProductSalesCsv(), 'sales.csv');
  const x = extractContainerQty(f, rule);

  it('3条件の AND で数え、トッピングは除外、÷2 はしない', () => {
    expect(x.qty).toBe(TEST_EXPECTED.containerQty);
    expect(x.excludedQty).toBe(TEST_EXPECTED.excludedQty);
  });

  it('中分類ごとの内訳を返す', () => {
    expect(Object.fromEntries(x.byMid.map((m) => [m.mid, m.qty]))).toEqual({
      テイクアウト_カレー: 115,
      代行_カレー: 85,
      テイクアウト_期間限定: 22,
      代行_期間限定: 33,
    });
  });

  it('イートインやサラダは数えない', () => {
    expect(x.included.some((r) => r.mid.startsWith('イートイン') || r.big === 'サラダ')).toBe(false);
  });

  it('対象の大分類に未知の中分類があれば W029（数えない）', () => {
    const rows: SalesRow[] = [...TEST_SALES_ROWS, ['カレー', 'モバイル_カレー', 'MO_カレー（A）', 30, 0]];
    const y = extractContainerQty(readProductSalesCsv(buildProductSalesCsv(rows), 's.csv'), rule);
    expect(y.qty).toBe(TEST_EXPECTED.containerQty);
    expect(y.issues.map((i) => i.code)).toEqual(['W029']);
    expect(y.issues[0]!.message).toContain('モバイル_カレー');
  });

  it('対象の中分類に未知の小分類があれば W029（数えたうえで知らせる）', () => {
    const rows: SalesRow[] = [...TEST_SALES_ROWS, ['カレー', 'テイクアウト_カレー', 'TO_カレー3品MIX（A）', 4, 0]];
    const y = extractContainerQty(readProductSalesCsv(buildProductSalesCsv(rows), 's.csv'), rule);
    expect(y.qty).toBe(TEST_EXPECTED.containerQty + 4);
    expect(y.issues.map((i) => i.code)).toEqual(['W029']);
  });
});
