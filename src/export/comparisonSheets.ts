/**
 * 前月比較シートの組み立て。
 *
 * 既存シートには一切触れず、新規シートとして末尾に追加する（設計書§10.4）。
 * 商品コードは文字列として書き出し、先頭ゼロが表示上も失われないようにする。
 */
import type { ProductDiffRow, ReportDiffRow } from '../domain/diff';
import { PRODUCT_DIFF_METRICS, type ProductDiffMetric } from '../domain/diff';
import type { Anomaly } from '../domain/anomaly';

export type SheetRow = (string | number | null)[];

export const PRODUCT_SHEET_NAME = '前月比較_商品別';
export const REPORT_SHEET_NAME = '前月比較_レポート';

const METRIC_LABELS: Record<ProductDiffMetric, string> = {
  unitPrice: '単価',
  openingQty: '期首在庫',
  purchaseQty: '期中仕入',
  closingQty: '期末在庫',
  usageQty: '期中使用量',
  usageAmount: '当月使用高',
  closingAmount: '期末在庫高',
};

const STATUS_LABELS = { CONTINUED: '継続', NEW: '新規', DELETED: '削除' } as const;

/** 新規・削除で値が無い箇所は 0 ではなく空欄にする（要件§6）。 */
function cell(value: number | null): number | null {
  return value === null ? null : value;
}

export function buildProductComparisonSheet(diffs: readonly ProductDiffRow[]): SheetRow[] {
  const header1: SheetRow = ['状態', '商品コード', '商品名(前月)', '商品名(当月)', '分類(前月)', '分類(当月)', '属性変更'];
  for (const metric of PRODUCT_DIFF_METRICS) {
    header1.push(`${METRIC_LABELS[metric]}(前月)`, `${METRIC_LABELS[metric]}(当月)`, `${METRIC_LABELS[metric]}差`, `${METRIC_LABELS[metric]}差率%`);
  }

  const rows: SheetRow[] = [header1];

  for (const d of diffs) {
    const changes: string[] = [];
    if (d.nameChanged) changes.push('商品名');
    if (d.categoryChanged) changes.push('分類');

    const row: SheetRow = [
      STATUS_LABELS[d.status],
      d.code, // 文字列として書かれる（先頭ゼロ保持）
      d.previousName,
      d.currentName,
      d.previousCategory,
      d.currentCategory,
      changes.length ? changes.join('・') : null,
    ];

    for (const metric of PRODUCT_DIFF_METRICS) {
      const v = d.metrics[metric];
      row.push(cell(v.previous), cell(v.current), cell(v.diff), cell(v.diffRatePercent));
    }
    rows.push(row);
  }

  return rows;
}

export function buildReportComparisonSheet(
  diffs: readonly ReportDiffRow[],
  anomalies: readonly Anomaly[],
  options: { targetYm: string; previousYm: string | null },
): SheetRow[] {
  const rows: SheetRow[] = [];

  rows.push(['前月比較（管理レポート）']);
  rows.push([
    '対象年月',
    options.targetYm,
    '比較対象',
    options.previousYm ?? '前月データなし（比較不可）',
  ]);
  rows.push([]);
  rows.push(['区分', '指標', '前月', '当月', '差', '単位', '合計対象', '判定']);

  for (const d of diffs) {
    rows.push([
      d.scope === 'OVERALL' ? '全体' : d.displayName,
      d.metricLabel,
      d.comparable ? cell(d.previous) : null,
      cell(d.current),
      d.comparable ? cell(d.diff) : null,
      d.unit,
      d.includedInTotal ? '○' : '×（合計から除外）',
      d.isAnomaly ? '▲異常' : d.comparable ? '' : '比較不可',
    ]);
  }

  if (anomalies.length > 0) {
    rows.push([]);
    rows.push(['■ 異常一覧（前月比の差が閾値を超えた項目）']);
    rows.push(['区分', '指標', '前月%', '当月%', '差(pt)', '閾値(pt)']);
    for (const a of anomalies) {
      rows.push([
        a.scope === 'OVERALL' ? '全体' : a.displayName,
        a.metric === 'COST_RATE_AFTER_LOSS' ? 'ロス引き後原価率' : '原価率',
        a.previousPercent,
        a.currentPercent,
        a.diffPt,
        a.thresholdPt,
      ]);
    }
  }

  rows.push([]);
  rows.push([
    '※ 「ガチャ玉」「靴他」は現行帳票の合計（分析用!C22 = SUM(C5:C19)）に含まれないため、合計対象を×と表示しています。',
  ]);
  rows.push([
    '※ 率の差はパーセントポイント(pt)、金額の差は円で表記しています。',
  ]);

  return rows;
}
