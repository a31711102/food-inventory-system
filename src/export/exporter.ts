/**
 * 完成Excelの出力。
 *
 * 当月本部マスタをテンプレートとし、入力セルだけを書き戻す（設計書§2.2）:
 *   入力用!G 期末在庫 / H 期中仕入 / I 期首在庫 / K 単価（Aコードのみ）
 *   分析用!C4 当月売上高 / K7 ロス額
 *
 * J/L/M/U/V 列や分析用の集計はテンプレートの数式がそのまま計算する。
 * 書き戻しでキャッシュ値が古くなるため fullCalcOnLoad を立て、Excel が開いた瞬間に再計算させる。
 *
 * BLOCKING が1件でも残っていれば出力しない（誤った完成Excelを配布しないため。受入条件7）。
 */
import type { XlsxWorkbook } from "../xlsx/workbook";
import { FormulaCellWriteError } from "../xlsx/workbook";
import type { ProductRow, ReportValues } from "../domain/models";
import type { ProductDiffRow, ReportDiffRow } from "../domain/diff";
import type { Anomaly } from "../domain/anomaly";
import {
  IssueCollector,
  createIssue,
  type ValidationIssue,
} from "../domain/issues";
import type { MappingProfile } from "../ingest/mapping";
import { resolveColumns } from "../ingest/mapping";
import {
  buildProductComparisonSheet,
  buildReportComparisonSheet,
  PRODUCT_SHEET_NAME,
  REPORT_SHEET_NAME,
} from "./comparisonSheets";

export interface ExportInput {
  workbook: XlsxWorkbook;
  profile: MappingProfile;
  targetYm: string;
  previousYm: string | null;
  rows: readonly ProductRow[];
  report: ReportValues;
  productDiffs: readonly ProductDiffRow[];
  reportDiffs: readonly ReportDiffRow[];
  anomalies: readonly Anomaly[];
  /** 取込・計算時に発生した検証結果。BLOCKING があれば出力を止める */
  issues: readonly ValidationIssue[];
  includeComparisonSheets?: boolean;
  revision?: number;
}

export interface ExportResult {
  bytes: Uint8Array;
  fileName: string;
  writtenCells: number;
  issues: ValidationIssue[];
}

export class ExportBlockedError extends Error {
  constructor(
    message: string,
    readonly issues: readonly ValidationIssue[],
  ) {
    super(message);
    this.name = "ExportBlockedError";
  }

  /** 1件の ValidationIssue から作る。画面表示とエラー一覧で文言が食い違わないようにする。 */
  static fromIssue(issue: ValidationIssue): ExportBlockedError {
    return new ExportBlockedError(
      `${issue.code} ${issue.title}: ${issue.message}`,
      [issue],
    );
  }
}

export function assertExportable(issues: readonly ValidationIssue[]): void {
  const blocking = issues.filter((i) => i.level === "BLOCKING");
  if (blocking.length > 0) {
    const detail = blocking
      .slice(0, 5)
      .map((i) => `${i.code} ${i.title}: ${i.message}`)
      .join("\n");
    throw new ExportBlockedError(
      `未解決のエラーが ${blocking.length} 件あるため、完成Excelを出力できません。\n${detail}${blocking.length > 5 ? "\n…ほか" : ""}`,
      blocking,
    );
  }
}

export async function exportWorkbook(
  input: ExportInput,
): Promise<ExportResult> {
  assertExportable(input.issues);

  const issues = new IssueCollector();
  const { workbook, profile } = input;

  const resolved = resolveColumns(workbook, profile);
  const sheetName = resolved.sheetName;
  if (!sheetName) {
    throw new ExportBlockedError(
      "入力用シートを特定できないため出力できません。",
      resolved.issues.length > 0
        ? resolved.issues
        : [
            createIssue(
              "E008",
              "入力用シートを特定できないため出力できません。",
            ),
          ],
    );
  }

  const letterOf = (field: string): string | null =>
    resolved.columns[field]?.letter ?? null;
  const gCol = letterOf("closingQty");
  const hCol = letterOf("purchaseQty");
  const iCol = letterOf("openingQty");
  const kCol = letterOf("unitPrice");

  let written = 0;
  try {
    for (const row of input.rows) {
      if (gCol) {
        workbook.setNumber(sheetName, `${gCol}${row.lineNo}`, row.closingQty);
        written += 1;
      }
      if (hCol) {
        workbook.setNumber(sheetName, `${hCol}${row.lineNo}`, row.purchaseQty);
        written += 1;
      }
      if (iCol) {
        workbook.setNumber(sheetName, `${iCol}${row.lineNo}`, row.openingQty);
        written += 1;
      }
      // 単価は自店購入（Aコード）のみ書き戻す。本部商品の単価はマスタの値を正とする。
      if (kCol && row.isOwnPurchase) {
        workbook.setNumber(sheetName, `${kCol}${row.lineNo}`, row.unitPrice);
        written += 1;
      }
    }
  } catch (e) {
    if (e instanceof FormulaCellWriteError) {
      throw ExportBlockedError.fromIssue(
        createIssue("E010", e.message, { sheetName: e.sheetName, cell: e.ref }),
      );
    }
    throw e;
  }

  const analysis = profile.analysisSheet;
  if (analysis && workbook.hasSheet(analysis.name)) {
    const salesCell = analysis.cells["totalSales"];
    if (salesCell?.writeback) {
      if (input.report.totalSales === null) {
        const issue = createIssue(
          "E011",
          "当月売上高が未設定のため出力できません。分析用シートの当月売上高を確認するか、分析・出力画面で入力してください。",
          {
            fileName: undefined,
            sheetName: analysis.name,
            cell: salesCell.address,
          },
        );
        throw ExportBlockedError.fromIssue(issue);
      }
      workbook.setNumber(
        analysis.name,
        salesCell.address,
        input.report.totalSales,
      );
      written += 1;
    }
    const lossCell = analysis.cells["lossAmount"];
    if (lossCell?.writeback) {
      // 実運用ではロス額は空欄。0 を書くと帳票の見た目が変わるため、0 のときは空欄のままにする。
      workbook.setNumber(
        analysis.name,
        lossCell.address,
        input.report.lossAmount === 0 ? null : input.report.lossAmount,
      );
      written += 1;
    }
  }

  if (input.includeComparisonSheets !== false) {
    workbook.addSheet(
      PRODUCT_SHEET_NAME,
      buildProductComparisonSheet(input.productDiffs),
    );
    workbook.addSheet(
      REPORT_SHEET_NAME,
      buildReportComparisonSheet(input.reportDiffs, input.anomalies, {
        targetYm: input.targetYm,
        previousYm: input.previousYm,
      }),
    );
  }

  // 書き戻しで J/L/M などのキャッシュ値が古くなるため、開いたときに全再計算させる
  workbook.enableFullCalcOnLoad();

  const bytes = await workbook.toUint8Array();

  return {
    bytes,
    fileName: buildFileName(input.targetYm, input.revision ?? 1),
    writtenCells: written,
    issues: [...issues.all],
  };
}

export function buildFileName(
  targetYm: string,
  revision: number,
  now = new Date(),
): string {
  const ym = targetYm.replace("-", "");
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `食品棚卸表_${ym}_r${revision}_${stamp}.xlsx`;
}
