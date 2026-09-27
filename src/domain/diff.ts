/**
 * 前月比較。
 *
 * 要件§6「新規・削除はゼロと同一視せず状態として表示する」を守るため、
 * 片方の月にしか存在しない項目の値は 0 ではなく null にする。
 * 差率の分母がゼロなら「算出不可」（null）とする。
 */
import type { ProductRow, PreviousMonthEntry, ReportValues, ProductStatus } from './models';
import type { ProductCode } from './productCode';
import { detectAnomalies, DEFAULT_ANOMALY_RULES, type AnomalyRule } from './anomaly';

export interface DiffValue {
  previous: number | null;
  current: number | null;
  /** 片方が null なら null（0扱いしない） */
  diff: number | null;
  /** 分母が0または比較不可なら null（＝算出不可） */
  diffRatePercent: number | null;
}

export const PRODUCT_DIFF_METRICS = [
  'unitPrice',
  'openingQty',
  'purchaseQty',
  'closingQty',
  'usageQty',
  'usageAmount',
  'closingAmount',
] as const;

export type ProductDiffMetric = (typeof PRODUCT_DIFF_METRICS)[number];

export interface ProductDiffRow {
  code: ProductCode;
  status: ProductStatus;
  previousName: string | null;
  currentName: string | null;
  previousCategory: string | null;
  currentCategory: string | null;
  nameChanged: boolean;
  categoryChanged: boolean;
  metrics: Record<ProductDiffMetric, DiffValue>;
}

function makeDiffValue(previous: number | null, current: number | null): DiffValue {
  if (previous === null || current === null) {
    return { previous, current, diff: null, diffRatePercent: null };
  }
  const diff = current - previous;
  return {
    previous,
    current,
    diff,
    diffRatePercent: previous === 0 ? null : (diff / Math.abs(previous)) * 100,
  };
}

function currentMetric(row: ProductRow, metric: ProductDiffMetric): number | null {
  switch (metric) {
    case 'unitPrice':
      return row.unitPrice;
    case 'openingQty':
      return row.openingQty;
    case 'purchaseQty':
      return row.purchaseQty;
    case 'closingQty':
      return row.closingQty;
    case 'usageQty':
      return row.usageQty;
    case 'usageAmount':
      return row.usageAmount;
    case 'closingAmount':
      return row.closingAmount;
  }
}

function previousMetric(entry: PreviousMonthEntry, metric: ProductDiffMetric): number | null {
  switch (metric) {
    case 'unitPrice':
      return entry.unitPrice;
    case 'openingQty':
      return entry.openingQty;
    case 'purchaseQty':
      return entry.purchaseQty;
    case 'closingQty':
      return entry.closingQty;
    case 'usageQty':
      return entry.usageQty;
    case 'usageAmount':
      return entry.usageAmount;
    case 'closingAmount':
      return entry.closingAmount;
  }
}

function emptyMetrics(
  build: (metric: ProductDiffMetric) => DiffValue,
): Record<ProductDiffMetric, DiffValue> {
  const out = {} as Record<ProductDiffMetric, DiffValue>;
  for (const m of PRODUCT_DIFF_METRICS) out[m] = build(m);
  return out;
}

