/**
 * 列マッピングプロファイル。
 *
 * 実ファイルの列名は確定しているが、本部の帳票改訂にコード修正なしで追随できるよう
 * 設定として外に出す。要件§5「管理者は初回に各入力ファイルの列・シートをシステム標準項目へ
 * 対応づける」「次月以降は保存済み設定を提案する」に対応する。
 *
 * 要件§5「単に同名列があるだけで誤った列を自動採用しない」を守るため、
 * 完全一致で見つからない列は候補として返すだけで自動採用しない。
 */
import type { XlsxWorkbook } from '../xlsx/workbook';
import { colIndexToLetter, parseRef } from '../xlsx/columns';
import {
  IssueCollector,
  summarize,
  type IssueDetail,
  type SourceRef,
  type ValidationIssue,
} from '../domain/issues';

export type FieldType = 'str' | 'number';

export interface ColumnSpec {
  /** 見出し行に現れる列名 */
  source: string;
  required: boolean;
  dtype: FieldType;
  /** 出力時にこの列へ書き戻すか */
  writeback?: boolean | 'ownPurchaseOnly';
}

export interface AnalysisCellSpec {
  address: string;
  writeback?: boolean;
}

export interface MappingProfile {
  fileKind: 'HQ_MASTER' | 'PREV_INVENTORY' | 'ORDER_CUMULATIVE' | 'UNIT_MASTER';
  version: number;
  sheet: { byName: string[] };
  header: { row: number; detectBy: string[] };
  data: { startRow: number; stopOnBlankCode: boolean };
  columns: Record<string, ColumnSpec>;
  analysisSheet?: {
    name: string;
    cells: Record<string, AnalysisCellSpec>;
  };
  ignoreUnknownColumns: boolean;
}

export interface ResolvedColumn {
  field: string;
  spec: ColumnSpec;
  /** 列記号（"D" など）。未解決なら null */
  letter: string | null;
  /** 完全一致で見つかったか。false の場合は候補止まりで自動採用していない */
  exact: boolean;
  /** 部分一致候補（自動採用しない） */
  candidates: { letter: string; text: string }[];
}

export interface ResolveResult {
  sheetName: string;
  headerRow: number;
  columns: Record<string, ResolvedColumn>;
  /** 見出し行の全列。取込プレビューに使う */
  headers: { letter: string; text: string }[];
  issues: ValidationIssue[];
}

function normalizeHeader(text: string): string {
  return text.replace(/[\s　]+/g, '').normalize('NFKC');
}

/** プロファイルの候補からシートを選ぶ。見つからなければ E008。 */
export function resolveSheet(
  wb: XlsxWorkbook,
  profile: MappingProfile,
  issues: IssueCollector,
  fileName?: string,
): string | null {
  for (const name of profile.sheet.byName) {
    if (wb.hasSheet(name)) return name;
  }
  issues.add(
    'E008',
    `シートが見つかりません。候補: ${profile.sheet.byName.join(' / ')}。実際のシート: ${wb.sheetNames.join(' / ')}`,
    { fileName },
  );
  return null;
}

/** 見出し行を自動検出する。detectBy の文字列を含む行を優先し、なければ profile の row を使う。 */
export function detectHeaderRow(
  wb: XlsxWorkbook,
  sheetName: string,
  profile: MappingProfile,
): { row: number; detected: boolean } {
  const cells = wb.cells(sheetName);
  const targets = profile.header.detectBy.map(normalizeHeader);
  if (targets.length === 0) return { row: profile.header.row, detected: false };

  const byRow = new Map<number, string[]>();
  for (const cell of cells.values()) {
    if (typeof cell.value !== 'string') continue;
    const list = byRow.get(cell.row) ?? [];
    list.push(normalizeHeader(cell.value));
    byRow.set(cell.row, list);
  }

  const rows = [...byRow.keys()].sort((a, b) => a - b);
  for (const row of rows) {
    const values = byRow.get(row)!;
    if (targets.every((t) => values.includes(t))) {
      return { row, detected: true };
    }
  }
  return { row: profile.header.row, detected: false };
}

