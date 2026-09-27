import { describe, it, expect } from 'vitest';
import { XlsxWorkbook } from '@/xlsx/workbook';
import { exportWorkbook, assertExportable, buildFileName, ExportBlockedError } from '@/export/exporter';
import { buildProductComparisonSheet, buildReportComparisonSheet, PRODUCT_SHEET_NAME, REPORT_SHEET_NAME } from '@/export/comparisonSheets';
import { HQ_MASTER_PROFILE } from '@/ingest/profiles';
import { readInventorySheet, toPreviousEntries } from '@/ingest/inventorySheet';
import { buildReport } from '@/domain/report';
import { diffProducts, diffReports } from '@/domain/diff';
import { detectAnomalies } from '@/domain/anomaly';
import { createIssue } from '@/domain/issues';
import { buildSyntheticWorkbook, SAMPLE_ROWS } from '../helpers/buildXlsx';

async function prepare(overrides: Partial<Parameters<typeof exportWorkbook>[0]> = {}) {
  const bytes = await buildSyntheticWorkbook({ rows: SAMPLE_ROWS, totalSales: 5_000_000 });
  const workbook = await XlsxWorkbook.load(bytes);
  const read = readInventorySheet(workbook, HQ_MASTER_PROFILE, {
    fileName: 'master.xlsx',
    approveOpening: true,
  });
  const report = buildReport(read.rows, { targetYm: '2026-09', totalSales: 5_000_000 });
  const previous = toPreviousEntries(read.rows);
  const previousReport = buildReport(read.rows, { targetYm: '2026-08', totalSales: 5_000_000 });

  return {
    workbook,
    profile: HQ_MASTER_PROFILE,
    targetYm: '2026-09',
    previousYm: '2026-08',
    rows: read.rows,
    report,
    productDiffs: diffProducts(read.rows, previous),
    reportDiffs: diffReports(report, previousReport),
    anomalies: detectAnomalies(report, previousReport),
    issues: [],
    ...overrides,
  };
}

describe('数式セルの保護（E010）', () => {
  // 数式列へ書き込もうとした場合、例外をそのまま投げず E010 の ValidationIssue に
  // 変換して返す。画面のエラー一覧に他の指摘と同じ形で並ぶようにするため。
  it('数式列に書き戻す設定になっていると E010 で出力を止める', async () => {
    const input = await prepare();
    // 期末在庫の書き戻し先を、数式が入っている「期中使用量」(J列) に誤設定する
    const broken = {
      ...HQ_MASTER_PROFILE,
      columns: {
        ...HQ_MASTER_PROFILE.columns,
        closingQty: { ...HQ_MASTER_PROFILE.columns['closingQty']!, source: '期中使用量' },
      },
    };

    await expect(exportWorkbook({ ...input, profile: broken })).rejects.toBeInstanceOf(
      ExportBlockedError,
    );
    const err = await exportWorkbook({ ...input, profile: broken }).catch(
      (e: unknown) => e as ExportBlockedError,
    );
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]!.code).toBe('E010');
    expect(err.issues[0]!.level).toBe('BLOCKING');
    expect(err.issues[0]!.ref.cell).toMatch(/^J\d+$/);
  });
});

describe('出力のブロック（受入条件7）', () => {
  it('BLOCKING が1件でもあれば出力しない', () => {
    expect(() =>
      assertExportable([createIssue('E002', '商品コード重複')]),
    ).toThrow(ExportBlockedError);
  });

  it('WARNING だけなら出力できる', () => {
    expect(() => assertExportable([createIssue('W001', '期末残あり')])).not.toThrow();
  });

  it('エラー内容をメッセージに含める', () => {
    try {
      assertExportable([createIssue('E005', '換算未登録です')]);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('E005');
      expect((e as Error).message).toContain('換算未登録です');
    }
  });

  it('exportWorkbook も BLOCKING で止まる', async () => {
    const input = await prepare({ issues: [createIssue('E005', '換算未登録')] });
    await expect(exportWorkbook(input)).rejects.toThrow(ExportBlockedError);
  });

  it('当月売上高が未設定なら E011 で止まる', async () => {
    const base = await prepare();
    const input = { ...base, report: { ...base.report, totalSales: null } };
    await expect(exportWorkbook(input)).rejects.toThrow(/E011/);
  });
});

