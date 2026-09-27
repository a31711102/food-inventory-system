/**
 * xlsx の読み取りと「外科的」書き戻し。
 *
 * xlsx は ZIP + XML である。ブック全体を再生成するライブラリ（openpyxl 等）と違い、
 * ここでは対象セルの XML だけを差し替え、それ以外のパートをバイト単位でそのまま残す。
 * これにより数式・書式・罫線・印刷範囲・注意事項シートが完全に保たれる（受入条件8）。
 *
 * 書き戻しで J/L/M などのキャッシュ値が古くなるため、workbook.xml に
 * fullCalcOnLoad="1" を立てて Excel が開いた瞬間に再計算するようにする。
 */
import JSZip from 'jszip';
import { colIndexToLetter, colLetterToIndex, parseRef } from './columns';

/**
 * 数式セルへ値を書き込もうとしたときの例外。
 * 呼び出し側が E010 として扱えるよう、専用の型にしている
 * （メッセージ本文にコードを埋め込むと画面でコードが二重表示になるため）。
 */
export class FormulaCellWriteError extends Error {
  constructor(
    readonly sheetName: string,
    readonly ref: string,
    readonly formula: string,
  ) {
    super(
      `${sheetName}!${ref} は数式セル（=${formula}）です。値を書き込むと現行帳票の計算が壊れるため書き込みを中止しました。`,
    );
    this.name = 'FormulaCellWriteError';
  }
}

export interface XlsxCell {
  ref: string;
  row: number;
  col: number;
  /** t 属性（s=共有文字列, str=数式の文字列結果, inlineStr, b, e, n） */
  type: string | null;
  /** 数式（先頭の "=" は含まない）。数式セルでなければ null */
  formula: string | null;
  hasFormula: boolean;
  /** 共有文字列を解決した後の値 */
  value: string | number | boolean | null;
}

interface SheetPart {
  name: string;
  path: string;
  xml: string;
  cells: Map<string, XlsxCell>;
  maxRow: number;
}

type PendingValue =
  | { kind: 'number'; value: number | null }
  | { kind: 'string'; value: string };

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) {
      return String.fromCodePoint(parseInt(entity.slice(1), 10));
    }
    return XML_ENTITIES[entity] ?? whole;
  });
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readAttributes(attrText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of attrText.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

const CELL_PATTERN = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const ROW_PATTERN = /<row\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;

function parseCells(xml: string, sharedStrings: readonly string[]): Map<string, XlsxCell> {
  const cells = new Map<string, XlsxCell>();

  for (const m of xml.matchAll(CELL_PATTERN)) {
    const attrs = readAttributes(m[1]!);
    const ref = attrs['r'];
    if (!ref) continue;
    const inner = m[2] ?? '';
    const type = attrs['t'] ?? null;

    const formulaMatch = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner);
    const selfClosingFormula = /<f\b[^>]*\/>/.test(inner);
    const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
    const inlineMatch = /<is>([\s\S]*?)<\/is>/.exec(inner);

    let value: string | number | boolean | null = null;
    if (inlineMatch) {
      value = extractText(inlineMatch[1]!);
    } else if (valueMatch) {
      const raw = valueMatch[1]!;
      if (type === 's') {
        value = sharedStrings[Number(raw)] ?? '';
      } else if (type === 'str' || type === 'e') {
        value = decodeXml(raw);
      } else if (type === 'b') {
        value = raw === '1';
      } else {
        value = raw === '' ? null : Number(raw);
      }
    }

    const { col, row } = parseRef(ref);
    cells.set(ref, {
      ref,
      row,
      col,
      type,
      formula: formulaMatch ? decodeXml(formulaMatch[1]!) : null,
      hasFormula: Boolean(formulaMatch) || selfClosingFormula,
      value,
    });
  }

  return cells;
}

/**
 * <si> / <is> から表示テキストを取り出す。
 *
 * 日本語版 Excel はセルにふりがなを持たせるため、共有文字列が
 *   <si><t>商品コード</t><rPh sb="0" eb="2"><t>ショウヒン</t></rPh><phoneticPr/></si>
 * という形になる。<rPh> 内の <t> まで拾うと「商品コードショウヒン」となり
 * 列名の突合に失敗するので、ふりがな要素を除いてから本文だけを集める。
 * リッチテキスト（<r><t>…</t></r> の連続）は結合する。
 */
function extractText(fragment: string): string {
  const withoutPhonetic = fragment
    .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '')
    .replace(/<rPh\b[^>]*\/>/g, '')
    .replace(/<phoneticPr\b[^>]*\/?>/g, '');
  return [...withoutPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((t) => decodeXml(t[1]!))
    .join('');
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    out.push(extractText(si[1]!));
  }
  return out;
}

