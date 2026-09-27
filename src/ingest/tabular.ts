/**
 * 「見出し行＋データ行」という共通形をCSVとxlsxの両方から同じ形で読む層。
 *
 * 発注累計照会は CSV で提供されているが、将来 xlsx になっても取込側を変えずに済むよう、
 * どちらも Table（見出し配列＋行配列）に正規化してから列を解決する。
 */
import type { XlsxWorkbook } from '../xlsx/workbook';
import { colIndexToLetter } from '../xlsx/columns';
import { readCsv } from './csv';

export type CellValue = string | number | boolean | null;

export interface Table {
  /** 由来 */
  source: 'csv' | 'xlsx';
  sheetName: string | null;
  /** 見出し行の位置（1始まり） */
  headerRow: number;
  headers: string[];
  /** データ行。headers と同じ添字で並ぶ */
  rows: CellValue[][];
  /** 各データ行の元ファイル上の行番号（1始まり） */
  rowNumbers: number[];
  /** 列添字 → Excel の列記号（xlsx 由来のときのみ意味を持つ） */
  columnLetters: string[];
}

function normalize(text: string): string {
  return text.replace(/[\s　]+/g, '').normalize('NFKC');
}

/** CSV から Table を作る。数値に見える値は数値化するが、先頭ゼロのある値は文字列のまま残す。 */
export function tableFromCsv(bytes: Uint8Array, detectBy: readonly string[] = []): Table {
  const { rows: raw } = readCsv(bytes);
  const targets = detectBy.map(normalize);

  let headerIndex = 0;
  if (targets.length > 0) {
    const found = raw.findIndex((r) => targets.every((t) => r.map(normalize).includes(t)));
    if (found >= 0) headerIndex = found;
  }

  const headers = (raw[headerIndex] ?? []).map((h) => h.trim());
  const dataRows = raw.slice(headerIndex + 1);

  return {
    source: 'csv',
    sheetName: null,
    headerRow: headerIndex + 1,
    headers,
    rows: dataRows.map((r) => headers.map((_h, i) => coerce(r[i]))),
    rowNumbers: dataRows.map((_r, i) => headerIndex + 2 + i),
    columnLetters: headers.map((_h, i) => colIndexToLetter(i + 1)),
  };
}

/**
 * 先頭ゼロを持つ値は数値化しない。
 * "000140" を 140 にしてしまうと、現行ツールと同じ誤突合を招く。
 */
function coerce(value: string | undefined): CellValue {
  if (value === undefined) return null;
  const t = value.trim();
  if (t === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    if (/^0\d/.test(t)) return t; // 先頭ゼロは文字列のまま
    return Number(t);
  }
  return t;
}

export function tableFromSheet(
  wb: XlsxWorkbook,
  sheetName: string,
  headerRow: number,
  startRow: number,
): Table {
  const cells = wb.cells(sheetName);

  const headerCells = [...cells.values()]
    .filter((c) => c.row === headerRow && c.value !== null && c.value !== '')
    .sort((a, b) => a.col - b.col);

  const headers = headerCells.map((c) => String(c.value));
  const columns = headerCells.map((c) => c.col);
  const lastRow = wb.maxRow(sheetName);

  const rows: CellValue[][] = [];
  const rowNumbers: number[] = [];
  for (let r = startRow; r <= lastRow; r += 1) {
    const values = columns.map((col) => cells.get(`${colIndexToLetter(col)}${r}`)?.value ?? null);
    if (values.every((v) => v === null || v === '')) continue;
    rows.push(values);
    rowNumbers.push(r);
  }

  return {
    source: 'xlsx',
    sheetName,
    headerRow,
    headers,
    rows,
    rowNumbers,
    columnLetters: columns.map(colIndexToLetter),
  };
}

/** 見出し名から列添字を解決する。完全一致のみ。見つからなければ -1。 */
export function columnIndexOf(table: Table, headerName: string): number {
  const key = normalize(headerName);
  return table.headers.findIndex((h) => normalize(h) === key);
}
