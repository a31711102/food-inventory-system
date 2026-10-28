/**
 * ジャーナルの読み取り結果ファイルの取込（2026-10-28 追加）。
 *
 * 感熱紙の写真は端末内OCRでは読み切れないため、**前工程（店舗オーナー）が読み取った結果を
 * ファイルで受け取る**。写真が無くてもこのファイルだけで売上計算を進められる。
 *
 * 受け取る形式は3つ。
 *  - **Excel**: 店舗オーナーが使っている「リアル売上算出」シートをそのまま
 *  - CSV（タブ区切り可）: `項目,金額` の2列。1行目が見出しでもよい
 *  - JSON: `{"営業月":"2026-09","総計1":6462262,...,"売掛内訳":[{"項目":"menu","金額":13414}]}`
 *
 * **位置では読まない。** どの形式でも、セルの文字列を項目名と照合して値を取る。
 * Excel は行や列の位置が変わりやすく、オーナーが表を足したり動かしたりするため、
 * 「A2 が営業年月」「B列が売上」といった決め打ちはしない（2026-10-28 店舗オーナー指示）。
 *
 * 文字コードは UTF-8（BOM 可）と CP932 のどちらでも読む。
 * 値の正しさはこのファイルでは判断できないので、検算①②は従来どおり画面で行う。
 */
import { XlsxWorkbook } from '../../xlsx/workbook';
import { createIssue, type ValidationIssue } from '../issues';
import { normalizeLabel } from './masters';

export interface JournalFileLine {
  label: string;
  amount: string;
}

export interface JournalFileResult {
  businessYm: string | null;
  storeName: string | null;
  grossTotal: string | null;
  discountTotal: string | null;
  discountTax: string | null;
  receivableTotal: string | null;
  /** 売掛欄の内訳（上の項目に当てはまらなかった行） */
  receivables: JournalFileLine[];
  issues: ValidationIssue[];
}

/** 項目名の表記ゆれ。読み取り結果ファイルは人・AIが作るので、ある程度の揺れを受ける */
const FIELDS: { key: 'businessYm' | 'storeName' | 'grossTotal' | 'discountTotal' | 'discountTax' | 'receivableTotal'; labels: string[] }[] = [
  { key: 'businessYm', labels: ['営業月', '営業年月', '対象年月', '年月', '売上年月'] },
  { key: 'storeName', labels: ['店舗名', '店舗名称', '店名'] },
  // 「総計１」は全角。normalizeLabel の NFKC で半角にそろう
  { key: 'grossTotal', labels: ['総計1(税抜値割引前)', '総計1', '総計１', '税抜値割引前'] },
  { key: 'discountTotal', labels: ['値割引合計', '値引合計', '割引合計'] },
  { key: 'discountTax', labels: ['値割引消費税', '値引消費税', '割引消費税'] },
  { key: 'receivableTotal', labels: ['売掛合計', '売掛', '売掛金合計'] },
];

function decode(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^﻿/, '');
  // UTF-8 として読めない文字が混じるなら CP932 とみなす（発注累計照会と同じ考え方）
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('shift_jis', { fatal: false }).decode(bytes);
}

