import { describe, it, expect } from 'vitest';
import { buildReport } from '@/domain/report';
import { computeAllDerived } from '@/domain/calculation';
import { makeRow, code } from '../helpers/factories';

/** 単価1・期中使用量=amount となる行を作るヘルパ（集計の検証を読みやすくする） */
function amountRow(category: string, usageAmount: number, closingAmount = 0) {
  return makeRow({
    code: code('0' + String(Math.floor(Math.random() * 99999)).padStart(5, '0')),
    category,
    unitPrice: 1,
    purchaseQty: usageAmount,
    openingQty: 0,
    closingQty: 0,
    usageQty: usageAmount,
    usageAmount,
    closingAmount,
  });
}

describe('カテゴリ集計（入力用 U/V列の SUMIF 相当）', () => {
  it('同一分類の当月使用高を合算する', () => {
    const rows = [amountRow('01.ソース', 100), amountRow('01.ソース', 250), amountRow('04.米', 40)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 1000 });

    const sauce = report.categories.find((c) => c.category === '01.ソース');
    expect(sauce?.usageAmount).toBe(350);
  });

  it('期末在庫高も分類ごとに合算する', () => {
    const rows = [amountRow('01.ソース', 0, 30), amountRow('01.ソース', 0, 12)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 1000 });

    expect(report.categories.find((c) => c.category === '01.ソース')?.closingAmount).toBe(42);
  });

  it('該当商品がない分類も0として結果に含める', () => {
    const report = buildReport([], { targetYm: '2026-08', totalSales: 1000 });
    expect(report.categories).toHaveLength(17);
    expect(report.categories.every((c) => c.usageAmount === 0)).toBe(true);
  });

  it('分析用シートの表示順で返す（01〜14 → 17 → 15 → 16）', () => {
    const report = buildReport([], { targetYm: '2026-08', totalSales: 1000 });
    const codes = report.categories.map((c) => c.category);
    expect(codes[13]).toBe('14.限定');
    expect(codes[14]).toBe('17.カレーらーめん');
    expect(codes[15]).toBe('15.ガチャ玉');
    expect(codes[16]).toBe('16.靴他');
  });

  it('未知の分類は合計に含めず、理由を残す（警告自体は validation.ts の W013）', () => {
    const rows = [amountRow('99.新しい分類', 5000)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 1000 });

    expect(report.totalUsageAmount).toBe(0);
    expect(report.unavailableReasons).toHaveProperty('99.新しい分類');
  });
});

describe('合計（分析用 C22 = SUM(C5:C19)）', () => {
  it('ガチャ玉と靴他を合計から除外する', () => {
    const rows = [
      amountRow('01.ソース', 1000),
      amountRow('15.ガチャ玉', 500),
      amountRow('16.靴他', 300),
    ];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 10000 });

    expect(report.totalUsageAmount).toBe(1000);
  });

  it('除外カテゴリの使用高自体は保持する（表示はする）', () => {
    const rows = [amountRow('16.靴他', 52798.1)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 10000 });

    expect(report.categories.find((c) => c.category === '16.靴他')?.usageAmount).toBe(52798.1);
    expect(report.totalUsageAmount).toBe(0);
  });

  it('食材期末在庫計も同じ15カテゴリのみ合算する（F22=SUM(F5:F19)）', () => {
    const rows = [amountRow('01.ソース', 0, 1000), amountRow('15.ガチャ玉', 0, 500)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 10000 });

    expect(report.totalClosingAmount).toBe(1000);
  });

  it('カレーらーめんは合計に含める', () => {
    const rows = [amountRow('17.カレーらーめん', 8110.725)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 10000 });

    expect(report.totalUsageAmount).toBe(8110.725);
  });
});

describe('原価率（百分率でモデル保持）', () => {
  it('カテゴリ別原価率 = カテゴリ使用高 ÷ 当月売上高 × 100', () => {
    const rows = [amountRow('01.ソース', 600_000)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 5_000_000 });

    expect(report.categories.find((c) => c.category === '01.ソース')?.costRatePercent).toBe(
      (600_000 / 5_000_000) * 100,
    );
  });

  it('全体原価率 = 使用高合計 ÷ 当月売上高 × 100', () => {
    const rows = [amountRow('01.ソース', 2_000_000)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 5_000_000 });

    expect(report.overallCostRatePercent).toBeCloseTo(40, 10);
  });
});

describe('ロス引き後原価（分析用 K9 = C22 − K7）', () => {
  it('ロス額の既定は0で、ロス引き後原価は使用高合計と等しい', () => {
    const rows = [amountRow('01.ソース', 2_000_000)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 5_000_000 });

    expect(report.lossAmount).toBe(0);
    expect(report.costAfterLoss).toBe(2_000_000);
  });

  it('ロス額を指定すると差し引かれる', () => {
    const rows = [amountRow('01.ソース', 100000)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 1000000, lossAmount: 5000 });

    expect(report.costAfterLoss).toBe(95000);
  });

  it('ロス引き後原価率 = ロス引き後原価 ÷ 当月売上高 × 100（L11）', () => {
    const rows = [amountRow('01.ソース', 2_000_000)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 5_000_000 });

    expect(report.costRateAfterLossPercent).toBeCloseTo(40, 10);
  });
});

describe('サラダ野菜使用高（分析用 L14 = C13）', () => {
  it('野菜カテゴリの当月使用高をそのまま返す', () => {
    const rows = [amountRow('09.野菜', 120_000), amountRow('01.ソース', 999)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 5_000_000 });

    expect(report.saladVegetableUsage).toBe(120_000);
  });
});

describe('売上高が使えない場合（要件§6）', () => {
  it.each([
    [0, '売上高が0'],
    [null, '売上高が未入力'],
    [-1, '売上高が負値'],
  ])('売上高 %p なら原価率を null にし理由を残す', (totalSales, expectedFragment) => {
    const rows = [amountRow('01.ソース', 1000)];
    const report = buildReport(rows, { targetYm: '2026-08', totalSales });

    expect(report.overallCostRatePercent).toBeNull();
    expect(report.costRateAfterLossPercent).toBeNull();
    expect(report.categories[0]!.costRatePercent).toBeNull();
    expect(JSON.stringify(report.unavailableReasons)).toContain(expectedFragment);
  });

  it('0%として扱わない', () => {
    const report = buildReport([amountRow('01.ソース', 1000)], {
      targetYm: '2026-08',
      totalSales: 0,
    });
    expect(report.overallCostRatePercent).not.toBe(0);
  });

  it('売上高が使えなくても使用高の合計は算出する', () => {
    const report = buildReport([amountRow('01.ソース', 1000)], {
      targetYm: '2026-08',
      totalSales: null,
    });
    expect(report.totalUsageAmount).toBe(1000);
  });
});

describe('導出値が未計算の行', () => {
  it('computeAllDerived を通していれば集計できる', () => {
    const rows = computeAllDerived([
      makeRow({ category: '01.ソース', unitPrice: 1194, purchaseQty: 76, openingQty: 5, closingQty: 7 }),
    ]);
    const report = buildReport(rows, { targetYm: '2026-08', totalSales: 5_000_000 });

    expect(report.categories[0]!.usageAmount).toBe(88356);
    expect(report.categories[0]!.closingAmount).toBe(8358);
  });
});
