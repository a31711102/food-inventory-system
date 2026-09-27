/**
 * 発注累計照会と単位計算マスタの取込。
 *
 * どちらも「原材料コード / 原材料名 / 発注数 / 単位 / 計算単位」の形をとる。
 * 原材料コードは数値型（1464 など）で格納されているため、棚卸表の6桁コード（001464）と
 * 突合できるようゼロ埋めして正規化する。この変換は必ず I001 として可視化する。
 */
import type { OrderLine, UnitConversionEntry } from '../domain/models';
import { parseProductCode, type ProductCode } from '../domain/productCode';
import {
  IssueCollector,
  foldByCode,
  summarize,
  type IssueDetail,
  type SourceRef,
  type ValidationIssue,
} from '../domain/issues';
import type { MappingProfile } from './mapping';
import { columnIndexOf, type Table, type CellValue } from './tabular';

export interface ReadTableOptions {
  fileName: string;
}

/** 発注累計照会のヘッダ情報。計算には使わず、取込の妥当性検証と表示に使う。 */
export interface OrderFileMeta {
  storeCodes: string[];
  /** 代表となる集計期間（最初に現れたもの）。期間が混在していれば periods に複数入る */
  periodFrom: string | null;
  periodTo: string | null;
  /** ファイル内に現れた集計期間の異なり。通常は1組だけ */
  periods: { from: string | null; to: string | null }[];
}

export interface ReadOrdersResult {
  lines: OrderLine[];
  meta: OrderFileMeta;
  issues: ValidationIssue[];
}

export interface ReadUnitMasterResult {
  entries: Map<string, UnitConversionEntry>;
  issues: ValidationIssue[];
}

function resolveIndexes(
  table: Table,
  profile: MappingProfile,
  issues: IssueCollector,
  fileName: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  const ref: SourceRef = {
    fileName,
    sheetName: table.sheetName ?? undefined,
    rowNo: table.headerRow,
  };
  const missing: IssueDetail[] = [];
  for (const [field, spec] of Object.entries(profile.columns)) {
    const index = columnIndexOf(table, spec.source);
    out[field] = index;
    if (index < 0 && spec.required) missing.push({ ref, text: `「${spec.source}」` });
  }
  // 種別を取り違えたファイル（例: 発注累計の欄にxlsxの棚卸表）では見出しが1つも読めない。
  // そのとき「実際の見出し: 」と空欄を出すと原因が分からないため、文面を変える。
  const actual =
    table.headers.length > 0
      ? `実際の見出しは ${table.headers.join(' / ')} です`
      : '見出し行を読み取れませんでした';
  issues.addMany('E001', missing, (n, d) =>
    `必須列 ${n} 件が見つかりません（${summarize(d)}）。見出し行は ${table.headerRow} 行目で、${actual}。ファイルの種別を取り違えていないか確認してください。`,
    ref);
  return out;
}