/** 数値を Excel と同じ表記で XML に書く（指数表記を避ける）。 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`数値が不正です: ${value}`);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const s = String(value);
  if (!s.includes('e') && !s.includes('E')) return s;
  // 指数表記になる極端な値のみ固定小数へ
  return value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

export class XlsxWorkbook {
  private constructor(
    private readonly originalBytes: Uint8Array,
    private readonly zip: JSZip,
    private readonly sheets: Map<string, SheetPart>,
    private readonly sheetOrder: string[],
    private readonly workbookXml: string,
    private readonly workbookRelsXml: string,
    private readonly contentTypesXml: string,
  ) {}

  private readonly pending = new Map<string, Map<string, PendingValue>>();
  private readonly addedSheets: { name: string; xml: string; path: string }[] = [];
  private fullCalc = false;

  static async load(data: Uint8Array | ArrayBuffer): Promise<XlsxWorkbook> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const zip = await JSZip.loadAsync(bytes);

    const workbookXml = await readText(zip, 'xl/workbook.xml');
    const workbookRelsXml = await readText(zip, 'xl/_rels/workbook.xml.rels');
    const contentTypesXml = await readText(zip, '[Content_Types].xml');
    const sharedStrings = parseSharedStrings(await readTextOrNull(zip, 'xl/sharedStrings.xml'));

    // rId -> ターゲットパス
    const relTargets = new Map<string, string>();
    for (const m of workbookRelsXml.matchAll(/<Relationship\s+([^>]*?)\/>/g)) {
      const a = readAttributes(m[1]!);
      if (a['Id'] && a['Target']) relTargets.set(a['Id'], a['Target']);
    }

    const sheets = new Map<string, SheetPart>();
    const sheetOrder: string[] = [];
    for (const m of workbookXml.matchAll(/<sheet\s+([^>]*?)\/>/g)) {
      const a = readAttributes(m[1]!);
      const name = decodeXml(a['name'] ?? '');
      const rid = a['r:id'] ?? a['id'] ?? '';
      const target = relTargets.get(rid);
      if (!name || !target) continue;
      const path = target.startsWith('/')
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, '')}`;
      const xml = await readTextOrNull(zip, path);
      if (xml === null) continue;
      const cells = parseCells(xml, sharedStrings);
      let maxRow = 0;
      for (const c of cells.values()) if (c.row > maxRow) maxRow = c.row;
      sheets.set(name, { name, path, xml, cells, maxRow });
      sheetOrder.push(name);
    }

    return new XlsxWorkbook(
      bytes,
      zip,
      sheets,
      sheetOrder,
      workbookXml,
      workbookRelsXml,
      contentTypesXml,
    );
  }

  get sheetNames(): string[] {
    return [...this.sheetOrder, ...this.addedSheets.map((s) => s.name)];
  }

  hasSheet(name: string): boolean {
    return this.sheets.has(name);
  }

  cells(name: string): Map<string, XlsxCell> {
    const sheet = this.sheets.get(name);
    if (!sheet) throw new Error(`シート「${name}」が見つかりません。`);
    return sheet.cells;
  }

  cell(name: string, ref: string): XlsxCell | undefined {
    return this.sheets.get(name)?.cells.get(ref);
  }

  maxRow(name: string): number {
    return this.sheets.get(name)?.maxRow ?? 0;
  }

  /** 数式セルへの書き込みを禁じる。計算済みの列を壊す事故を構造的に防ぐ。 */
  private assertWritable(sheetName: string, ref: string): void {
    const cell = this.sheets.get(sheetName)?.cells.get(ref);
    if (cell?.hasFormula) {
      throw new FormulaCellWriteError(sheetName, ref, cell.formula ?? '');
    }
  }

  private queue(sheetName: string, ref: string, value: PendingValue): void {
    if (!this.sheets.has(sheetName)) {
      throw new Error(`シート「${sheetName}」が見つかりません。`);
    }
    this.assertWritable(sheetName, ref);
    let map = this.pending.get(sheetName);
    if (!map) {
      map = new Map();
      this.pending.set(sheetName, map);
    }
    map.set(ref, value);
  }

  setNumber(sheetName: string, ref: string, value: number | null): void {
    this.queue(sheetName, ref, { kind: 'number', value });
  }

  setString(sheetName: string, ref: string, value: string): void {
    this.queue(sheetName, ref, { kind: 'string', value });
  }

  /** Excel が開いたときに全数式を再計算させる。書き戻しでキャッシュ値が古くなるため必須。 */
  enableFullCalcOnLoad(): void {
    this.fullCalc = true;
  }

  /**
   * 比較シートなどを末尾に追加する。元ファイルのシートには一切触れない。
   *
   * 同じ名前で追加済みなら内容を差し替える。ダウンロードを2回押したときに
   * 「既に存在します」で失敗させないため（画面からは同じ操作を繰り返せる）。
   * 元ファイルに同名のシートがある場合は、そちらを壊さないよう拒否する。
   */
  addSheet(name: string, rows: readonly (readonly (string | number | null)[])[]): void {
    const existing = this.addedSheets.find((s) => s.name === name);
    if (existing) {
      existing.xml = buildSheetXml(rows);
      return;
    }
    if (this.sheetNames.includes(name)) {
      throw new Error(
        `元ファイルに同じ名前のシート「${name}」があるため追加できません。比較シートの名前を変えてください。`,
      );
    }
    const index = this.nextSheetFileIndex() + this.addedSheets.length;
    const path = `xl/worksheets/sheet${index}.xml`;
    this.addedSheets.push({ name, path, xml: buildSheetXml(rows) });
  }

  private nextSheetFileIndex(): number {
    let max = 0;
    for (const file of Object.keys(this.zip.files)) {
      const m = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(file);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  async toUint8Array(): Promise<Uint8Array> {
    // 元のバイト列から読み直す。同じインスタンスで複数回呼んでも結果が変わらないようにするため。
    const out = await JSZip.loadAsync(this.originalBytes);

    // --- 1. セルの差し替え ---
    for (const [sheetName, edits] of this.pending) {
      const sheet = this.sheets.get(sheetName)!;
      const patched = applyCellEdits(sheet.xml, edits, sheet.cells);
      out.file(sheet.path, patched);
    }

    // --- 2. シート追加 ---
    let workbookXml = this.workbookXml;
    let relsXml = this.workbookRelsXml;
    let typesXml = this.contentTypesXml;

    if (this.addedSheets.length > 0) {
      let nextRid = maxRelId(relsXml) + 1;
      let nextSheetId = maxSheetId(workbookXml) + 1;

      for (const added of this.addedSheets) {
        const rid = `rId${nextRid}`;
        nextRid += 1;
        out.file(added.path, added.xml);

        relsXml = relsXml.replace(
          '</Relationships>',
          `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${added.path.replace(/^xl\//, '')}"/></Relationships>`,
        );
        workbookXml = workbookXml.replace(
          '</sheets>',
          `<sheet name="${escapeXml(added.name)}" sheetId="${nextSheetId}" r:id="${rid}"/></sheets>`,
        );
        nextSheetId += 1;
        typesXml = typesXml.replace(
          '</Types>',
          `<Override PartName="/${added.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
        );
      }
      out.file('xl/_rels/workbook.xml.rels', relsXml);
      out.file('[Content_Types].xml', typesXml);
    }

    // --- 3. 開いたときの再計算 ---
    if (this.fullCalc) {
      workbookXml = setFullCalcOnLoad(workbookXml);
    }
    if (workbookXml !== this.workbookXml || this.addedSheets.length > 0) {
      out.file('xl/workbook.xml', workbookXml);
    }

    return out.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }
}

async function readText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`xlsx の必須パートが見つかりません: ${path}`);
  return file.async('string');
}

async function readTextOrNull(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  return file ? file.async('string') : null;
}

function maxRelId(relsXml: string): number {
  let max = 0;
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max;
}

function maxSheetId(workbookXml: string): number {
  let max = 0;
  for (const m of workbookXml.matchAll(/sheetId="(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max;
}

function setFullCalcOnLoad(workbookXml: string): string {
  if (/fullCalcOnLoad="1"/.test(workbookXml)) return workbookXml;
  if (/<calcPr\b/.test(workbookXml)) {
    return workbookXml.replace(/<calcPr\b([^>]*?)(\/?)>/, (_all, attrs: string) => {
      return `<calcPr${attrs} fullCalcOnLoad="1"/>`;
    });
  }
  return workbookXml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
}

/** 既存セルの XML から style 属性だけを引き継いで新しいセル XML を作る。 */
function renderCell(ref: string, value: PendingValue, styleAttr: string): string {
  if (value.kind === 'string') {
    return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value.value)}</t></is></c>`;
  }
  if (value.value === null) {
    return `<c r="${ref}"${styleAttr}/>`;
  }
  return `<c r="${ref}"${styleAttr}><v>${formatNumber(value.value)}</v></c>`;
}

function styleAttrOf(cellXml: string | undefined): string {
  if (!cellXml) return '';
  const m = /\ss="(\d+)"/.exec(cellXml);
  return m ? ` s="${m[1]}"` : '';
}

/**
 * シート XML に対してセル単位の差し替えを行う。
 * 触らない行・触らないセルの XML は文字列として一切変更しない。
 */
function applyCellEdits(
  xml: string,
  edits: ReadonlyMap<string, PendingValue>,
  existing: ReadonlyMap<string, XlsxCell>,
): string {
  // 行番号ごとに編集をまとめる
  const byRow = new Map<number, Map<string, PendingValue>>();
  for (const [ref, value] of edits) {
    const { row } = parseRef(ref);
    let map = byRow.get(row);
    if (!map) {
      map = new Map();
      byRow.set(row, map);
    }
    map.set(ref, value);
  }

  // 同じ列の別行から style を借りるための索引（Excel が省略した空セル対策）
  const styleByColumn = new Map<number, string>();
  for (const m of xml.matchAll(CELL_PATTERN)) {
    const attrs = readAttributes(m[1]!);
    const ref = attrs['r'];
    const s = attrs['s'];
    if (!ref || !s) continue;
    const { col } = parseRef(ref);
    if (!styleByColumn.has(col)) styleByColumn.set(col, ` s="${s}"`);
  }

  const handledRows = new Set<number>();

  let result = xml.replace(ROW_PATTERN, (whole, attrText: string, inner: string | undefined) => {
    const attrs = readAttributes(attrText);
    const rowNo = Number(attrs['r']);
    const rowEdits = byRow.get(rowNo);
    if (!rowEdits) return whole;
    handledRows.add(rowNo);

    const body = inner ?? '';
    const cellXmls: { col: number; ref: string; xml: string }[] = [];
    for (const cm of body.matchAll(CELL_PATTERN)) {
      const ca = readAttributes(cm[1]!);
      const ref = ca['r'];
      if (!ref) continue;
      cellXmls.push({ col: parseRef(ref).col, ref, xml: cm[0] });
    }

    const byRef = new Map(cellXmls.map((c) => [c.ref, c]));

    for (const [ref, value] of rowEdits) {
      const found = byRef.get(ref);
      const style = found
        ? styleAttrOf(found.xml)
        : (styleByColumn.get(parseRef(ref).col) ?? '');
      const rendered = renderCell(ref, value, style);
      if (found) {
        found.xml = rendered;
      } else {
        const entry = { col: parseRef(ref).col, ref, xml: rendered };
        cellXmls.push(entry);
        byRef.set(ref, entry);
      }
    }

    cellXmls.sort((a, b) => a.col - b.col);
    const rowAttrs = attrText.trim();
    return `<row ${rowAttrs}>${cellXmls.map((c) => c.xml).join('')}</row>`;
  });

  // XML に存在しない行への書き込み: <sheetData> 内の正しい位置へ挿入する
  const missingRows = [...byRow.keys()].filter((r) => !handledRows.has(r)).sort((a, b) => a - b);
  for (const rowNo of missingRows) {
    const rowEdits = byRow.get(rowNo)!;
    const cells = [...rowEdits.entries()]
      .map(([ref, value]) => ({
        col: parseRef(ref).col,
        xml: renderCell(ref, value, styleByColumn.get(parseRef(ref).col) ?? ''),
      }))
      .sort((a, b) => a.col - b.col);
    const rowXml = `<row r="${rowNo}">${cells.map((c) => c.xml).join('')}</row>`;

    // 直後に来るべき行の前に挿入する
    let inserted = false;
    result = result.replace(ROW_PATTERN, (whole, attrText: string) => {
      if (inserted) return whole;
      const n = Number(readAttributes(attrText)['r']);
      if (n > rowNo) {
        inserted = true;
        return rowXml + whole;
      }
      return whole;
    });
    if (!inserted) {
      result = result.replace('</sheetData>', `${rowXml}</sheetData>`);
    }
  }

  // 既存セルの参照表を使って未知セルの検出漏れを防ぐ（存在チェックのみ）
  void existing;

  return result;
}

/** 追加シート用の XML を組み立てる。文字列はインライン文字列にして sharedStrings に触れない。 */
function buildSheetXml(rows: readonly (readonly (string | number | null)[])[]): string {
  let maxCol = 1;
  const rowXmls: string[] = [];

  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const cells: string[] = [];
    row.forEach((value, j) => {
      const col = j + 1;
      if (value === null || value === undefined) return;
      if (col > maxCol) maxCol = col;
      const ref = `${colIndexToLetter(col)}${rowNo}`;
      if (typeof value === 'number') {
        cells.push(`<c r="${ref}"><v>${formatNumber(value)}</v></c>`);
      } else {
        cells.push(
          `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`,
        );
      }
    });
    if (cells.length) rowXmls.push(`<row r="${rowNo}">${cells.join('')}</row>`);
  });

  const dimension = `A1:${colIndexToLetter(maxCol)}${Math.max(rows.length, 1)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><sheetData>${rowXmls.join('')}</sheetData></worksheet>`;
}

export { colLetterToIndex, colIndexToLetter };
