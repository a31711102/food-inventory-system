/**
 * 入力用シートの取込。当月本部マスタと前月食品棚卸表の両方に使う。
 *
 * 商品コードは openpyxl/pandas のような型推論を挟まず、セルの格納型をそのまま見る。
 * 数値型だった場合は必ず I001 を出し、先頭ゼロ喪失の疑いを管理者に見せる。
 */
import type { XlsxWorkbook } from '../xlsx/workbook';
import type { ProductRow, PreviousMonthEntry, ReportValues } from '../domain/models';
import { parseProductCode, type ProductCode } from '../domain/productCode';
import { DEFAULT_OWN_PURCHASE_CODES, isSupplyCode } from '../domain/productKind';
import {
  IssueCollector,
  summarize,
  type IssueDetail,
  type SourceRef,
  type ValidationIssue,
} from '../domain/issues';
import { foldIngestIssues } from './orderFile';
import { computeDerived } from '../domain/calculation';
import type { MappingProfile } from './mapping';
import { resolveColumns, type ResolveResult } from './mapping';

export interface ReadInventoryOptions {
  fileName: string;
  /** 新規商品の期首を承認済みとして読むか（再取込時など） */
  approveOpening?: boolean;
  /** 自店購入品の商品コード。未指定なら既定の5品 */
  ownPurchaseCodes?: ReadonlySet<string>;
}

export interface ReadInventoryResult {
  rows: ProductRow[];
  resolved: ResolveResult;
  issues: ValidationIssue[];
  /** 分析用シートから読んだ値（当月売上高・ロス額・Excel側の計算結果） */
  analysis: AnalysisValues;
}

export interface AnalysisValues {
  totalSales: number | null;
  lossAmount: number | null;
  /** Excel が計算した値。検算（W010）に使う */
  excelTotalUsageAmount: number | null;
  excelTotalClosingAmount: number | null;
  excelCostAfterLoss: number | null;
  excelCostRateAfterLossPercent: number | null;
  excelSaladVegetableUsage: number | null;
}

function toNumber(
  value: string | number | boolean | null | undefined,
  ref: SourceRef,
  fieldLabel: string,
  bad: IssueDetail[],
): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const trimmed = value.replace(/[\s　,]/g, '');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    bad.push({ ref, text: `${fieldLabel}（${ref.rowNo}行目、値「${value}」）` });
    return null;
  }
  return n;
}

export function readInventorySheet(
  wb: XlsxWorkbook,
  profile: MappingProfile,
  options: ReadInventoryOptions,
): ReadInventoryResult {
  const issues = new IssueCollector();
  const resolved = resolveColumns(wb, profile, options.fileName);
  issues.addAll(resolved.issues);

  const rows: ProductRow[] = [];
  const badNumbers: IssueDetail[] = [];
  const ownPurchaseCodes =
    options.ownPurchaseCodes ?? new Set<string>(DEFAULT_OWN_PURCHASE_CODES);
  const analysis = readAnalysisSheet(wb, profile, options.fileName, issues);

  if (!resolved.sheetName || issues.hasBlocking()) {
    return { rows, resolved, issues: [...issues.all], analysis };
  }

  const letter = (field: string): string | null => resolved.columns[field]?.letter ?? null;
  const read = (field: string, row: number): string | number | boolean | null => {
    const col = letter(field);
    if (!col) return null;
    return wb.cell(resolved.sheetName, `${col}${row}`)?.value ?? null;
  };

  const lastRow = wb.maxRow(resolved.sheetName);
  let blankStreak = 0;

  for (let r = profile.data.startRow; r <= lastRow; r += 1) {
    const rawCode = read('productCode', r);
    const ref: SourceRef = {
      fileName: options.fileName,
      sheetName: resolved.sheetName,
      rowNo: r,
    };

    if (rawCode === null || rawCode === '') {
      blankStreak += 1;
      // 空行が続いたらデータ終端とみなす（注意事項シートの説明行などを拾わないため）
      if (profile.data.stopOnBlankCode && blankStreak >= 3) break;
      continue;
    }
    blankStreak = 0;

    const parsed = parseProductCode(rawCode, ref);
    issues.addAll(parsed.issues);
    if (!parsed.code) continue;

    const code: ProductCode = parsed.code;
    const codeRef: SourceRef = { ...ref, productCode: code };

    const name = read('productName', r);
    const category = read('category', r);

    rows.push(
      computeDerived({
        lineNo: r,
        code,
        name: name === null ? '' : String(name),
        inventoryUnit: read('inventoryUnit', r) === null ? null : String(read('inventoryUnit', r)),
        category: category === null ? '' : String(category),
        unitPrice: toNumber(read('unitPrice', r), codeRef, '単価', badNumbers) ?? 0,
        conversionFactor:
          toNumber(read('conversionFactor', r), codeRef, '仕入れ単位', badNumbers) ?? 0,
        closingQty: toNumber(read('closingQty', r), codeRef, '期末在庫', badNumbers) ?? 0,
        purchaseQty: toNumber(read('purchaseQty', r), codeRef, '期中仕入', badNumbers) ?? 0,
        openingQty: toNumber(read('openingQty', r), codeRef, '期首在庫', badNumbers) ?? 0,
        status: 'CONTINUED',
        isOwnPurchase: ownPurchaseCodes.has(code),
        isSupply: isSupplyCode(code),
        openingApproved: options.approveOpening ?? false,
        usageQty: null,
        usageAmount: null,
        closingAmount: null,
      }),
    );
  }

  issues.addMany('E007', badNumbers, (n, d) =>
    `数値に変換できない値が ${n} 件あります（${summarize(d)}）。元ファイルの該当セルに文字や記号が入っていないか確認してください。`,
    { fileName: options.fileName, sheetName: resolved.sheetName });

  return {
    rows,
    resolved,
    issues: foldIngestIssues([...issues.all]),
    analysis,
  };
}