describe('書き戻し内容', () => {
  it('期末在庫・期中仕入・期首在庫を書き戻す', async () => {
    const input = await prepare();
    const result = await exportWorkbook(input);
    const out = await XlsxWorkbook.load(result.bytes);

    const row = input.rows.find((r) => r.code === '000158')!;
    expect(out.cell('入力用', `G${row.lineNo}`)?.value).toBe(row.closingQty);
    expect(out.cell('入力用', `H${row.lineNo}`)?.value).toBe(row.purchaseQty);
    expect(out.cell('入力用', `I${row.lineNo}`)?.value).toBe(row.openingQty);
  });

  it('自店購入（Aコード）の単価は書き戻す', async () => {
    const input = await prepare();
    const result = await exportWorkbook(input);
    const out = await XlsxWorkbook.load(result.bytes);

    const own = input.rows.find((r) => r.code === 'A00043')!;
    expect(out.cell('入力用', `K${own.lineNo}`)?.value).toBe(own.unitPrice);
  });

  it('当月売上高を分析用 C4 に書き戻す', async () => {
    const input = await prepare();
    const out = await XlsxWorkbook.load((await exportWorkbook(input)).bytes);
    expect(out.cell('分析用', 'C4')?.value).toBe(5_000_000);
  });

  it('ロス額が0のときは空欄のままにする（帳票の見た目を変えない）', async () => {
    const input = await prepare();
    const out = await XlsxWorkbook.load((await exportWorkbook(input)).bytes);
    expect(out.cell('分析用', 'K7')?.value ?? null).toBeNull();
  });

  it('ロス額が入力されていれば書き戻す', async () => {
    const base = await prepare();
    const input = { ...base, report: { ...base.report, lossAmount: 12345 } };
    const out = await XlsxWorkbook.load((await exportWorkbook(input)).bytes);
    expect(out.cell('分析用', 'K7')?.value).toBe(12345);
  });
});

describe('数式・書式の保持（受入条件8）', () => {
  it('J/L/M 列の数式が残る', async () => {
    const input = await prepare();
    const out = await XlsxWorkbook.load((await exportWorkbook(input)).bytes);

    expect(out.cell('入力用', 'J4')?.formula).toBe('SUM(H4:I4)-G4');
    expect(out.cell('入力用', 'L4')?.formula).toBe('K4*J4');
    expect(out.cell('入力用', 'M4')?.formula).toBe('G4*K4');
  });

  it('カテゴリ集計 U/V 列の SUMIF が残る', async () => {
    const input = await prepare();
    const out = await XlsxWorkbook.load((await exportWorkbook(input)).bytes);

    expect(out.cell('入力用', 'U3')?.formula).toBe('SUMIF(N:N,S3,L:L)');
    expect(out.cell('入力用', 'V3')?.formula).toBe('SUMIF(N:N,S3,M:M)');
  });

  it('分析用の集計数式が残る', async () => {
    const input = await prepare();
    const out = await XlsxWorkbook.load((await exportWorkbook(input)).bytes);

    expect(out.cell('分析用', 'C22')?.formula).toBe('SUM(C5:D19)');
    expect(out.cell('分析用', 'L11')?.formula).toBe('K9/C4*100');
    expect(out.cell('分析用', 'K9')?.formula).toBe('C22-K7');
  });

  it('注意事項シートが残る', async () => {
    const input = await prepare();
    const out = await XlsxWorkbook.load((await exportWorkbook(input)).bytes);
    expect(out.hasSheet('注意事項')).toBe(true);
  });

  it('開いたときに再計算するフラグが立つ', async () => {
    const input = await prepare();
    const result = await exportWorkbook(input);
    const text = new TextDecoder().decode(result.bytes);
    // ZIP圧縮されているため直接は読めない。ワークブックを読み直して確認する
    expect(text.length).toBeGreaterThan(0);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(result.bytes);
    const xml = await zip.file('xl/workbook.xml')!.async('string');
    expect(xml).toMatch(/fullCalcOnLoad="1"/);
  });
});

