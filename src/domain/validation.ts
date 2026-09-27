/**
 * 明細行に対する検証。
 *
 * 要件§4「同じ商品コードに複数行がある場合は、行の意味を確認するまで自動集約しない」
 * 要件§5「商品コードが一意にならない → 処理を止め、元ファイルの行を示す」
 */
import type { ProductRow } from './models';
import { categoryByCode } from './categories';
import { IssueCollector, summarize, type IssueDetail, type SourceRef, type ValidationIssue } from './issues';

export interface ValidateOptions {
  fileName?: string;
  sheetName?: string;
}

export function validateProductRows(
  rows: readonly ProductRow[],
  options: ValidateOptions = {},
): ValidationIssue[] {
  const issues = new IssueCollector();
  const base: SourceRef = { fileName: options.fileName, sheetName: options.sheetName };

  // --- E002 商品コード重複 ---
  const byCode = new Map<string, ProductRow[]>();
  for (const row of rows) {
    const list = byCode.get(row.code);
    if (list) list.push(row);
    else byCode.set(row.code, [row]);
  }
  const duplicates: IssueDetail[] = [];
  for (const [codeValue, group] of byCode) {
    if (group.length < 2) continue;
    const lines = group.map((r) => r.lineNo).join(', ');
    const names = [...new Set(group.map((r) => r.name))].join(' / ');
    duplicates.push({
      ref: { ...base, productCode: codeValue, rowNo: group[0]!.lineNo },
      text: `${codeValue}（行 ${lines}、${names}）`,
    });
  }
  issues.addMany('E002', duplicates, (n, d) =>
    `商品コードが重複しています（${n} コード：${summarize(d)}）。行の意味を確認するまで自動集約しません。元ファイルを修正して再取込してください。`, base);

  // --- W013 未知の分類（同一分類はまとめて1件） ---
  const unknownCategories = new Map<string, ProductRow[]>();
  for (const row of rows) {
    if (categoryByCode(row.category)) continue;
    const list = unknownCategories.get(row.category);
    if (list) list.push(row);
    else unknownCategories.set(row.category, [row]);
  }
  const unknownDetails: IssueDetail[] = [...unknownCategories].map(([category, group]) => ({
    ref: { ...base, productCode: group[0]!.code, rowNo: group[0]!.lineNo },
    text: `「${category}」${group.length}件（例: 行 ${group[0]!.lineNo}）`,
  }));
  issues.addMany('W013', unknownDetails, (n, d) =>
    `既知の17分類に含まれない分類が ${n} 種類あります（${summarize(d)}）。カテゴリ集計と合計から除外されるため、分類定義の更新要否を確認してください。`, base);

  // --- E015 期末在庫が負の値 ---
  // 期末在庫は店舗が数えて手入力する実在庫なので、負になることは物理的にあり得ない。
  // 入力誤り（符号の付け間違い、隣のセルの値がずれた等）であり、そのまま計算すると
  // 当月使用高が過大になった帳票が出てしまうため処理を止める。
  const negativeClosing: IssueDetail[] = [];
  for (const row of rows) {
    if (row.closingQty < 0) {
      negativeClosing.push({
        ref: { ...base, productCode: row.code, rowNo: row.lineNo },
        text: `${row.code} ${row.name}（期末在庫 ${row.closingQty}）`,
      });
    }
  }
  issues.addMany('E015', negativeClosing, (n, d) =>
    `期末在庫が負の値になっている商品が ${n} 件あります（${summarize(d)}）。実在庫が負になることはないため、元ファイルの期末在庫欄を確認して修正してください。`, base);

  // --- W012 当月使用高がマイナス ---
  // 分析用シートの注意書き「当月使用高がマイナスになってないか確認をお願いいたします」に対応
  const negative: IssueDetail[] = [];
  for (const row of rows) {
    if (row.usageAmount !== null && row.usageAmount < 0) {
      negative.push({
        ref: { ...base, productCode: row.code, rowNo: row.lineNo },
        text: `${row.code} ${row.name}（期首 ${row.openingQty} ＋ 期中仕入 ${row.purchaseQty} − 期末 ${row.closingQty}）`,
      });
    }
  }
  issues.addMany('W012', negative, (n, d) =>
    `当月使用高がマイナスの商品が ${n} 件あります（${summarize(d)}）。棚卸数量か単価の入力誤りのほか、発注累計と帳票の差によって生じる場合もあります。`, base);

  return [...issues.all];
}
