import { describe, it, expect } from 'vitest';
import { diffProducts, diffReports } from '@/domain/diff';
import { buildReport } from '@/domain/report';
import { computeAllDerived } from '@/domain/calculation';
import { makeRow, makePrev, code } from '../helpers/factories';

describe('商品別比較', () => {
  it('両月に存在する商品は前月・当月・差額を出す', () => {
    const current = computeAllDerived([
      makeRow({ code: code('000158'), unitPrice: 1194, closingQty: 7, purchaseQty: 76, openingQty: 5 }),
    ]);
    const previous = [makePrev({ code: code('000158'), closingQty: 5, unitPrice: 1194 })];

    const rows = diffProducts(current, previous);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('CONTINUED');
    expect(rows[0]!.metrics.closingQty.previous).toBe(5);
    expect(rows[0]!.metrics.closingQty.current).toBe(7);
    expect(rows[0]!.metrics.closingQty.diff).toBe(2);
  });

  describe('新規・削除をゼロと同一視しない（要件§6）', () => {
    it('新規商品の前月値は null（0ではない）', () => {
      const current = computeAllDerived([makeRow({ code: code('009999'), status: 'NEW' })]);
      const rows = diffProducts(current, []);

      expect(rows[0]!.status).toBe('NEW');
      expect(rows[0]!.metrics.closingQty.previous).toBeNull();
      expect(rows[0]!.metrics.closingQty.previous).not.toBe(0);
    });

    it('新規商品の差額は算出しない', () => {
      const current = computeAllDerived([makeRow({ code: code('009999'), closingQty: 5 })]);
      expect(diffProducts(current, [])[0]!.metrics.closingQty.diff).toBeNull();
    });

    it('削除商品の当月値は null（0ではない）', () => {
      const previous = [makePrev({ code: code('000999'), closingQty: 3 })];
      const rows = diffProducts([], previous);

      expect(rows[0]!.status).toBe('DELETED');
      expect(rows[0]!.metrics.closingQty.current).toBeNull();
      expect(rows[0]!.metrics.closingQty.previous).toBe(3);
    });

    it('削除商品も比較結果に現れる', () => {
      const rows = diffProducts([], [makePrev({ code: code('000999') })]);
      expect(rows.map((r) => r.code)).toEqual(['000999']);
    });
  });

  describe('差率', () => {
    it('差率 = (当月 − 前月) ÷ |前月| × 100', () => {
      const current = computeAllDerived([makeRow({ code: code('000158'), closingQty: 15 })]);
      const previous = [makePrev({ code: code('000158'), closingQty: 10 })];

      expect(diffProducts(current, previous)[0]!.metrics.closingQty.diffRatePercent).toBe(50);
    });

    it('前月が0なら算出不可（null）', () => {
      const current = computeAllDerived([makeRow({ code: code('000158'), closingQty: 15 })]);
      const previous = [makePrev({ code: code('000158'), closingQty: 0 })];

      expect(diffProducts(current, previous)[0]!.metrics.closingQty.diffRatePercent).toBeNull();
    });

    it('前月が負なら絶対値を分母にする', () => {
      const current = computeAllDerived([makeRow({ code: code('000158'), closingQty: 0 })]);
      const previous = [makePrev({ code: code('000158'), closingQty: -10 })];

      expect(diffProducts(current, previous)[0]!.metrics.closingQty.diffRatePercent).toBe(100);
    });
  });

  describe('属性の比較', () => {
    it('商品名の前月・当月を並記する', () => {
      const current = computeAllDerived([makeRow({ code: code('000140'), name: '新名称' })]);
      const previous = [makePrev({ code: code('000140'), name: '旧名称' })];
      const row = diffProducts(current, previous)[0]!;

      expect(row.previousName).toBe('旧名称');
      expect(row.currentName).toBe('新名称');
      expect(row.nameChanged).toBe(true);
    });

    it('分類の変更を検知する', () => {
      const current = computeAllDerived([makeRow({ code: code('000140'), category: '02.主食材Ａ' })]);
      const previous = [makePrev({ code: code('000140'), category: '01.ソース' })];
      const row = diffProducts(current, previous)[0]!;

      expect(row.categoryChanged).toBe(true);
    });
  });

  it('比較対象は9項目（単価・期首・期中仕入・期末・期中使用量・当月使用高・期末在庫高ほか）', () => {
    const current = computeAllDerived([makeRow({ code: code('000140') })]);
    const keys = Object.keys(diffProducts(current, [])[0]!.metrics);

    expect(keys).toEqual([
      'unitPrice',
      'openingQty',
      'purchaseQty',
      'closingQty',
      'usageQty',
      'usageAmount',
      'closingAmount',
    ]);
  });

  it('商品コード順に並べる', () => {
    const current = computeAllDerived([
      makeRow({ code: code('000158') }),
      makeRow({ code: code('000108') }),
    ]);
    expect(diffProducts(current, []).map((r) => r.code)).toEqual(['000108', '000158']);
  });
});

