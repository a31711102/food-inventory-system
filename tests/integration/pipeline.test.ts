/**
 * パイプライン全体の通しテスト。
 * 取込 → 期首引継ぎ → 期中仕入 → 自店購入 → 集計 → 比較 → 出力 を一続きで検証する。
 * 実ファイルが無い環境でも回るよう、合成ブックを基本とする。
 */
import { describe, it, expect } from 'vitest';
import { runPipeline, searchOwnPurchaseCandidates } from '@/app/pipeline';
import { XlsxWorkbook } from '@/xlsx/workbook';
import { exportWorkbook } from '@/export/exporter';
import { HQ_MASTER_PROFILE } from '@/ingest/profiles';
import { PRODUCT_SHEET_NAME, REPORT_SHEET_NAME } from '@/export/comparisonSheets';
import { unsafeProductCode } from '@/domain/productCode';
import { buildSyntheticWorkbook, SAMPLE_ROWS, type SyntheticRow } from '../helpers/buildXlsx';

const ORDER_CSV = [
  '原材料コード,原材料名,発注数,単位,計算単位',
  '158,甘口ポークソース２．２ｋｇＲ８,76,袋,1',
  '1868,クリームコロッケ（Ｈ６）,6,袋,40',
  '155,２．２Ｎポークソース４ｋｇＲ６,116,袋,1',
].join('\r\n');

function csvBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 当月マスタ（期末在庫を店舗が入力済み）と前月棚卸表を作る */
async function makeFiles(overrides?: { master?: SyntheticRow[]; previous?: SyntheticRow[] }) {
  const previousRows: SyntheticRow[] =
    overrides?.previous ??
    SAMPLE_ROWS.map((r) => ({ ...r, closingQty: r.closingQty ?? 0 }));
  const masterRows: SyntheticRow[] =
    overrides?.master ??
    SAMPLE_ROWS.map((r) => ({ ...r, openingQty: 0, purchaseQty: 0, closingQty: 3 }));

  return {
    master: {
      fileName: 'master.xlsx',
      bytes: await buildSyntheticWorkbook({ rows: masterRows, totalSales: 5_000_000 }),
    },
    previous: {
      fileName: 'prev.xlsx',
      bytes: await buildSyntheticWorkbook({ rows: previousRows, totalSales: 6000000 }),
    },
    orders: { fileName: 'orders.csv', bytes: csvBytes(ORDER_CSV) },
  };
}

