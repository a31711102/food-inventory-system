/**
 * 既定の列マッピングプロファイル。
 * 実ファイル（2026.8月分）の解析結果をそのまま初期値としている。
 * 管理者が画面で変更した場合は新版としてDBに保存され、以後はそちらが使われる。
 */
import type { MappingProfile } from './mapping';

/** 当月本部マスタ・前月食品棚卸表（同一構造） */
export const HQ_MASTER_PROFILE: MappingProfile = {
  fileKind: 'HQ_MASTER',
  version: 1,
  sheet: { byName: ['入力用'] },
  header: { row: 2, detectBy: ['商品コード', '商品名'] },
  data: { startRow: 3, stopOnBlankCode: true },
  columns: {
    productCode: { source: '商品コード', required: true, dtype: 'str' },
    productName: { source: '商品名', required: true, dtype: 'str' },
    inventoryUnit: { source: '棚卸単位', required: false, dtype: 'str' },
    closingQty: { source: '期末在庫', required: true, dtype: 'number', writeback: true },
    purchaseQty: { source: '期中仕入', required: true, dtype: 'number', writeback: true },
    openingQty: { source: '期首在庫', required: true, dtype: 'number', writeback: true },
    unitPrice: { source: '単価', required: true, dtype: 'number', writeback: 'ownPurchaseOnly' },
    category: { source: '分類', required: true, dtype: 'str' },
    conversionFactor: { source: '仕入れ単位', required: true, dtype: 'number' },
  },
  analysisSheet: {
    name: '分析用',
    cells: {
      totalSales: { address: 'C4', writeback: true },
      lossAmount: { address: 'K7', writeback: true },
      totalUsageAmount: { address: 'C22' },
      totalClosingAmount: { address: 'F22' },
      overallCostRate: { address: 'E22' },
      costAfterLoss: { address: 'K9' },
      costRateAfterLoss: { address: 'L11' },
      saladVegetableUsage: { address: 'L14' },
    },
  },
  ignoreUnknownColumns: true,
};

export const PREV_INVENTORY_PROFILE: MappingProfile = {
  ...HQ_MASTER_PROFILE,
  fileKind: 'PREV_INVENTORY',
};

/**
 * 発注累計照会。実ファイル（2026-09-24 受領）の列構成に合わせている。
 *
 *   店舗コード / 店舗名 / 納品日From / 納品日To / 原材料コード / 原材料名 / 発注数 / 単位 / 入数 / 入数単位
 *
 * 【重要】このファイルに「計算単位」列は存在しない。似た名前の「入数」は
 * 内容量（カットオクラ = 500ｇ）であって棚卸単位への換算係数ではなく、
 * 実データでは棚卸表のP列と 115件中79件が食い違う。
 * したがって換算係数には**使わない**。換算係数は単位計算マスタの「計算単位」を正とする。
 */
export const ORDER_PROFILE: MappingProfile = {
  fileKind: 'ORDER_CUMULATIVE',
  version: 2,
  sheet: { byName: ['発注累計照会', 'Sheet1'] },
  header: { row: 1, detectBy: ['原材料コード', '発注数'] },
  data: { startRow: 2, stopOnBlankCode: true },
  columns: {
    productCode: { source: '原材料コード', required: true, dtype: 'str' },
    productName: { source: '原材料名', required: false, dtype: 'str' },
    orderQty: { source: '発注数', required: true, dtype: 'number' },
    unitLabel: { source: '単位', required: false, dtype: 'str' },
    // 以下は取込時の検証・表示に使う。計算には用いない。
    storeCode: { source: '店舗コード', required: false, dtype: 'str' },
    periodFrom: { source: '納品日From', required: false, dtype: 'str' },
    periodTo: { source: '納品日To', required: false, dtype: 'str' },
    packSize: { source: '入数', required: false, dtype: 'str' },
    packUnit: { source: '入数単位', required: false, dtype: 'str' },
  },
  ignoreUnknownColumns: true,
};

/** 単位計算マスタ */
export const UNIT_MASTER_PROFILE: MappingProfile = {
  fileKind: 'UNIT_MASTER',
  version: 1,
  sheet: { byName: ['発注品計算単位一覧'] },
  header: { row: 1, detectBy: ['原材料コード', '計算単位'] },
  data: { startRow: 2, stopOnBlankCode: true },
  columns: {
    productCode: { source: '原材料コード', required: true, dtype: 'str' },
    productName: { source: '原材料名', required: false, dtype: 'str' },
    orderUnit: { source: '発注数', required: false, dtype: 'number' },
    unitLabel: { source: '単位', required: false, dtype: 'str' },
    factor: { source: '計算単位', required: true, dtype: 'number' },
  },
  ignoreUnknownColumns: true,
};

export const DEFAULT_PROFILES = {
  HQ_MASTER: HQ_MASTER_PROFILE,
  PREV_INVENTORY: PREV_INVENTORY_PROFILE,
  ORDER_CUMULATIVE: ORDER_PROFILE,
  UNIT_MASTER: UNIT_MASTER_PROFILE,
} as const;
