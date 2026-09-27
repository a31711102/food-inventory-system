/**
 * 原価率の異常判定。
 *
 *   diff_pt = round(当月率, 2) − round(前月率, 2)
 *   異常 ⇔ |diff_pt| >= 閾値（既定 2.0pt）
 *
 * **ちょうど 2.0pt も異常とする。** 異常でないのは 2.0pt 未満のときだけである。
 *
 * 要件定義書の初版は「ちょうど2.0ptは超えたに当たらない（異常なし）」と定めていたが、
 * 2026-09-24 の確認で境界も異常に含める方針へ変更され、要件定義書 第2版に反映済み。
 *
 * 比較前に小数第2位へ丸めるのは、浮動小数の残差で境界を誤判定させないためである。
 *
 * 【重要】「約40%なら良好」という水準の目安は describeLevel が担当し、
 * 本判定には一切関与しない。要件§6「40%からの差による異常判定とは混同しない」を
 * モジュール分割で構造的に担保している。このファイルに 40 という定数は存在しない。
 */
import type { ReportValues } from './models';

export type AnomalyScope = 'OVERALL' | 'CATEGORY';
export type AnomalyMetric = 'COST_RATE_AFTER_LOSS' | 'COST_RATE';

export interface AnomalyRule {
  scope: AnomalyScope;
  metric: AnomalyMetric;
  thresholdPt: number;
}

export interface Anomaly {
  scope: AnomalyScope;
  metric: AnomalyMetric;
  /** scope が CATEGORY のときのみ設定される */
  category?: string;
  displayName: string;
  previousPercent: number;
  currentPercent: number;
  diffPt: number;
  thresholdPt: number;
  unit: 'pt';
}

export const DEFAULT_ANOMALY_RULES: readonly AnomalyRule[] = [
  { scope: 'OVERALL', metric: 'COST_RATE_AFTER_LOSS', thresholdPt: 2.0 },
  { scope: 'CATEGORY', metric: 'COST_RATE', thresholdPt: 2.0 },
] as const;

/** 率は小数第2位に丸めてから差を取る。境界条件を安定させるため。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function exceeds(diffPt: number, thresholdPt: number): boolean {
  // 閾値以上を異常とする。異常でないのは閾値未満のときだけ。
  return round2(Math.abs(diffPt)) >= thresholdPt;
}

export function detectAnomalies(
  current: ReportValues,
  previous: ReportValues | null,
  rules: readonly AnomalyRule[] = DEFAULT_ANOMALY_RULES,
): Anomaly[] {
  if (!previous) return [];

  const anomalies: Anomaly[] = [];

  for (const rule of rules) {
    if (rule.scope === 'OVERALL') {
      const cur = current.costRateAfterLossPercent;
      const prev = previous.costRateAfterLossPercent;
      if (cur === null || prev === null) continue;

      const diffPt = round2(cur) - round2(prev);
      if (exceeds(diffPt, rule.thresholdPt)) {
        anomalies.push({
          scope: 'OVERALL',
          metric: rule.metric,
          displayName: '全体（ロス引き後原価率）',
          previousPercent: prev,
          currentPercent: cur,
          diffPt,
          thresholdPt: rule.thresholdPt,
          unit: 'pt',
        });
      }
      continue;
    }

    const prevByCategory = new Map(previous.categories.map((c) => [c.category, c]));
    for (const cat of current.categories) {
      const prevCat = prevByCategory.get(cat.category);
      if (!prevCat) continue;
      if (cat.costRatePercent === null || prevCat.costRatePercent === null) continue;

      const diffPt = round2(cat.costRatePercent) - round2(prevCat.costRatePercent);
      if (exceeds(diffPt, rule.thresholdPt)) {
        anomalies.push({
          scope: 'CATEGORY',
          metric: rule.metric,
          category: cat.category,
          displayName: cat.displayName,
          previousPercent: prevCat.costRatePercent,
          currentPercent: cat.costRatePercent,
          diffPt,
          thresholdPt: rule.thresholdPt,
          unit: 'pt',
        });
      }
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// 水準の目安（異常判定とは無関係の、独立した表示用指標）
// ---------------------------------------------------------------------------

/** 「約40%なら良好」という運用上の目安。異常判定には使わない。 */
export const LEVEL_TARGET_PERCENT = 40;

/** 目安からの許容幅。異常判定の閾値とは別物であり、偶然同じ値でも意味が異なる。 */
export const LEVEL_TOLERANCE_PT = 2.0;

export interface LevelDescription {
  label: '目安どおり' | '目安から乖離' | '算出不可';
  targetPercent: number;
  deltaFromTargetPt: number | null;
}

export function describeLevel(costRatePercent: number | null): LevelDescription {
  if (costRatePercent === null) {
    return { label: '算出不可', targetPercent: LEVEL_TARGET_PERCENT, deltaFromTargetPt: null };
  }
  const delta = costRatePercent - LEVEL_TARGET_PERCENT;
  return {
    label: Math.abs(delta) <= LEVEL_TOLERANCE_PT ? '目安どおり' : '目安から乖離',
    targetPercent: LEVEL_TARGET_PERCENT,
    deltaFromTargetPt: delta,
  };
}