describe('パイプライン通し', () => {
  it('取込から集計まで一続きで動く', async () => {
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      orders: f.orders,
      approveNewOpening: true,
    });

    expect(result.rows).toHaveLength(SAMPLE_ROWS.length);
    expect(result.issues.filter((i) => i.level === 'BLOCKING')).toEqual([]);
    expect(result.hasBlocking).toBe(false);
  });

  it('前月期末が当月期首へ引き継がれる', async () => {
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: true,
    });

    // 000158 の前月期末は 7
    const row = result.rows.find((r) => r.code === '000158')!;
    expect(row.openingQty).toBe(7);
    expect(row.status).toBe('CONTINUED');
  });

  it('発注累計から期中仕入が換算される', async () => {
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      orders: f.orders,
      approveNewOpening: true,
    });

    expect(result.rows.find((r) => r.code === '000158')?.purchaseQty).toBe(76); // 76 × 1
    expect(result.rows.find((r) => r.code === '001868')?.purchaseQty).toBe(240); // 6 × 40
  });

  it('CSVの発注データで商品コードの先頭ゼロを復元して突合する', async () => {
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      orders: f.orders,
      approveNewOpening: true,
    });

    // 発注CSVは "158"、マスタは "000158" だが同一商品として扱われる
    expect(result.issues.filter((i) => i.code === 'W011')).toEqual([]);
    expect(result.issues.filter((i) => i.code === 'I001').length).toBeGreaterThan(0);
  });

  it('自店購入の入力が明細へ反映される', async () => {
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: true,
      ownPurchases: [
        {
          code: unsafeProductCode('A00043'),
          purchaseQty: 24,
          closingQty: 2,
          unitPrice: 273,
          note: null,
        },
      ],
    });

    const row = result.rows.find((r) => r.code === 'A00043')!;
    expect(row.purchaseQty).toBe(24);
    expect(row.closingQty).toBe(2);
    expect(row.unitPrice).toBe(273);
    // 期首(前月期末2) + 仕入24 - 期末2 = 24
    expect(row.usageQty).toBe(24);
    expect(row.usageAmount).toBe(24 * 273);
  });

  it('登録外の商品にも自店購入を入力でき、I004 ではなく I005 で記録される', async () => {
    // 発注累計にも登録リストにも無いのに店舗が買った品（2026年7月の炭酸水など）。
    // 止めずに反映し、あとから追えるよう情報として残す。
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: true,
      ownPurchases: [
        {
          code: unsafeProductCode('000140'),
          purchaseQty: 6,
          closingQty: 1,
          unitPrice: 1791,
          note: '近隣スーパーで購入',
        },
      ],
    });

    const row = result.rows.find((r) => r.code === '000140')!;
    expect(row.purchaseQty).toBe(6);
    expect(row.closingQty).toBe(1);

    const i005 = result.issues.filter((i) => i.code === 'I005');
    expect(i005).toHaveLength(1);
    expect(i005[0]!.message).toContain('000140');
    // 備考を理由として残す
    expect(i005[0]!.message).toContain('近隣スーパーで購入');
  });

  it('登録済みの自店購入品には I005 を出さない', async () => {
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: true,
      ownPurchases: [
        { code: unsafeProductCode('A00043'), purchaseQty: 24, closingQty: 2, unitPrice: 273, note: null },
      ],
    });
    expect(result.issues.filter((i) => i.code === 'I005')).toEqual([]);
  });

  it('備品への自店購入入力は反映せず W024 で知らせる', async () => {
    // 「備品はこの棚卸表で計算しない」を画面の入力で破らせない。
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: true,
      ownPurchases: [
        { code: unsafeProductCode('A10005'), purchaseQty: 99, closingQty: 9, unitPrice: 520, note: null },
      ],
    });

    const row = result.rows.find((r) => r.code === 'A10005')!;
    expect(row.purchaseQty).not.toBe(99);
    expect(row.closingQty).not.toBe(9);

    const w024 = result.issues.filter((i) => i.code === 'W024');
    expect(w024).toHaveLength(1);
    expect(w024[0]!.message).toContain('A10005');
    expect(result.issues.filter((i) => i.code === 'I005')).toEqual([]);
  });

  it('自店購入の候補は備品を除く全商品で、登録済みが先頭に並ぶ', async () => {
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: true,
    });

    const codes = result.ownPurchaseCandidates.map((c) => c.code as string);
    expect(codes).toContain('A00043'); // 登録済み
    expect(codes).toContain('000140'); // 登録外の食材も候補になる
    expect(codes).not.toContain('A10005'); // 備品は出さない

    const sorted = searchOwnPurchaseCandidates(result.ownPurchaseCandidates, '');
    expect(sorted[0]!.registered).toBe(true);
    expect(sorted.at(-1)!.registered).toBe(false);
  });

  it('当月マスタの期末在庫がすべて0なら W025 で知らせる', async () => {
    // 本部から届いたままのファイルを入れてしまう事故。期首＋仕入を全量使い切った
    // 計算になり、原価率が大きく過大になる。
    const f = await makeFiles({
      master: SAMPLE_ROWS.map((r) => ({ ...r, openingQty: 0, purchaseQty: 0, closingQty: 0 })),
    });
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: true,
    });

    const w025 = result.issues.filter((i) => i.code === 'W025');
    expect(w025).toHaveLength(1);
    expect(w025[0]!.message).toContain('期末在庫');
    expect(w025[0]!.message).toContain('すべて0');
  });

  it('期末在庫が1件でも入っていれば W025 は出ない', async () => {
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: true,
    });
    expect(result.issues.filter((i) => i.code === 'W025')).toEqual([]);
  });

  it('新規商品が未承認なら W004 が出る', async () => {
    const f = await makeFiles({
      master: [...SAMPLE_ROWS, { code: '009999', name: '新商品', category: '01.ソース', unitPrice: 100, closingQty: 1 }],
    });
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: false,
    });

    expect(result.newProducts.map((r) => r.code)).toEqual(['009999']);
    expect(result.issues.filter((i) => i.code === 'W004')).toHaveLength(1);
  });

  it('削除商品に前月期末残があれば W001 が出る', async () => {
    const f = await makeFiles({
      previous: [...SAMPLE_ROWS, { code: '008888', name: '廃止商品', category: '01.ソース', unitPrice: 100, closingQty: 5 }],
    });
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: true,
    });

    expect(result.deletedProducts.map((r) => r.code)).toEqual(['008888']);
    expect(result.issues.filter((i) => i.code === 'W001')).toHaveLength(1);
  });

  it('前月データがなければ比較しない', async () => {
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      approveNewOpening: true,
    });

    expect(result.previousReport).toBeNull();
    expect(result.anomalies).toEqual([]);
    expect(result.reportDiffs.every((d) => d.comparable === false)).toBe(true);
  });
});