export function resolveColumns(
  wb: XlsxWorkbook,
  profile: MappingProfile,
  fileName?: string,
): ResolveResult {
  const issues = new IssueCollector();
  const sheetName = resolveSheet(wb, profile, issues, fileName);

  if (!sheetName) {
    return {
      sheetName: '',
      headerRow: profile.header.row,
      columns: {},
      headers: [],
      issues: [...issues.all],
    };
  }

  const { row: headerRow, detected } = detectHeaderRow(wb, sheetName, profile);
  if (detected && headerRow !== profile.header.row) {
    issues.add(
      'W007',
      `見出し行が保存済み設定の ${profile.header.row} 行目ではなく ${headerRow} 行目で検出されました。列の対応を確認してください。`,
      { fileName, sheetName, rowNo: headerRow },
    );
  }

  const headers: { letter: string; text: string }[] = [];
  const byNormalized = new Map<string, { letter: string; text: string }[]>();
  for (const cell of wb.cells(sheetName).values()) {
    if (cell.row !== headerRow) continue;
    if (cell.value === null || cell.value === undefined || cell.value === '') continue;
    const text = String(cell.value);
    const letter = colIndexToLetter(cell.col);
    headers.push({ letter, text });
    const key = normalizeHeader(text);
    const list = byNormalized.get(key) ?? [];
    list.push({ letter, text });
    byNormalized.set(key, list);
  }
  headers.sort((a, b) => parseRef(`${a.letter}1`).col - parseRef(`${b.letter}1`).col);

  const columns: Record<string, ResolvedColumn> = {};
  const usedLetters = new Set<string>();
  // 事象ごとにまとめ、最後に1件ずつのメッセージにする（1事象1メッセージ）
  const ambiguous: IssueDetail[] = [];
  const missingRequired: IssueDetail[] = [];
  const missingOptional: IssueDetail[] = [];
  const headerRef: SourceRef = { fileName, sheetName, rowNo: headerRow };

  for (const [field, spec] of Object.entries(profile.columns)) {
    const key = normalizeHeader(spec.source);
    const exactMatches = byNormalized.get(key) ?? [];

    if (exactMatches.length === 1) {
      const letter = exactMatches[0]!.letter;
      usedLetters.add(letter);
      columns[field] = { field, spec, letter, exact: true, candidates: [] };
      continue;
    }

    if (exactMatches.length > 1) {
      // 列が見つからない（E001）のとは原因も対処も違うので、コードを分けている。
      // こちらは元ファイルの見出しから重複を取り除いてもらう必要がある。
      ambiguous.push({
        ref: headerRef,
        text: `「${spec.source}」が ${exactMatches.length} 個（${exactMatches.map((m) => `${m.letter}列`).join('、')}）`,
      });
      columns[field] = { field, spec, letter: null, exact: false, candidates: exactMatches };
      continue;
    }

    // 完全一致なし。部分一致は候補として示すだけで自動採用しない。
    const candidates = headers.filter(
      (h) => normalizeHeader(h.text).includes(key) || key.includes(normalizeHeader(h.text)),
    );
    columns[field] = { field, spec, letter: null, exact: false, candidates };

    const hint = candidates.length
      ? `候補: ${candidates.map((c) => `${c.letter}列「${c.text}」`).join('、')}`
      : '候補なし';
    if (spec.required) {
      missingRequired.push({ ref: headerRef, text: `「${spec.source}」（${hint}）` });
    } else {
      missingOptional.push({ ref: headerRef, text: `「${spec.source}」` });
    }
  }

  issues.addMany('E014', ambiguous, (n, d) =>
    `見出し行（${headerRow}行目）に同じ列名が複数ある項目が ${n} 件あります（${summarize(d)}）。どれを使うか確定できないため処理を止めます。元ファイルの見出しを1つに直して再取込してください。`,
    headerRef);

  issues.addMany('E001', missingRequired, (n, d) =>
    `必須列 ${n} 件が見出し行（${headerRow}行目）に見つかりません（${summarize(d)}）。取込プレビューで確認のうえ手動で対応づけてください。`,
    headerRef);

  issues.addMany('W006', missingOptional, (n, d) =>
    `任意列 ${n} 件が見つかりません（${summarize(d)}）。空欄として扱います。`,
    headerRef);

  if (profile.ignoreUnknownColumns) {
    const unknown: IssueDetail[] = headers
      .filter((h) => !usedLetters.has(h.letter))
      .map((h) => ({ ref: headerRef, text: `${h.letter}列「${h.text}」` }));
    issues.addMany('I002', unknown, (n, d) =>
      `プロファイルにない列を ${n} 個検出しました（${summarize(d)}）。無視して取り込みます。`,
      headerRef);
  }

  return { sheetName, headerRow, columns, headers, issues: [...issues.all] };
}

/** 取込プレビュー用に、各項目の先頭 n 行の実値を返す（要件§5）。 */
export function previewSamples(
  wb: XlsxWorkbook,
  resolved: ResolveResult,
  startRow: number,
  count = 3,
): Record<string, (string | number | boolean | null)[]> {
  const out: Record<string, (string | number | boolean | null)[]> = {};
  for (const [field, col] of Object.entries(resolved.columns)) {
    if (!col.letter) {
      out[field] = [];
      continue;
    }
    const values: (string | number | boolean | null)[] = [];
    for (let i = 0; i < count; i += 1) {
      values.push(wb.cell(resolved.sheetName, `${col.letter}${startRow + i}`)?.value ?? null);
    }
    out[field] = values;
  }
  return out;
}
