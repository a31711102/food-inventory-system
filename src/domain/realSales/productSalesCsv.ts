/**
 * 商品別売上CSV（POS）の読み取りと、容器対象出数の抽出（要件§11.4）。
 *
 * 実ファイル（2026年8月）で確定した形式:
 *  - 文字コード CP932、見出し1行、12列
 *  - 出数は「販売数」列（要件の「出数」）
 *  - **日付列が無い**。対象月はジャーナルとの検算で確かめる（journal.ts）
 */
import { decodeBytes, detectEncoding, parseCsv } from '../../ingest/csv';
import { IssueCollector, type IssueDetail, type ValidationIssue } from '../issues';
import type { ExtractRule } from './masters';

export interface ProductSalesRow {
  /** CSV 上の行番号（見出しを1行目とする） */
  lineNo: number;
  big: string;
  mid: string;
  small: string;
  code: string;
  name: string;
  qty: number;
  /** 売上金額（列が無ければ null） */
  amount: number | null;
}

export interface ProductSalesFile {
  fileName: string;
  rows: ProductSalesRow[];
  /** 売上金額の合計。列が無ければ null（検算②ができない） */
  amountTotal: number | null;
  issues: ValidationIssue[];
}

/** 列名の別名。要件は「出数」と書くが実ファイルは「販売数」。 */
const COLUMNS = {
  big: ['大分類'],
  mid: ['中分類'],
  small: ['小分類'],
  code: ['商品コード'],
  name: ['商品名'],
  qty: ['販売数', '出数'],
  amount: ['売上金額'],
} as const;

const REQUIRED: (keyof typeof COLUMNS)[] = ['big', 'mid', 'small', 'qty'];

/** 整数として読む。"1,234" も受け付ける。小数・文字は null。 */
function toInt(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^-?\d+$/.test(t)) return null;
  return Number(t);
}

export function readProductSalesCsv(bytes: Uint8Array, fileName: string): ProductSalesFile {
  const issues = new IssueCollector();
  const text = decodeBytes(bytes, detectEncoding(bytes));
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (table.length === 0) {
    issues.add('E018', `商品別売上CSVが空です（${fileName}）。`, { fileName });
    return { fileName, rows: [], amountTotal: null, issues: [...issues.all] };
  }

  const header = table[0]!.map((h) => h.trim());
  const col: Partial<Record<keyof typeof COLUMNS, number>> = {};
  for (const [key, names] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, readonly string[]][]) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) col[key] = i;
  }
  const missing = REQUIRED.filter((k) => col[k] === undefined).map((k) => COLUMNS[k].join('／'));
  if (missing.length > 0) {
    issues.add(
      'E018',
      `商品別売上CSVに必須の列がありません（${missing.join('、')}）。POSから出力した「商品別売上」のCSVか確認してください。`,
      { fileName, rowNo: 1 },
    );
    return { fileName, rows: [], amountTotal: null, issues: [...issues.all] };
  }

  const rows: ProductSalesRow[] = [];
  const badQty: IssueDetail[] = [];
  let amountTotal: number | null = col.amount === undefined ? null : 0;
  let badAmount = false;
  for (let i = 1; i < table.length; i++) {
    const r = table[i]!;
    const lineNo = i + 1;
    const cell = (k: keyof typeof COLUMNS): string => (col[k] === undefined ? '' : (r[col[k]!] ?? '').trim());
    const qty = toInt(cell('qty'));
    if (qty === null) {
      badQty.push({ ref: { fileName, rowNo: lineNo }, text: `${lineNo}行目「${cell('qty')}」` });
      continue;
    }
    let amount: number | null = null;
    if (col.amount !== undefined) {
      amount = toInt(cell('amount'));
      if (amount === null) badAmount = true;
      else if (amountTotal !== null) amountTotal += amount;
    }
    rows.push({
      lineNo,
      big: cell('big'),
      mid: cell('mid'),
      small: cell('small'),
      code: cell('code'),
      name: cell('name'),
      qty,
      amount,
    });
  }
  issues.addMany(
    'E018',
    badQty,
    (n, d) => `商品別売上CSVの販売数が整数として読めない行が ${n} 件あります（${d.slice(0, 5).map((x) => x.text).join(' / ')}）。出数を正しく集計できません。`,
    { fileName },
  );
  if (badAmount) amountTotal = null;

  return { fileName, rows, amountTotal, issues: [...issues.all] };
}

export interface ContainerExtraction {
  included: ProductSalesRow[];
  excluded: ProductSalesRow[];
  qty: number;
  excludedQty: number;
  /** 中分類ごとの対象出数（画面の内訳用） */
  byMid: { mid: string; qty: number; excludedQty: number }[];
  issues: ValidationIssue[];
}

/**
 * 3条件（大分類・中分類・小分類の除外）の AND で対象行を選び、販売数を合計する。
 * 集計後に ÷2 はしない。2品MIX も1個として数える（要件§11.4）。
 */
export function extractContainerQty(file: ProductSalesFile, rule: ExtractRule): ContainerExtraction {
  const issues = new IssueCollector();
  const big = new Set(rule.bigCategories);
  const mid = new Set(rule.midCategories);
  const exclude = new Set(rule.excludeSmall);
  const knownOtherMid = new Set(rule.knownOtherMid);
  const knownSmall = new Set(rule.knownSmall);

  const included: ProductSalesRow[] = [];
  const excluded: ProductSalesRow[] = [];
  const unknownMid = new Map<string, number>();
  const unknownSmall = new Map<string, ProductSalesRow[]>();

  for (const r of file.rows) {
    if (!big.has(r.big)) continue;
    if (!mid.has(r.mid)) {
      if (!knownOtherMid.has(r.mid)) unknownMid.set(r.mid, (unknownMid.get(r.mid) ?? 0) + r.qty);
      continue;
    }
    if (exclude.has(r.small)) {
      excluded.push(r);
      continue;
    }
    if (!knownSmall.has(r.small)) {
      const list = unknownSmall.get(r.small) ?? [];
      list.push(r);
      unknownSmall.set(r.small, list);
    }
    included.push(r);
  }

  const details: IssueDetail[] = [
    ...[...unknownMid].map(([m, q]) => ({
      ref: { fileName: file.fileName },
      text: `中分類「${m}」（出数 ${q}、対象外として数えていません）`,
    })),
    ...[...unknownSmall].map(([s, rs]) => ({
      ref: { fileName: file.fileName, rowNo: rs[0]!.lineNo },
      text: `小分類「${s}」（出数 ${rs.reduce((a, b) => a + b.qty, 0)}、対象として数えています）`,
    })),
  ];
  issues.addMany(
    'W029',
    details,
    (n, d) =>
      `商品別売上CSVに、これまでに無い分類が ${n} 件あります（${d.map((x) => x.text).join(' / ')}）。新商品や分類名の変更なら、抽出条件マスタの更新が必要か確認してください。`,
    { fileName: file.fileName },
  );

  const byMidMap = new Map<string, { qty: number; excludedQty: number }>(rule.midCategories.map((m) => [m, { qty: 0, excludedQty: 0 }]));
  for (const r of included) byMidMap.get(r.mid)!.qty += r.qty;
  for (const r of excluded) byMidMap.get(r.mid)!.excludedQty += r.qty;

  return {
    included,
    excluded,
    qty: included.reduce((a, b) => a + b.qty, 0),
    excludedQty: excluded.reduce((a, b) => a + b.qty, 0),
    byMid: [...byMidMap].map(([m, v]) => ({ mid: m, ...v })),
    issues: [...issues.all],
  };
}