describe('出力まで通す', () => {
  it('完成Excelを生成し、読み直して値と数式を確認できる', async () => {
    const f = await makeFiles();
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      orders: f.orders,
      approveNewOpening: true,
    });

    const out = await exportWorkbook({
      workbook: result.masterWorkbook,
      profile: HQ_MASTER_PROFILE,
      targetYm: '2026-09',
      previousYm: '2026-08',
      rows: result.rows,
      report: result.report,
      productDiffs: result.productDiffs,
      reportDiffs: result.reportDiffs,
      anomalies: result.anomalies,
      issues: result.issues,
    });

    const reopened = await XlsxWorkbook.load(out.bytes);
    const row = result.rows.find((r) => r.code === '000158')!;

    // 書き戻した入力セル
    expect(reopened.cell('入力用', `I${row.lineNo}`)?.value).toBe(7);
    expect(reopened.cell('入力用', `H${row.lineNo}`)?.value).toBe(76);
    expect(reopened.cell('入力用', `G${row.lineNo}`)?.value).toBe(3);
    // 触っていない数式セル
    expect(reopened.cell('入力用', `J${row.lineNo}`)?.formula).toBe(`SUM(H${row.lineNo}:I${row.lineNo})-G${row.lineNo}`);
    // 比較シート
    expect(reopened.sheetNames).toContain(PRODUCT_SHEET_NAME);
    expect(reopened.sheetNames).toContain(REPORT_SHEET_NAME);
    // ファイル名
    expect(out.fileName).toMatch(/^食品棚卸表_202609_r1_\d{14}\.xlsx$/);
  });

  it('出力したExcelを再取込すると同じ数値になる（往復の一貫性）', async () => {
    const f = await makeFiles();
    const first = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      orders: f.orders,
      approveNewOpening: true,
    });

    const out = await exportWorkbook({
      workbook: first.masterWorkbook,
      profile: HQ_MASTER_PROFILE,
      targetYm: '2026-09',
      previousYm: '2026-08',
      rows: first.rows,
      report: first.report,
      productDiffs: first.productDiffs,
      reportDiffs: first.reportDiffs,
      anomalies: first.anomalies,
      issues: first.issues,
      includeComparisonSheets: false,
    });

    const second = await runPipeline({
      targetYm: '2026-09',
      master: { fileName: out.fileName, bytes: out.bytes },
      previous: f.previous,
      approveNewOpening: true,
    });

    expect(second.rows.map((r) => [r.code, r.openingQty, r.purchaseQty, r.closingQty])).toEqual(
      first.rows.map((r) => [r.code, r.openingQty, r.purchaseQty, r.closingQty]),
    );
    expect(second.report.totalUsageAmount).toBe(first.report.totalUsageAmount);
  });

  it('BLOCKING があると出力を拒否する', async () => {
    const f = await makeFiles({
      master: [...SAMPLE_ROWS, { ...SAMPLE_ROWS[0]!, name: '重複した商品' }],
    });
    const result = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      approveNewOpening: true,
    });

    expect(result.issues.some((i) => i.code === 'E002')).toBe(true);
    await expect(
      exportWorkbook({
        workbook: result.masterWorkbook,
        profile: HQ_MASTER_PROFILE,
        targetYm: '2026-09',
        previousYm: '2026-08',
        rows: result.rows,
        report: result.report,
        productDiffs: result.productDiffs,
        reportDiffs: result.reportDiffs,
        anomalies: result.anomalies,
        issues: result.issues,
      }),
    ).rejects.toThrow(/E002/);
  });
});