describe('比較シートの付与', () => {
  it('2枚の比較シートを末尾に追加する', async () => {
    const input = await prepare();
    const out = await XlsxWorkbook.load((await exportWorkbook(input)).bytes);

    expect(out.sheetNames).toEqual([
      '注意事項',
      '入力用',
      '分析用',
      PRODUCT_SHEET_NAME,
      REPORT_SHEET_NAME,
    ]);
  });

  it('付与しない指定もできる', async () => {
    const input = await prepare({ includeComparisonSheets: false });
    const out = await XlsxWorkbook.load((await exportWorkbook(input)).bytes);

    expect(out.sheetNames).toEqual(['注意事項', '入力用', '分析用']);
  });

  it('商品別シートの商品コードが文字列で先頭ゼロを保つ', async () => {
    const input = await prepare();
    const out = await XlsxWorkbook.load((await exportWorkbook(input)).bytes);

    expect(out.cell(PRODUCT_SHEET_NAME, 'B2')?.value).toBe('000140');
    expect(typeof out.cell(PRODUCT_SHEET_NAME, 'B2')?.value).toBe('string');
  });
});

describe('比較シートの内容', () => {
  it('商品別: 状態・商品コードから始まる見出しを持つ', () => {
    const rows = buildProductComparisonSheet([]);
    expect(rows[0]!.slice(0, 7)).toEqual([
      '状態',
      '商品コード',
      '商品名(前月)',
      '商品名(当月)',
      '分類(前月)',
      '分類(当月)',
      '属性変更',
    ]);
  });

  it('商品別: 7指標ぶんの前月/当月/差/差率を持つ', () => {
    const rows = buildProductComparisonSheet([]);
    expect(rows[0]!.length).toBe(7 + 7 * 4);
  });

  it('レポート: 前月データがないとき比較不可と書く', () => {
    const rows = buildReportComparisonSheet([], [], { targetYm: '2026-09', previousYm: null });
    expect(JSON.stringify(rows)).toContain('前月データなし（比較不可）');
  });

  it('レポート: ガチャ玉・靴他の除外を注記する', () => {
    const rows = buildReportComparisonSheet([], [], { targetYm: '2026-09', previousYm: '2026-08' });
    expect(JSON.stringify(rows)).toContain('合計（分析用!C22 = SUM(C5:C19)）に含まれない');
  });

  it('レポート: 異常があれば一覧を付ける', () => {
    const rows = buildReportComparisonSheet(
      [],
      [
        {
          scope: 'OVERALL',
          metric: 'COST_RATE_AFTER_LOSS',
          displayName: '全体（ロス引き後原価率）',
          previousPercent: 41.0,
          currentPercent: 43.5,
          diffPt: 3.31,
          thresholdPt: 2.0,
          unit: 'pt',
        },
      ],
      { targetYm: '2026-09', previousYm: '2026-08' },
    );
    expect(JSON.stringify(rows)).toContain('異常一覧');
    expect(JSON.stringify(rows)).toContain('ロス引き後原価率');
  });
});

describe('ファイル名', () => {
  it('対象年月・版・日時を含む', () => {
    const name = buildFileName('2026-09', 2, new Date(2026, 8, 23, 14, 5, 9));
    expect(name).toBe('食品棚卸表_202609_r2_20260923140509.xlsx');
  });
});
