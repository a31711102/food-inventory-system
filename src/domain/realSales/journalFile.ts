/**
 * ジャーナルの読み取り結果ファイルの取込（2026-10-28 追加）。
 *
 * 感熱紙の写真は、影・レシートの重なり・かすれのため端末内OCRの精度に限界がある。
 * そこで、**前工程（店舗オーナー）が別のAIなどで写真を読み取り、その結果をファイルにして渡す**道を用意する。
 * 写真が無くてもこのファイルだけで売上計算を進められる。
 *
 * 受け取る形式は CSV（またはタブ区切り）と JSON の2つ。どちらも項目名と金額の並びでしかない。
 *  - CSV: `項目,金額` の2列。1行目が見出しでもよい。回数など3列目以降は無視する
 *  - JSON: `{"営業月":"2026-09","総計1":6462262,...,"売掛内訳":[{"項目":"menu","金額":13414}]}`
 *
 * 文字コードは UTF-8（BOM 可）と CP932 のどちらでも読む。
 * 値の正しさはこのファイルでは判断できないので、検算①②は従来どおり画面で行う。
 */
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
  { key: 'businessYm', labels: ['営業月', '対象年月', '年月'] },
  { key: 'storeName', labels: ['店舗名', '店舗名称', '店名'] },
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

  const put = (label: string, raw: unknown): void => {
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
    // 上の項目に当てはまらない行は売掛欄の内訳とみなす（表記は画面で照合・修正できる）
    const name = String(label ?? '').trim();
    if (name !== '' && v !== null) out.receivables.push({ label: name, amount: v });
  };

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
          if (label !== '') put(label, value);
        }
      } else {
        put(k, v);
      }
    }
  } else {
    for (const cells of splitRows(text)) {
      const [label, value] = [cells[0] ?? '', cells[1] ?? ''];
      if (fieldOf(label) === null && amount(value) === null && ym(value) === null) continue; // 見出し行など
      put(label, value);
    }
  }

  if (out.grossTotal === null && out.receivables.length === 0) {
    out.issues.push(
      issue('読み取れる項目がありません。「項目,金額」の2列（または JSON）で、総計1・値割引合計・値割引消費税・売掛合計・売掛欄の内訳を並べてください。', fileName),
    );
  }
  return out;
}