export function diffProducts(
  current: readonly ProductRow[],
  previous: readonly PreviousMonthEntry[],
): ProductDiffRow[] {
  const prevByCode = new Map(previous.map((p) => [p.code as string, p]));
  const rows: ProductDiffRow[] = [];

  for (const row of current) {
    const prev = prevByCode.get(row.code);
    rows.push({
      code: row.code,
      status: prev ? 'CONTINUED' : 'NEW',
      previousName: prev?.name ?? null,
      currentName: row.name,
      previousCategory: prev?.category ?? null,
      currentCategory: row.category,
      nameChanged: prev ? prev.name !== row.name : false,
      categoryChanged: prev ? prev.category !== row.category : false,
      metrics: emptyMetrics((m) =>
        makeDiffValue(prev ? previousMetric(prev, m) : null, currentMetric(row, m)),
      ),
    });
  }

  const currentCodes = new Set(current.map((r) => r.code as string));
  for (const prev of previous) {
    if (currentCodes.has(prev.code)) continue;
    rows.push({
      code: prev.code,
      status: 'DELETED',
      previousName: prev.name,
      currentName: null,
      previousCategory: prev.category,
      currentCategory: null,
      nameChanged: false,
      categoryChanged: false,
      metrics: emptyMetrics((m) => makeDiffValue(previousMetric(prev, m), null)),
    });
  }

  return rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

// ---------------------------------------------------------------------------
// レポート比較
// ---------------------------------------------------------------------------

export type ReportDiffMetric =
  | 'SALES'
  | 'USAGE_AMOUNT'
  | 'CLOSING_AMOUNT'
  | 'COST_RATE'
  | 'COST_AFTER_LOSS'
  | 'COST_RATE_AFTER_LOSS'
  | 'SALAD_VEGETABLE_USAGE';

export interface ReportDiffRow {
  scope: 'OVERALL' | 'CATEGORY';
  category?: string;
  displayName: string;
  metric: ReportDiffMetric;
  metricLabel: string;
  previous: number | null;
  current: number | null;
  diff: number | null;
  /** 金額は円、率はパーセントポイント */
  unit: '円' | 'pt';
  /** 前月データの有無 */
  comparable: boolean;
  /** 合計（C22/F22）に算入されるカテゴリか */
  includedInTotal: boolean;
  isAnomaly: boolean;
}

const METRIC_LABELS: Record<ReportDiffMetric, string> = {
  SALES: '当月売上高',
  USAGE_AMOUNT: '当月使用高',
  CLOSING_AMOUNT: '期末在庫高',
  COST_RATE: '原価率',
  COST_AFTER_LOSS: 'ロス引き後原価',
  COST_RATE_AFTER_LOSS: 'ロス引き後原価率',
  SALAD_VEGETABLE_USAGE: 'サラダ野菜使用高',
};

function diffOf(previous: number | null, current: number | null): number | null {
  return previous === null || current === null ? null : current - previous;
}

export function diffReports(
  current: ReportValues,
  previous: ReportValues | null,
  rules: readonly AnomalyRule[] = DEFAULT_ANOMALY_RULES,
): ReportDiffRow[] {
  const comparable = previous !== null;
  const anomalies = detectAnomalies(current, previous, rules);
  const overallAnomaly = anomalies.some((a) => a.scope === 'OVERALL');
  const anomalousCategories = new Set(
    anomalies.filter((a) => a.scope === 'CATEGORY').map((a) => a.category),
  );

  const rows: ReportDiffRow[] = [];

  const pushOverall = (
    metric: ReportDiffMetric,
    prev: number | null,
    cur: number | null,
    unit: '円' | 'pt',
    isAnomaly = false,
  ): void => {
    rows.push({
      scope: 'OVERALL',
      displayName: '全体',
      metric,
      metricLabel: METRIC_LABELS[metric],
      previous: comparable ? prev : null,
      current: cur,
      diff: comparable ? diffOf(prev, cur) : null,
      unit,
      comparable,
      includedInTotal: true,
      isAnomaly,
    });
  };

  pushOverall('SALES', previous?.totalSales ?? null, current.totalSales, '円');
  pushOverall('USAGE_AMOUNT', previous?.totalUsageAmount ?? null, current.totalUsageAmount, '円');
  pushOverall(
    'CLOSING_AMOUNT',
    previous?.totalClosingAmount ?? null,
    current.totalClosingAmount,
    '円',
  );
  pushOverall(
    'COST_RATE',
    previous?.overallCostRatePercent ?? null,
    current.overallCostRatePercent,
    'pt',
  );
  pushOverall('COST_AFTER_LOSS', previous?.costAfterLoss ?? null, current.costAfterLoss, '円');
  pushOverall(
    'COST_RATE_AFTER_LOSS',
    previous?.costRateAfterLossPercent ?? null,
    current.costRateAfterLossPercent,
    'pt',
    overallAnomaly,
  );
  pushOverall(
    'SALAD_VEGETABLE_USAGE',
    previous?.saladVegetableUsage ?? null,
    current.saladVegetableUsage,
    '円',
  );

  const prevByCategory = new Map((previous?.categories ?? []).map((c) => [c.category, c]));
  for (const cat of current.categories) {
    const prev = prevByCategory.get(cat.category);
    const isAnomaly = anomalousCategories.has(cat.category);

    const push = (
      metric: ReportDiffMetric,
      p: number | null,
      c: number | null,
      unit: '円' | 'pt',
      flag = false,
    ): void => {
      rows.push({
        scope: 'CATEGORY',
        category: cat.category,
        displayName: cat.displayName,
        metric,
        metricLabel: METRIC_LABELS[metric],
        previous: comparable ? p : null,
        current: c,
        diff: comparable ? diffOf(p, c) : null,
        unit,
        comparable,
        includedInTotal: cat.includedInTotal,
        isAnomaly: flag,
      });
    };

    push('USAGE_AMOUNT', prev?.usageAmount ?? null, cat.usageAmount, '円');
    push('CLOSING_AMOUNT', prev?.closingAmount ?? null, cat.closingAmount, '円');
    push('COST_RATE', prev?.costRatePercent ?? null, cat.costRatePercent, 'pt', isAnomaly);
  }

  return rows;
}