/** 「¥1,234」「1234円」→ 「1234」。数字が無ければ null */
function amount(text: unknown): string | null {
  if (typeof text === 'number') return Number.isFinite(text) && Number.isInteger(text) ? String(text) : null;
  if (typeof text !== 'string') return null;
  const t = text.replace(/[,，\s¥￥円]/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : null;
}

/** 「2026-09」「2026/9」「2026年9月」→ 「2026-09」 */
function ym(text: unknown): string | null {
  const t = String(text ?? '').replace(/\s/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = /(20\d{2})[-/年.](\d{1,2})/.exec(t);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${m[1]}-${String(month).padStart(2, '0')}` : null;
}

function fieldOf(label: string): (typeof FIELDS)[number]['key'] | null {
  const a = normalizeLabel(label).replace(/[^\p{L}\p{N}・]/gu, '');
  if (!a) return null;
  for (const f of FIELDS) {
    for (const l of f.labels) {
      const b = normalizeLabel(l).replace(/[^\p{L}\p{N}・]/gu, '');
      if (a === b) return f.key;
    }
  }
  return null;
}

/** 1行を区切る。二重引用符でくくった中の区切り文字は無視する（"¥1,234,567" のような値） */
function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c !== '"') cur += c;
      else if (line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

function splitRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => splitLine(line, line.includes('\t') ? '\t' : ','));
}

function issue(message: string, fileName: string): ValidationIssue {
  return createIssue('E022', message, { fileName });
}

/** 項目名で振り分けて入れる。当てはまらない行は売掛欄の内訳とみなす */
function put(out: JournalFileResult, label: string, raw: unknown): void {
  const key = fieldOf(label);
  if (key === 'storeName') {
    out.storeName = String(raw ?? '').trim() || null;
    return;
  }
  if (key === 'businessYm') {
    out.businessYm = ym(raw);
    return;
  }
  const v = amount(raw);
  if (key) {
    out[key] = v;
    return;
  }
  const name = String(label ?? '').trim();
  if (name !== '' && v !== null) out.receivables.push({ label: name, amount: v });
}

export function readJournalFile(bytes: Uint8Array, fileName: string): JournalFileResult {
  const out: JournalFileResult = {
    businessYm: null, storeName: null, grossTotal: null, discountTotal: null, discountTax: null,
    receivableTotal: null, receivables: [], issues: [],
  };
  const text = decode(bytes).trim();
  if (text === '') {
    out.issues.push(issue('ファイルが空です。前工程で作った読み取り結果を指定してください。', fileName));
    return out;
  }

  const put2 = (label: string, raw: unknown): void => put(out, label, raw);

  if (text.startsWith('{') || text.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      out.issues.push(issue('JSON として読めません。前工程の出力をそのまま保存したか確認してください。', fileName));
      return out;
    }
    const obj = (Array.isArray(data) ? {} : data) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) {
        for (const row of v) {
          const r = row as Record<string, unknown>;
          const label = String(r['項目'] ?? r['表記'] ?? r['label'] ?? r['name'] ?? '').trim();
          const value = r['金額'] ?? r['amount'] ?? r['value'];
          if (label !== '') put2(label, value);
        }
      } else {
        put2(k, v);
      }
    }
  } else {
    for (const cells of splitRows(text)) {
      const [label, value] = [cells[0] ?? '', cells[1] ?? ''];
      if (fieldOf(label) === null && amount(value) === null && ym(value) === null) continue; // 見出し行など
      put2(label, value);
    }
  }

  if (out.grossTotal === null && out.receivables.length === 0) {
    out.issues.push(
      issue('読み取れる項目がありません。「項目,金額」の2列（または JSON）で、総計1・値割引合計・値割引消費税・売掛合計・売掛欄の内訳を並べてください。', fileName),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Excel（店舗オーナーの「リアル売上算出」シート）
// ---------------------------------------------------------------------------

/** 表の見出しとして現れる語。これらは項目名でも売掛の内訳でもない */
const HEADER_WORDS = ['チャンネル', 'チャネル', '項目', '表記', '売上', '金額', '手数料率', '手数料額', '出数', '控除額単価', '控除額計', '備考'];
/** 計算結果の行。読み取らない（システムが計算し直すため） */
const RESULT_WORDS = ['計', '合計', '小計', '差引金額', 'リアル売上', '手数料計', '控除額計', '分析表売上'];
/** 表以外の見出し・注記 */
const TITLE_WORDS = ['リアル売上計算シート', '弁当容器個数計算'];

const norm = (t: string): string => normalizeLabel(t).replace(/[^\p{L}\p{N}・]/gu, '');

function isAny(text: string, words: string[]): boolean {
  const a = norm(text);
  return a !== '' && words.some((w) => norm(w) === a);
}

/** 「売上」の列を見出しの文字で決める。列の位置は決め打ちしない */
function amountColumnOf(row: (string | null)[], labelCol: number): number | null {
  for (let c = labelCol + 1; c < row.length; c++) {
    const t = row[c] ?? '';
    if (isAny(t, ['売上', '金額'])) return c;
  }
  return null;
}

/**
 * Excel のシートを「文字列の照合」だけで読む。
 *
 *  1. 行の中に項目名（営業年月・総計1 など）があれば、その右隣の値を取る
 *  2. 「チャンネル」と「売上」が並ぶ見出し行を見つけたら、その下の行を売掛欄の内訳として読む
 *     （金額は見出し「売上」の列から取る。列の位置は見出しの文字で決める）
 *  3. 「出数」の表（弁当容器の個数計算）は読まない。出数は商品別売上CSVから数える
 *  4. 「計」「差引金額」「リアル売上」などの計算結果は読まない
 */
export async function readJournalWorkbook(bytes: Uint8Array, fileName: string): Promise<JournalFileResult> {
  const out: JournalFileResult = {
    businessYm: null, storeName: null, grossTotal: null, discountTotal: null, discountTax: null,
    receivableTotal: null, receivables: [], issues: [],
  };
  let wb: XlsxWorkbook;
  try {
    wb = await XlsxWorkbook.load(bytes);
  } catch {
    out.issues.push(issue('Excel として読めません。前工程で作ったファイルを指定してください。', fileName));
    return out;
  }

  for (const sheetName of wb.sheetNames) {
    // セルを行ごとに並べ直す（位置は使わず、並びだけを使う）
    const rows = new Map<number, (string | null)[]>();
    for (const cell of wb.cells(sheetName).values()) {
      const line = rows.get(cell.row) ?? [];
      line[cell.col - 1] = cell.value === null || cell.value === undefined ? null : String(cell.value);
      rows.set(cell.row, line);
    }
    const numbers = [...rows.keys()].sort((a, b) => a - b);

    /** 売掛欄の内訳を読んでいる最中なら、金額の列。読んでいないなら null */
    let salesCol: number | null = null;

    for (const n of numbers) {
      const row = rows.get(n)!;
      // 歯抜けのまま map すると穴が残るので、長さを決めて詰め直す
      const cells = Array.from({ length: row.length }, (_, i) => (row[i] ?? '').trim());
      const first = cells.findIndex((c) => c !== '');
      if (first < 0) {
        salesCol = null; // 空行で表の終わり
        continue;
      }
      const label = cells[first]!;

      // 見出し行: 「チャンネル … 売上」なら内訳の表が始まる。「出数」の表は読まない
      if (isAny(label, HEADER_WORDS)) {
        const hasQty = cells.some((c) => isAny(c, ['出数']));
        salesCol = hasQty ? null : amountColumnOf(cells, first);
        continue;
      }
      if (isAny(label, TITLE_WORDS)) {
        salesCol = null;
        continue;
      }
      if (isAny(label, RESULT_WORDS) || cells.some((c) => isAny(c, RESULT_WORDS))) continue;

      // 項目名（営業年月・総計1 など）は右隣の値を取る
      const key = fieldOf(label);
      if (key !== null) {
        const value = cells.slice(first + 1).find((c) => c !== '');
        put(out, label, value ?? '');
        continue;
      }

      // 内訳の表の中なら、見出し「売上」の列から金額を取る
      if (salesCol !== null) {
        const v = amount(cells[salesCol] ?? '');
        if (v !== null) out.receivables.push({ label, amount: v });
      }
    }
  }

  if (out.grossTotal === null && out.receivables.length === 0) {
    out.issues.push(
      issue('読み取れる項目がありません。「営業年月」「総計1」と、「チャンネル／売上」の表がある Excel か確認してください。', fileName),
    );
  }
  return out;
}

/** 拡張子と中身から形式を見分けて取り込む */
export async function readJournalUpload(bytes: Uint8Array, fileName: string): Promise<JournalFileResult> {
  // xlsx は ZIP。先頭が PK なら Excel として読む
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  return isZip ? readJournalWorkbook(bytes, fileName) : readJournalFile(bytes, fileName);
}
