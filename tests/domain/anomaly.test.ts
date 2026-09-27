import { describe, it, expect } from 'vitest';
import { detectAnomalies, DEFAULT_ANOMALY_RULES, describeLevel, LEVEL_TARGET_PERCENT } from '@/domain/anomaly';
import { buildReport } from '@/domain/report';
import { makeRow, code } from '../helpers/factories';

/** 指定のロス引き後原価率になるレポートを作る */
function reportWithRate(ratePercent: number, categoryRates: Record<string, number> = {}) {
  const sales = 1_000_000;
  const rows = [
    makeRow({
      code: code('000001'),
      category: '01.ソース',
      unitPrice: 1,
      usageQty: (sales * ratePercent) / 100,
      usageAmount: (sales * ratePercent) / 100,
      closingAmount: 0,
    }),
    ...Object.entries(categoryRates).map(([cat, r], i) =>
      makeRow({
        code: code('00000' + (i + 2)),
        category: cat,
        unitPrice: 1,
        usageQty: (sales * r) / 100,
        usageAmount: (sales * r) / 100,
        closingAmount: 0,
      }),
    ),
  ];
  return buildReport(rows, { targetYm: '2026-08', totalSales: sales });
}

describe('異常判定の境界（受入条件6）', () => {
  // 要件定義書 第2版（2026-09-24）§6・受入条件6:
  // 「2.0pt 以上を異常とする。異常としないのは 2.0pt 未満のときだけ」
  it.each([
    ['+2.1pt', 42.1, true],
    ['-2.1pt', 37.9, true],
    ['+2.0pt', 42.0, true],
    ['-2.0pt', 38.0, true],
    ['+0.0pt', 40.0, false],
    ['+2.01pt', 42.01, true],
    ['+1.99pt', 41.99, false],
    ['-1.99pt', 38.01, false],
  ])('前月40.0%に対し当月 %s は 異常=%s', (_label, currentRate, expected) => {
    const current = reportWithRate(currentRate);
    const previous = reportWithRate(40.0);

    const anomalies = detectAnomalies(current, previous);
    const overall = anomalies.find((a) => a.scope === 'OVERALL');

    expect(Boolean(overall)).toBe(expected);
  });

  it('ちょうど2.0ptも異常とする', () => {
    const anomalies = detectAnomalies(reportWithRate(42.0), reportWithRate(40.0));
    expect(anomalies.filter((a) => a.scope === 'OVERALL')).toHaveLength(1);
  });

  it('異常でないのは閾値未満のときだけ', () => {
    const anomalies = detectAnomalies(reportWithRate(41.99), reportWithRate(40.0));
    expect(anomalies.filter((a) => a.scope === 'OVERALL')).toHaveLength(0);
  });

  it('差は pt 単位で保持する', () => {
    const anomalies = detectAnomalies(reportWithRate(42.1), reportWithRate(40.0));
    expect(anomalies[0]!.diffPt).toBeCloseTo(2.1, 10);
    expect(anomalies[0]!.unit).toBe('pt');
  });

  describe('浮動小数の残差で境界がぶれない（小数第2位に丸めてから比較）', () => {
    it('計算上ちょうど2.0ptになる値は、残差があっても異常と判定する', () => {
      // 40 + 0.1 + 0.2 + 1.7 は 42.000000000000004 になる
      const current = reportWithRate(40 + 0.1 + 0.2 + 1.7);
      const anomalies = detectAnomalies(current, reportWithRate(40.0));
      expect(anomalies.filter((a) => a.scope === 'OVERALL')).toHaveLength(1);
    });

    it('計算上1.99ptの値は、残差があっても異常にしない', () => {
      // 40 + 0.1 + 0.2 + 1.69 は 41.989999999999995 になる
      const current = reportWithRate(40 + 0.1 + 0.2 + 1.69);
      const anomalies = detectAnomalies(current, reportWithRate(40.0));
      expect(anomalies.filter((a) => a.scope === 'OVERALL')).toHaveLength(0);
    });
  });
});