function readAnalysisSheet(
  wb: XlsxWorkbook,
  profile: MappingProfile,
  fileName: string,
  issues: IssueCollector,
): AnalysisValues {
  const empty: AnalysisValues = {
    totalSales: null,
    lossAmount: null,
    excelTotalUsageAmount: null,
    excelTotalClosingAmount: null,
    excelCostAfterLoss: null,
    excelCostRateAfterLossPercent: null,
    excelSaladVegetableUsage: null,
  };

  const spec = profile.analysisSheet;
  if (!spec) return empty;
  if (!wb.hasSheet(spec.name)) {
    issues.add(
      'W020',
      `分析用シート「${spec.name}」が見つかりません。当月売上高やロス額を読み取れないため、画面で入力してください。`,
      { fileName },
    );
    return empty;
  }

  const num = (key: string): number | null => {
    const address = spec.cells[key]?.address;
    if (!address) return null;
    const v = wb.cell(spec.name, address)?.value;
    return typeof v === 'number' ? v : null;
  };

  return {
    totalSales: num('totalSales'),
    lossAmount: num('lossAmount'),
    excelTotalUsageAmount: num('totalUsageAmount'),
    excelTotalClosingAmount: num('totalClosingAmount'),
    excelCostAfterLoss: num('costAfterLoss'),
    excelCostRateAfterLossPercent: num('costRateAfterLoss'),
    excelSaladVegetableUsage: num('saladVegetableUsage'),
  };
}

/** 前月食品棚卸表を引継ぎ元の形へ変換する。 */
export function toPreviousEntries(rows: readonly ProductRow[]): PreviousMonthEntry[] {
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    category: r.category,
    unitPrice: r.unitPrice,
    closingQty: r.closingQty,
    purchaseQty: r.purchaseQty,
    openingQty: r.openingQty,
    usageQty: r.usageQty,
    usageAmount: r.usageAmount,
    closingAmount: r.closingAmount,
    lineNo: r.lineNo,
  }));
}

/**
 * システムの計算値と Excel が計算した値を突合する（設計書§11 の検算）。
 * 独立に同じ結果を出すはずであり、乖離は取込ミスまたは実装バグを示す。
 */
export function crossCheck(
  computed: ReportValues,
  excel: AnalysisValues,
  tolerance = { amount: 0.01, ratePt: 0.0001 },
): ValidationIssue[] {
  const issues = new IssueCollector();
  const gaps: IssueDetail[] = [];

  const compare = (
    label: string,
    mine: number | null,
    theirs: number | null,
    tol: number,
    unit: string,
  ): void => {
    if (mine === null || theirs === null) return;
    const diff = Math.abs(mine - theirs);
    if (diff > tol) {
      gaps.push({
        ref: {},
        text: `${label}（システム ${mine}${unit} / Excel ${theirs}${unit} / 差 ${diff}${unit}）`,
      });
    }
  };

  compare('使用高合計', computed.totalUsageAmount, excel.excelTotalUsageAmount, tolerance.amount, '円');
  compare(
    '食材期末在庫計',
    computed.totalClosingAmount,
    excel.excelTotalClosingAmount,
    tolerance.amount,
    '円',
  );
  compare('ロス引き後原価', computed.costAfterLoss, excel.excelCostAfterLoss, tolerance.amount, '円');
  compare(
    'ロス引き後原価率',
    computed.costRateAfterLossPercent,
    excel.excelCostRateAfterLossPercent,
    tolerance.ratePt,
    '%',
  );
  compare(
    'サラダ野菜使用高',
    computed.saladVegetableUsage,
    excel.excelSaladVegetableUsage,
    tolerance.amount,
    '円',
  );

  issues.addMany('W010', gaps, (n, d) =>
    `前月ファイルの検算で、システムの計算値とExcelの計算結果が一致しない指標が ${n} 件あります（${summarize(d)}）。取込設定または入力値を確認してください。`);

  return [...issues.all];
}