describe('同一ファイル検知（W008 / W022）', () => {
  it('当月マスタと前月ファイルに同じ内容を指定すると W022 を出す', async () => {
    const f = await makeFiles();
    const r = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      // ファイル名は違うが中身が同じ（コピーを取り違えた状況）
      previous: { fileName: 'master (1).xlsx', bytes: f.master.bytes },
      approveNewOpening: true,
    });

    const w022 = r.issues.filter((i) => i.code === 'W022');
    expect(w022).toHaveLength(1);
    expect(w022[0]!.message).toContain('当月本部マスタ棚卸表 と 前月食品棚卸表');
  });

  it('正しく別々のファイルなら W022 は出ない', async () => {
    const f = await makeFiles();
    const r = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      orders: f.orders,
      approveNewOpening: true,
    });
    expect(r.issues.filter((i) => i.code === 'W022')).toEqual([]);
  });

  it('取込履歴に同じ内容が別の年月で残っていれば W008 を出す', async () => {
    const f = await makeFiles();
    const first = await runPipeline({
      targetYm: '2026-08',
      master: f.master,
      approveNewOpening: true,
    });
    // 前月の処理で使ったファイルを、今月の当月マスタ欄にそのまま指定してしまった状況
    const second = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      importHistory: first.importedFiles,
      approveNewOpening: true,
    });

    const w008 = second.issues.filter((i) => i.code === 'W008');
    expect(w008).toHaveLength(1);
    expect(w008[0]!.message).toContain('2026-08');
    expect(second.hasBlocking).toBe(false); // 警告であり処理は止めない
  });

  it('同じ年月で取り直しても W008 は出ない', async () => {
    const f = await makeFiles();
    const first = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      approveNewOpening: true,
    });
    const again = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      importHistory: first.importedFiles,
      approveNewOpening: true,
    });
    expect(again.issues.filter((i) => i.code === 'W008')).toEqual([]);
  });

  it('取り込んだファイルのハッシュを結果に残す', async () => {
    const f = await makeFiles();
    const r = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      previous: f.previous,
      orders: f.orders,
      approveNewOpening: true,
    });

    expect(r.importedFiles.map((x) => x.kind)).toEqual(['master', 'previous', 'orders']);
    for (const rec of r.importedFiles) {
      expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.targetYm).toBe('2026-09');
    }
  });
});

describe('新規商品の期首承認（W004）', () => {
  it('承認済みの商品は W004 の対象から外れ、件数が減る', async () => {
    const f = await makeFiles();
    const before = await runPipeline({ targetYm: '2026-09', master: f.master });
    const w004 = before.issues.filter((i) => i.code === 'W004');
    expect(w004).toHaveLength(1);
    expect(w004[0]!.count).toBeGreaterThan(1);

    // 内訳の先頭1件だけを承認する
    const approved = new Set([w004[0]!.details[0]!.ref.productCode!]);
    const after = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      approvedOpeningCodes: approved,
    });
    const w004After = after.issues.filter((i) => i.code === 'W004');

    expect(w004After).toHaveLength(1);
    expect(w004After[0]!.count).toBe(w004[0]!.count - 1);
    expect(w004After[0]!.details.map((d) => d.ref.productCode)).not.toContain([...approved][0]);
  });

  it('全件承認すると W004 自体が消える', async () => {
    const f = await makeFiles();
    const before = await runPipeline({ targetYm: '2026-09', master: f.master });
    const all = new Set(
      before.issues
        .filter((i) => i.code === 'W004')
        .flatMap((i) => i.details.map((d) => d.ref.productCode!)),
    );

    const after = await runPipeline({
      targetYm: '2026-09',
      master: f.master,
      approvedOpeningCodes: all,
    });
    expect(after.issues.filter((i) => i.code === 'W004')).toEqual([]);
  });
});