describe('判定の粒度（全体＋カテゴリ別）', () => {
  it('全体のロス引き後原価率を判定する', () => {
    const anomalies = detectAnomalies(reportWithRate(45), reportWithRate(40));
    expect(anomalies.some((a) => a.scope === 'OVERALL' && a.metric === 'COST_RATE_AFTER_LOSS')).toBe(true);
  });

  it('カテゴリ別原価率も判定する', () => {
    const current = reportWithRate(40, { '04.米': 10 });
    const previous = reportWithRate(40, { '04.米': 5 });

    const anomalies = detectAnomalies(current, previous);

    expect(anomalies.some((a) => a.scope === 'CATEGORY' && a.category === '04.米')).toBe(true);
  });

  it('合計対象外カテゴリ（靴他）も原価率は判定する', () => {
    const current = reportWithRate(40, { '16.靴他': 8 });
    const previous = reportWithRate(40, { '16.靴他': 1 });

    const anomalies = detectAnomalies(current, previous);

    expect(anomalies.some((a) => a.category === '16.靴他')).toBe(true);
  });

  it('閾値は粒度ごとに設定できる', () => {
    const current = reportWithRate(40, { '04.米': 8 });
    const previous = reportWithRate(40, { '04.米': 5 });

    const strict = detectAnomalies(current, previous, [
      { scope: 'CATEGORY', metric: 'COST_RATE', thresholdPt: 2.0 },
    ]);
    const loose = detectAnomalies(current, previous, [
      { scope: 'CATEGORY', metric: 'COST_RATE', thresholdPt: 5.0 },
    ]);

    expect(strict).toHaveLength(1);
    expect(loose).toHaveLength(0);
  });

  it('既定ルールは全体・カテゴリ別ともに2.0pt', () => {
    expect(DEFAULT_ANOMALY_RULES.every((r) => r.thresholdPt === 2.0)).toBe(true);
    expect(DEFAULT_ANOMALY_RULES.map((r) => r.scope).sort()).toEqual(['CATEGORY', 'OVERALL']);
  });
});

describe('前月データがない場合', () => {
  it('判定を行わない', () => {
    expect(detectAnomalies(reportWithRate(50), null)).toHaveLength(0);
  });

  it('前月の率が算出不可なら判定しない', () => {
    const previous = buildReport([], { targetYm: '2026-07', totalSales: 0 });
    expect(detectAnomalies(reportWithRate(50), previous)).toHaveLength(0);
  });

  it('当月の率が算出不可なら判定しない', () => {
    const current = buildReport([], { targetYm: '2026-08', totalSales: null });
    expect(detectAnomalies(current, reportWithRate(40))).toHaveLength(0);
  });
});

describe('水準の目安は異常判定と分離する（要件§6）', () => {
  it('目安の基準は40%', () => {
    expect(LEVEL_TARGET_PERCENT).toBe(40);
  });

  it('40%近辺なら良好と表示する', () => {
    expect(describeLevel(40.3).label).toBe('目安どおり');
  });

  it('40%から離れていても異常判定には使わない', () => {
    // 前月比0ptでも水準は乖離、という状態を作る
    const current = reportWithRate(55);
    const previous = reportWithRate(55);

    expect(detectAnomalies(current, previous)).toHaveLength(0);
    expect(describeLevel(55).label).toBe('目安から乖離');
  });

  it('describeLevel は目安からの差を返す', () => {
    expect(describeLevel(43).deltaFromTargetPt).toBeCloseTo(3, 10);
  });

  it('率が算出不可なら目安も判定しない', () => {
    expect(describeLevel(null).label).toBe('算出不可');
  });
});

describe('異常の内容', () => {
  it('前月値・当月値・差・閾値を持つ', () => {
    const a = detectAnomalies(reportWithRate(43.5), reportWithRate(40.0))[0]!;

    expect(a.previousPercent).toBeCloseTo(40.0, 10);
    expect(a.currentPercent).toBeCloseTo(43.5, 10);
    expect(a.diffPt).toBeCloseTo(3.5, 10);
    expect(a.thresholdPt).toBe(2.0);
  });

  it('Release 1 では原因推定を持たない', () => {
    const a = detectAnomalies(reportWithRate(43.5), reportWithRate(40.0))[0]!;
    expect(a).not.toHaveProperty('probableCause');
  });
});
