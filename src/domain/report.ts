/**
 * 管理レポート（分析用シート）の集計。
 *
 *   カテゴリ別当月使用高 = SUMIF(分類, 当月使用高)        入力用 U列
 *   カテゴリ別期末在庫高 = SUMIF(分類, 期末在庫高)        入力用 V列
 *   カテゴリ別原価率     = 使用高 ÷ 当月売上高            分析用 E列（比率）
 *   使用高合計   C22     = SUM(C5:C19)  ガチャ玉・靴他を除外
 *   食材期末在庫計 F22   = SUM(F5:F19)  同上
 *   全体原価率   E22     = C22 ÷ C4
 *   ロス引き後原価 K9    = C22 − K7
 *   ロス引き後原価率 L11 = K9 ÷ C4 × 100
 *   サラダ野菜使用高 L14 = C13（野菜カテゴリの当月使用高）
 *
 * 分析用 E列は比率、L11 は百分率と単位が混在しているため、
 * モデル内では率をすべて百分率に統一して保持する。
 */
import type { ProductRow, ReportValues, CategoryResult } from './models';
import { CATEGORIES, categoryByCode, displayOrder, SALAD_VEGETABLE_CATEGORY } from './categories';

export interface BuildReportOptions {
  targetYm: string;
  /** 分析用 C4。未入力は null。 */
  totalSales: number | null;
  /** 分析用 K7。実運用では空欄のため既定 0。 */
  lossAmount?: number;
}

interface SalesUsability {
  usable: boolean;
  reason: string | null;
}

function checkSales(totalSales: number | null): SalesUsability {
  if (totalSales === null || totalSales === undefined || Number.isNaN(totalSales)) {
    return { usable: false, reason: '売上高が未入力のため原価率を算出できません' };
  }
  if (totalSales === 0) {
    return { usable: false, reason: '売上高が0のため原価率を算出できません' };
  }
  if (totalSales < 0) {
    return { usable: false, reason: '売上高が負値のため原価率を算出できません' };
  }
  return { usable: true, reason: null };
}

export function buildReport(
  rows: readonly ProductRow[],
  options: BuildReportOptions,
): ReportValues {
  const { targetYm, totalSales, lossAmount = 0 } = options;
  const sales = checkSales(totalSales);
  const unavailableReasons: Record<string, string> = {};

  // --- カテゴリ別集計 ---
  const usageByCategory = new Map<string, number>();
  const closingByCategory = new Map<string, number>();
  for (const c of CATEGORIES) {
    usageByCategory.set(c.code, 0);
    closingByCategory.set(c.code, 0);
  }

  // 備品（5桁コード）も集計には含める。
  // 「備品はこの棚卸表で計算しない」（要件§10-2）は**期中仕入を自動で入れない**ことで満たす。
  // 集計から落とすと、出力Excelの SUMIF は備品を含めて計算するため、
  // 画面の数字と完成Excelの数字が食い違う（2026年8月は16.靴他で実際に差が出る）。
  for (const row of rows) {
    const def = categoryByCode(row.category);
    if (!def) {
      // 未知の分類。Excel の SUMIF も拾わないため合計に含めないが、黙って捨てず警告する。
      unavailableReasons[row.category] =
        `分類「${row.category}」は既知の17分類に含まれないため、カテゴリ集計と合計から除外しました。分類マスタの更新が必要です。`;
      continue;
    }
    usageByCategory.set(def.code, (usageByCategory.get(def.code) ?? 0) + (row.usageAmount ?? 0));
    closingByCategory.set(def.code, (closingByCategory.get(def.code) ?? 0) + (row.closingAmount ?? 0));
  }

  const categories: CategoryResult[] = displayOrder().map((def): CategoryResult => {
    const usageAmount = usageByCategory.get(def.code) ?? 0;
    const closingAmount = closingByCategory.get(def.code) ?? 0;
    return {
      category: def.code,
      displayName: def.displayName,
      analysisRow: def.analysisRow,
      includedInTotal: def.includedInTotal,
      usageAmount,
      closingAmount,
      costRatePercent: sales.usable ? (usageAmount / (totalSales as number)) * 100 : null,
      unavailableReason: sales.reason,
    };
  });

  // --- 合計（ガチャ玉・靴他を除外） ---
  const totalUsageAmount = categories
    .filter((c) => c.includedInTotal)
    .reduce((sum, c) => sum + c.usageAmount, 0);
  const totalClosingAmount = categories
    .filter((c) => c.includedInTotal)
    .reduce((sum, c) => sum + c.closingAmount, 0);

  const costAfterLoss = totalUsageAmount - lossAmount;

  if (!sales.usable && sales.reason) {
    unavailableReasons['COST_RATE'] = sales.reason;
    unavailableReasons['COST_RATE_AFTER_LOSS'] = sales.reason;
  }

  const saladSource = categories.find((c) => c.category === SALAD_VEGETABLE_CATEGORY);

  return {
    targetYm,
    totalSales: totalSales ?? null,
    categories,
    totalUsageAmount,
    totalClosingAmount,
    overallCostRatePercent: sales.usable ? (totalUsageAmount / (totalSales as number)) * 100 : null,
    lossAmount,
    costAfterLoss,
    costRateAfterLossPercent: sales.usable ? (costAfterLoss / (totalSales as number)) * 100 : null,
    saladVegetableUsage: saladSource ? saladSource.usageAmount : null,
    unavailableReasons,
  };
}
