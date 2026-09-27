/**
 * 期首引継ぎ。
 *
 *   当月 期首在庫 (I列) = 前月 期末在庫 (G列)
 *
 * 突合は商品コードの完全一致のみで行う。行番号・商品名・部分一致は一切使わない。
 * 現行ツールは商品コードを数値型で保持しており、6桁ゼロ埋めで突合すると
 * Aコード21件（自店購入のキャベツを含む）が落ちる（設計書§1.9）。
 * ここが受入条件1の中核である。
 *
 * 引継ぎ自体に再計算は行わない（要件§3-2）。前月の値をそのまま転記する。
 */
import type { ProductRow, PreviousMonthEntry } from './models';
import type { ProductCode } from './productCode';
import { IssueCollector, summarize, type IssueDetail, type ValidationIssue } from './issues';

export interface CarryoverResult {
  rows: ProductRow[];
  newProducts: ProductRow[];
  deletedProducts: PreviousMonthEntry[];
  issues: ValidationIssue[];
}

export interface CarryoverOptions {
  fileName?: string;
  sheetName?: string;
}

export function applyCarryover(
  currentRows: readonly ProductRow[],
  previousByCode: ReadonlyMap<string, PreviousMonthEntry>,
  options: CarryoverOptions = {},
): CarryoverResult {
  const issues = new IssueCollector();
  const seenCodes = new Set<ProductCode>();
  const newProducts: ProductRow[] = [];
  // 事象ごとに集めて、最後に1件ずつのメッセージへまとめる
  const unapproved: IssueDetail[] = [];
  const renamed: IssueDetail[] = [];
  const recategorized: IssueDetail[] = [];
  const overwritten: IssueDetail[] = [];
  const leftover: IssueDetail[] = [];

  const rows = currentRows.map((row) => {
    seenCodes.add(row.code);
    const ref = {
      fileName: options.fileName,
      sheetName: options.sheetName,
      rowNo: row.lineNo,
      productCode: row.code,
    };
    const prev = previousByCode.get(row.code);

    if (!prev) {
      // 新規商品: 期首は0を提示し、管理者の承認を経て確定する（要件§5）
      if (!row.openingApproved) {
        unapproved.push({ ref, text: `${row.code} ${row.name}` });
      }
      const created: ProductRow = { ...row, openingQty: 0, status: 'NEW' };
      newProducts.push(created);
      return created;
    }

    // 当月マスタに既に期首が入っており、引継ぎ値と食い違う場合は黙って上書きしない。
    // 通常のマスタは空欄なので発生しないが、完成済みファイルの再取込や手修正済みの
    // マスタを取り込んだときに、修正が消えたことに気づけるようにする。
    if (row.openingQty !== 0 && row.openingQty !== prev.closingQty) {
      overwritten.push({
        ref,
        text: `${row.code} ${row.name}（マスタ ${row.openingQty} → 引継ぎ ${prev.closingQty}）`,
      });
    }

    if (prev.name !== row.name) {
      renamed.push({ ref, text: `${row.code}「${prev.name}」→「${row.name}」` });
    }
    if (prev.category !== row.category) {
      recategorized.push({
        ref,
        text: `${row.code} ${row.name}（${prev.category} → ${row.category}）`,
      });
    }

    // 再計算せず、前月期末をそのまま転記する
    return { ...row, openingQty: prev.closingQty, status: 'CONTINUED' as const };
  });

  const deletedProducts: PreviousMonthEntry[] = [];
  for (const [codeKey, prev] of previousByCode) {
    if (seenCodes.has(codeKey as ProductCode)) continue;
    deletedProducts.push(prev);
    if (prev.closingQty !== 0) {
      leftover.push({
        ref: { rowNo: prev.lineNo, productCode: prev.code },
        text: `${prev.code} ${prev.name}（前月期末 ${prev.closingQty}）`,
      });
    }
  }

  const base = { fileName: options.fileName, sheetName: options.sheetName };
  issues.addMany('W004', unapproved, (n, d) =>
    `新規商品 ${n} 件の期首在庫0が未承認です（${summarize(d)}）。商品差分確認画面で承認してください。`, base);
  issues.addMany('W018', overwritten, (n, d) =>
    `当月マスタに入っていた期首在庫 ${n} 件を、前月期末からの引継ぎ値で上書きしました（${summarize(d)}）。手修正していた値であれば、その理由を確認してください。`, base);
  issues.addMany('W002', renamed, (n, d) =>
    `商品名が変更された商品が ${n} 件あります（${summarize(d)}）。当月の名称を採用します。`, base);
  issues.addMany('W003', recategorized, (n, d) =>
    `分類が変更された商品が ${n} 件あります（${summarize(d)}）。当月の分類を採用するため、その商品の使用高は新しい分類へ集計されます。集計先が変わってよいか確認してください。`, base);
  issues.addMany('W001', leftover, (n, d) =>
    `前月にあって当月マスタから消えた商品のうち ${n} 件に期末残が残っています（${summarize(d)}）。当月の計算対象から外れるため、残在庫の扱いを確認してください。`, base);

  return { rows, newProducts, deletedProducts, issues: [...issues.all] };
}