function numberOf(value: CellValue | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number(String(value).replace(/[\s　,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function readOrderTable(
  table: Table,
  profile: MappingProfile,
  options: ReadTableOptions,
): ReadOrdersResult {
  const issues = new IssueCollector();
  const idx = resolveIndexes(table, profile, issues, options.fileName);

  const lines: OrderLine[] = [];
  const badQty: IssueDetail[] = [];
  const storeCodes = new Set<string>();
  // 期間は全行から異なりを集める。1ファイルに複数月が混在していても見逃さないため。
  const periodKeys = new Map<string, { from: string | null; to: string | null }>();

  if (issues.hasBlocking()) {
    return {
      lines,
      meta: { storeCodes: [], periodFrom: null, periodTo: null, periods: [] },
      issues: [...issues.all],
    };
  }

  const textAt = (row: readonly (CellValue | undefined)[], field: string): string | null => {
    const i = idx[field];
    if (i === undefined || i < 0) return null;
    const v = row[i];
    return v === null || v === undefined || v === '' ? null : String(v);
  };

  table.rows.forEach((row, i) => {
    const rowNo = table.rowNumbers[i]!;
    const ref: SourceRef = {
      fileName: options.fileName,
      sheetName: table.sheetName ?? undefined,
      rowNo,
    };

    const store = textAt(row, 'storeCode');
    if (store) storeCodes.add(store);
    const from = textAt(row, 'periodFrom');
    const to = textAt(row, 'periodTo');
    if (from !== null || to !== null) {
      const key = `${from ?? ''}|${to ?? ''}`;
      if (!periodKeys.has(key)) periodKeys.set(key, { from, to });
    }

    const rawCode = row[idx['productCode']!];
    if (rawCode === null || rawCode === '') return;

    const parsed = parseProductCode(rawCode, ref);
    issues.addAll(parsed.issues);
    if (!parsed.code) return;

    const orderQty = numberOf(row[idx['orderQty']!]);
    if (orderQty === null) {
      badQty.push({
        ref: { ...ref, productCode: parsed.code },
        text: `${parsed.code}（行 ${rowNo}、値「${row[idx['orderQty']!]}」）`,
      });
      return;
    }

    lines.push({
      code: parsed.code as ProductCode,
      orderQty,
      conversionFactor: null,
      convertedQty: null,
      factorSource: null,
      isReturn: orderQty < 0,
      lineNo: rowNo,
    });
  });

  issues.addMany('E007', badQty, (n, d) =>
    `発注数を数値に変換できない行が ${n} 件あります（${summarize(d)}）。元ファイルの該当セルに文字や記号が入っていないか確認してください。`,
    { fileName: options.fileName });

  const periods = [...periodKeys.values()];
  return {
    lines,
    meta: {
      storeCodes: [...storeCodes],
      periodFrom: periods[0]?.from ?? null,
      periodTo: periods[0]?.to ?? null,
      periods,
    },
    issues: foldIngestIssues([...issues.all]),
  };
}

export function readUnitMasterTable(
  table: Table,
  profile: MappingProfile,
  options: ReadTableOptions,
): ReadUnitMasterResult {
  const issues = new IssueCollector();
  const idx = resolveIndexes(table, profile, issues, options.fileName);

  const entries = new Map<string, UnitConversionEntry>();
  const dupSame: IssueDetail[] = [];
  const dupConflict: IssueDetail[] = [];
  const badFactor: IssueDetail[] = [];
  if (issues.hasBlocking()) return { entries, issues: [...issues.all] };

  table.rows.forEach((row, i) => {
    const rowNo = table.rowNumbers[i]!;
    const ref: SourceRef = {
      fileName: options.fileName,
      sheetName: table.sheetName ?? undefined,
      rowNo,
    };

    const rawCode = row[idx['productCode']!];
    if (rawCode === null || rawCode === '') return;

    const parsed = parseProductCode(rawCode, ref);
    issues.addAll(parsed.issues);
    if (!parsed.code) return;

    const factor = numberOf(row[idx['factor']!]);
    if (factor === null) {
      badFactor.push({
        ref: { ...ref, productCode: parsed.code },
        text: `${parsed.code}（行 ${rowNo}、値「${row[idx['factor']!]}」）`,
      });
      return;
    }

    const nameIdx = idx['productName']!;
    const unitIdx = idx['unitLabel']!;
    const orderUnitIdx = idx['orderUnit']!;

    // 同一コードが複数行にある場合、黙って上書きしない。
    // 値が食い違うときは換算係数を確定できないため BLOCKING にする。
    const existing = entries.get(parsed.code);
    if (existing) {
      if (existing.factor !== factor) {
        dupConflict.push({
          ref: { ...ref, productCode: parsed.code },
          text: `${parsed.code}（行 ${existing.lineNo} では ${existing.factor}、行 ${rowNo} では ${factor}）`,
        });
        return;
      }
      dupSame.push({
        ref: { ...ref, productCode: parsed.code },
        text: `${parsed.code} ${existing.name}（行 ${existing.lineNo} と ${rowNo}）`,
      });
      return;
    }

    entries.set(parsed.code, {
      code: parsed.code as ProductCode,
      name: nameIdx >= 0 ? String(row[nameIdx] ?? '') : '',
      orderUnit: orderUnitIdx >= 0 ? (numberOf(row[orderUnitIdx]) ?? 1) : 1,
      unitLabel: unitIdx >= 0 ? String(row[unitIdx] ?? '') : '',
      factor,
      lineNo: rowNo,
    });
  });

  const base: SourceRef = { fileName: options.fileName, sheetName: table.sheetName ?? undefined };
  issues.addMany('E012', dupConflict, (n, d) =>
    `単位計算マスタで計算単位が矛盾している原材料コードが ${n} 件あります（${summarize(d)}）。どちらが正しいか確認し、元ファイルを修正して再取込してください。`, base);
  issues.addMany('E007', badFactor, (n, d) =>
    `単位計算マスタの計算単位を数値に変換できない行が ${n} 件あります（${summarize(d)}）。元ファイルの該当セルに文字や記号が入っていないか確認してください。`, base);
  issues.addMany('W014', dupSame, (n, d) =>
    `単位計算マスタに同じ原材料コードが重複している行が ${n} 件あります（${summarize(d)}）。計算単位は同じため、先に現れた行を採用します。`, base);

  return { entries, issues: foldIngestIssues([...issues.all]) };
}

/**
 * 行単位で発行された商品コード・数値の検証を、コードごとに1件へ畳む。
 * 取込処理の出口で必ず通し、「1事象1メッセージ」を担保する。
 */
export function foldIngestIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const rows = (d: readonly IssueDetail[]): string =>
    summarize(d.map((x) => ({ ...x, text: `${x.ref.rowNo}行目` })));
  return foldByCode(issues, ['E003', 'E013', 'I001'], (code, n, d) => {
    switch (code) {
      case 'E003':
        return `商品コードが空欄の行が ${n} 件あります（${rows(d)}）。元ファイルの該当行を確認し、不要な行であれば削除してください。`;
      case 'E013':
        return `商品コードのセルが文字列でも数値でもない行が ${n} 件あります（${rows(d)}）。元ファイルの該当セルを確認してください。`;
      default:
        return `商品コード ${n} 件を正規化しました（数値型で格納されている、前後に空白があるなど）。先頭ゼロが失われている可能性があるため、元ファイルのセル書式を文字列にすることを推奨します。`;
    }
  });
}