describe('レポート比較', () => {
  function report(sales: number, usage: number, ym: string) {
    const rows = computeAllDerived([
      makeRow({ category: '01.ソース', unitPrice: 1, purchaseQty: usage, closingQty: 0, openingQty: 0 }),
    ]);
    return buildReport(rows, { targetYm: ym, totalSales: sales });
  }

  it('金額の差は円単位で表す', () => {
    const rows = diffReports(report(1000000, 400000, '2026-08'), report(1000000, 350000, '2026-07'));
    const usage = rows.find((r) => r.metric === 'USAGE_AMOUNT' && r.scope === 'OVERALL');

    expect(usage?.diff).toBe(50000);
    expect(usage?.unit).toBe('円');
  });

  it('率の差はパーセントポイントで表す', () => {
    const rows = diffReports(report(1000000, 420000, '2026-08'), report(1000000, 400000, '2026-07'));
    const rate = rows.find((r) => r.metric === 'COST_RATE_AFTER_LOSS');

    expect(rate?.diff).toBeCloseTo(2.0, 10);
    expect(rate?.unit).toBe('pt');
  });

  it('カテゴリ別の行も含む', () => {
    const rows = diffReports(report(1000000, 400000, '2026-08'), report(1000000, 350000, '2026-07'));
    expect(rows.some((r) => r.scope === 'CATEGORY' && r.category === '01.ソース')).toBe(true);
  });

  it('合計対象外カテゴリであることを示す', () => {
    const rows = diffReports(report(1000000, 400000, '2026-08'), report(1000000, 350000, '2026-07'));
    const shoes = rows.find((r) => r.category === '16.靴他' && r.metric === 'USAGE_AMOUNT');

    expect(shoes?.includedInTotal).toBe(false);
  });

  describe('前月データがない場合', () => {
    it('当月値のみを表示し差分は null にする', () => {
      const rows = diffReports(report(1000000, 400000, '2026-08'), null);
      const usage = rows.find((r) => r.metric === 'USAGE_AMOUNT' && r.scope === 'OVERALL');

      expect(usage?.current).toBe(400000);
      expect(usage?.previous).toBeNull();
      expect(usage?.diff).toBeNull();
    });

    it('比較不可である旨を持つ', () => {
      const rows = diffReports(report(1000000, 400000, '2026-08'), null);
      expect(rows.every((r) => r.comparable === false)).toBe(true);
    });
  });

  it('異常判定の結果を各行に反映できる', () => {
    const current = report(1000000, 450000, '2026-08');
    const previous = report(1000000, 400000, '2026-07');
    const rows = diffReports(current, previous);
    const rate = rows.find((r) => r.metric === 'COST_RATE_AFTER_LOSS' && r.scope === 'OVERALL');

    expect(rate?.isAnomaly).toBe(true);
  });

  it('閾値未満なら異常としない（1.9pt）', () => {
    const rows = diffReports(report(1000000, 419000, '2026-08'), report(1000000, 400000, '2026-07'));
    const rate = rows.find((r) => r.metric === 'COST_RATE_AFTER_LOSS' && r.scope === 'OVERALL');

    expect(rate?.diff).toBeCloseTo(1.9, 10);
    expect(rate?.isAnomaly).toBe(false);
  });

  it('ちょうど閾値なら異常とする（2.0pt）', () => {
    const rows = diffReports(report(1000000, 420000, '2026-08'), report(1000000, 400000, '2026-07'));
    const rate = rows.find((r) => r.metric === 'COST_RATE_AFTER_LOSS' && r.scope === 'OVERALL');

    expect(rate?.diff).toBeCloseTo(2.0, 10);
    expect(rate?.isAnomaly).toBe(true);
  });
});
