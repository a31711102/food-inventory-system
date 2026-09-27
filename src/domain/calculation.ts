/**
 * 明細1行の導出値。実帳票の数式をそのまま移植する。
 *
 *   J列 期中使用量 = SUM(H:I) - G = 期中仕入 + 期首在庫 − 期末在庫
 *   L列 当月使用高 = K * J        = 単価 × 期中使用量
 *   M列 期末在庫高 = G * K        = 期末在庫 × 単価
 *
 * 金額は数量から導出する。元帳票に期首在庫金額・期中仕入金額の列は存在しない。
 * 計算過程では丸めない（実帳票が丸めていないため）。丸めは表示時のみ行う。
 */
import type { ProductRow } from './models';

export interface UsageQtyInput {
  closingQty: number;
  purchaseQty: number;
  openingQty: number;
}

export function computeUsageQty({ closingQty, purchaseQty, openingQty }: UsageQtyInput): number {
  return purchaseQty + openingQty - closingQty;
}

export function computeUsageAmount(unitPrice: number, usageQty: number): number {
  return unitPrice * usageQty;
}

export function computeClosingAmount(closingQty: number, unitPrice: number): number {
  return closingQty * unitPrice;
}

/** 明細1行の導出値をまとめて算出する。入力は破壊しない。 */
export function computeDerived(row: ProductRow): ProductRow {
  const usageQty = computeUsageQty(row);
  return {
    ...row,
    usageQty,
    usageAmount: computeUsageAmount(row.unitPrice, usageQty),
    closingAmount: computeClosingAmount(row.closingQty, row.unitPrice),
  };
}

export function computeAllDerived(rows: readonly ProductRow[]): ProductRow[] {
  return rows.map(computeDerived);
}
