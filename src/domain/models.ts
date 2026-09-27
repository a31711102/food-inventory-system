/**
 * ドメインモデル。
 *
 * 数値はすべて JavaScript の number（IEEE754 倍精度）で保持する。
 * Excel 自身が倍精度で計算しているため、同じ演算順序をたどれば結果は一致する。
 * 十進固定小数（Decimal）を使うとむしろ Excel と乖離するため採用しない。
 */
import type { ProductCode } from './productCode';
import type { ValidationIssue } from './issues';

export type ProductStatus = 'CONTINUED' | 'NEW' | 'DELETED';

/** 入力用シートの明細1行。列記号は実帳票に対応する。 */
export interface ProductRow {
  /** Excel 上の実行番号（3〜268）。元ファイルの行を指し示すために保持する。 */
  lineNo: number;
  /** D列 商品コード */
  code: ProductCode;
  /** E列 商品名 */
  name: string;
  /** F列 棚卸単位 */
  inventoryUnit: string | null;
  /** N列 分類 */
  category: string;
  /** K列 単価 */
  unitPrice: number;
  /** P列 仕入れ単位（＝発注単位から棚卸単位への換算係数） */
  conversionFactor: number;
  /** G列 期末在庫 */
  closingQty: number;
  /** H列 期中仕入 */
  purchaseQty: number;
  /** I列 期首在庫 */
  openingQty: number;

  status: ProductStatus;
  isOwnPurchase: boolean;
  /** 備品（食材以外）。コードの数値部が5桁。棚卸の計算対象外（要件§10-2） */
  isSupply: boolean;
  /** 新規商品の期首0を管理者が承認したか。未承認のまま出力できない（W004）。 */
  openingApproved: boolean;

  // --- 導出値（calculation.ts が設定する） ---
  /** J列 期中使用量 = H + I − G */
  usageQty: number | null;
  /** L列 当月使用高 = K × J */
  usageAmount: number | null;
  /** M列 期末在庫高 = G × K */
  closingAmount: number | null;
}

/** 前月食品棚卸表から引き継ぐ値。 */
export interface PreviousMonthEntry {
  code: ProductCode;
  name: string;
  category: string;
  unitPrice: number;
  closingQty: number;
  purchaseQty: number;
  openingQty: number;
  usageQty: number | null;
  usageAmount: number | null;
  closingAmount: number | null;
  lineNo: number;
}

/** 発注累計照会の1行。 */
export interface OrderLine {
  code: ProductCode;
  /** 換算前の発注数 */
  orderQty: number;
  /** 適用した換算係数。監査のため行ごとに残す。 */
  conversionFactor: number | null;
  /** 換算後数量 = orderQty × conversionFactor。換算不能なら null。 */
  convertedQty: number | null;
  factorSource: 'CONFIRMED' | 'UNIT_MASTER' | 'MASTER_P' | null;
  isReturn: boolean;
  lineNo: number;
}

/** 単位計算マスタの1行。 */
export interface UnitConversionEntry {
  code: ProductCode;
  name: string;
  /** 発注数（実データは全件1） */
  orderUnit: number;
  /** 単位表記（袋・箱・本など） */
  unitLabel: string;
  /** 計算単位＝換算係数 */
  factor: number;
  lineNo: number;
}

/**
 * 自店購入の候補。
 *
 * 当月マスタの棚卸対象行すべて（備品を除く）が候補になる。
 * 登録済みの自店購入品だけに絞っていた時期があったが、発注累計にも
 * 登録リストにも無い品を店舗が実際に購入しており、入力手段が無かった
 * （2026年7月の炭酸水・ガムシロップなど）。
 */
export interface OwnPurchaseCandidate {
  code: ProductCode;
  name: string;
  category: string;
  /** 自店購入品として登録済みか。未登録でも入力はできるが、理由の記録を求める */
  registered: boolean;
  lastUsedYm: string | null;
  lastUnitPrice: number | null;
}

/** 自店購入の画面入力。 */
export interface OwnPurchaseInput {
  code: ProductCode;
  purchaseQty: number;
  closingQty: number;
  unitPrice: number;
  note: string | null;
}

/** カテゴリ単位の集計結果。入力用 U/V 列と分析用 C/E/F 列に対応する。 */
export interface CategoryResult {
  category: string;
  displayName: string;
  analysisRow: number;
  includedInTotal: boolean;
  /** 入力用 U列 = SUMIF(N:N, 分類, L:L) */
  usageAmount: number;
  /** 入力用 V列 = SUMIF(N:N, 分類, M:M) */
  closingAmount: number;
  /** 分析用 E列 = C/C4。モデル内では百分率に統一して保持する。 */
  costRatePercent: number | null;
  unavailableReason: string | null;
}

/** 管理レポート（分析用シート）の値。率はすべて百分率で保持する。 */
export interface ReportValues {
  targetYm: string;
  /** 分析用 C4 当月売上高 */
  totalSales: number | null;
  /** 分析用の表示順に並んだカテゴリ結果 */
  categories: CategoryResult[];
  /** 分析用 C22 = SUM(C5:C19) 合計対象カテゴリのみ */
  totalUsageAmount: number;
  /** 分析用 F22 = SUM(F5:F19) */
  totalClosingAmount: number;
  /** 分析用 E22 = C22/C4。百分率。 */
  overallCostRatePercent: number | null;
  /** 分析用 K7 ロス額。実運用では空欄のため既定0。 */
  lossAmount: number;
  /** 分析用 K9 = C22 − K7 */
  costAfterLoss: number;
  /** 分析用 L11 = K9/C4*100。百分率。 */
  costRateAfterLossPercent: number | null;
  /** 分析用 L14 = C13 野菜カテゴリの当月使用高 */
  saladVegetableUsage: number | null;
  /** 算出不可となった指標とその理由 */
  unavailableReasons: Record<string, string>;
}

/** 1か月分の処理結果。 */
export interface MonthlyResult {
  targetYm: string;
  rows: ProductRow[];
  report: ReportValues;
  issues: ValidationIssue[];
}
