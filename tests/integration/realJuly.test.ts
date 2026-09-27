/**
 * 2026年6月→7月の実データによる検証。
 *
 * 前月比較・異常判定・期首引継ぎを実データで通せる初めてのケース（要件§10-3）。
 * 実ファイルは店舗の実データを含むためリポジトリにはコミットしない。無ければスキップする。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPipeline, type PipelineResult, type UploadedFile } from '@/app/pipeline';
import { XlsxWorkbook } from '@/xlsx/workbook';
import { readInventorySheet } from '@/ingest/inventorySheet';
import { HQ_MASTER_PROFILE } from '@/ingest/profiles';
import { buildReport } from '@/domain/report';
import { diffProducts, diffReports } from '@/domain/diff';
import { detectAnomalies, type Anomaly } from '@/domain/anomaly';
import type { ReportValues } from '@/domain/models';
import type { ProductDiffRow, ReportDiffRow } from '@/domain/diff';
import { REAL_EXPECTED, REAL_EXPECTED_STORE } from '../helpers/realExpected';

const JUL_DIR = process.env['REAL_JULY'] ?? join('C:', 'Users', 'kimi4', 'Downloads', '7月原価計算', '7月原価計算');
const JUN_DIR = process.env['REAL_JUNE'] ?? join('C:', 'Users', 'kimi4', 'Downloads', '原価計算', '原価計算');
const AUG_DIR = process.env['REAL_FIXTURES'] ?? join('C:', 'Users', 'kimi4', 'Downloads', '棚卸表設計', '棚卸表設計');

const F = {
  junResult: join(JUN_DIR, '【結果】営業-2026.6月食材レジ前商品棚卸表.xlsx'),
  junPrev: join(JUL_DIR, '【前月食品棚卸表】営業-2026.6月食材レジ前商品棚卸表.xlsx'),
  julMaster: join(JUL_DIR, '【当月マスタ】営業-2026.7月食材レジ前商品棚卸表.xlsx'),
  julResult: join(JUL_DIR, '【結果】営業-2026.7月食材レジ前商品棚卸表 - コピー.xlsx'),
  julOrders: join(JUL_DIR, '発注累計照会_2026.7月.csv'),
  julUnitCsv: join(JUL_DIR, '発注累計計算単位.csv'),
  unitMaster: join(AUG_DIR, '【単位計算マスタ】発注品計算単位マスタ.xlsx'),
};

/**
 * 7月・6月の正解値（【結果】ファイルの分析用シート）。
 * 店舗の実業績値はリポジトリに含めないため、tests/fixtures/real/expected.json から読む。
 * 未配置ならこのファイルのテストはすべてスキップする。
 */
const JULY_EXPECTED = REAL_EXPECTED?.july;
const JUNE_EXPECTED = REAL_EXPECTED?.june;

const available =
  Object.values(F).every((p) => existsSync(p)) && JULY_EXPECTED !== undefined && JUNE_EXPECTED !== undefined;

function load(path: string, name?: string): UploadedFile {
  return { fileName: name ?? path.split(/[\\/]/).pop()!, bytes: new Uint8Array(readFileSync(path)) };
}

describe.skipIf(!available)('2026年6月→7月 実データ検証', () => {
  /**
   * 計算エンジンの検証は、完成版ファイルの G/H/I をそのまま使って行う。
   * パイプラインを通すと期首引継ぎが走って帳票の期首を上書きしてしまい、
   * 「帳票を再現できるか」の検証にならないため、取込＋集計だけを直接呼ぶ。
   */
  let julReport: ReportValues;
  let junReport: ReportValues;
  let julRows: Awaited<ReturnType<typeof readInventorySheet>>['rows'];
  let reportDiffs: ReportDiffRow[];
  let productDiffs: ProductDiffRow[];
  let anomalies: Anomaly[];
  /** 7月の白紙マスタ＋6月完成版で、引継ぎと差分を見る */
  let julFromMaster: PipelineResult;

  beforeAll(async () => {
    const julWb = await XlsxWorkbook.load(new Uint8Array(readFileSync(F.julResult)));
    const jul = readInventorySheet(julWb, HQ_MASTER_PROFILE, {
      fileName: '7月結果.xlsx', approveOpening: true,
    });
    const junWb = await XlsxWorkbook.load(new Uint8Array(readFileSync(F.junResult)));
    const jun = readInventorySheet(junWb, HQ_MASTER_PROFILE, {
      fileName: '6月結果.xlsx', approveOpening: true,
    });
    julRows = jul.rows;
    julReport = buildReport(jul.rows, {
      targetYm: '2026-07', totalSales: jul.analysis.totalSales, lossAmount: jul.analysis.lossAmount ?? 0,
    });
    junReport = buildReport(jun.rows, {
      targetYm: '2026-06', totalSales: jun.analysis.totalSales, lossAmount: jun.analysis.lossAmount ?? 0,
    });
    reportDiffs = diffReports(julReport, junReport);
    productDiffs = diffProducts(
      jul.rows,
      jun.rows.map((r) => ({
        code: r.code, name: r.name, category: r.category, unitPrice: r.unitPrice,
        closingQty: r.closingQty, purchaseQty: r.purchaseQty, openingQty: r.openingQty,
        usageQty: r.usageQty, usageAmount: r.usageAmount, closingAmount: r.closingAmount,
        lineNo: r.lineNo,
      })),
    );
    anomalies = detectAnomalies(julReport, junReport);

    julFromMaster = await runPipeline({
      targetYm: '2026-07',
      master: load(F.julMaster, '7月マスタ.xlsx'),
      previous: load(F.junResult, '6月結果.xlsx'),
      orders: load(F.julOrders),
      unitMaster: load(F.unitMaster),
      approveNewOpening: true,
      totalSalesOverride: JULY_EXPECTED!.totalSales,
    });
  });

  describe('取込', () => {
    it('7月は254商品、6月は234商品を読む', () => {
      expect(julRows).toHaveLength(254);
      expect(julFromMaster.previousEntries).toHaveLength(234);
    });

    it('商品数が月によって変わっても取り込める', () => {
      // 6月234 → 7月254 → 8月266 と毎月変わる
      expect(julRows.length).not.toBe(julFromMaster.previousEntries.length);
    });

    it('BLOCKING が出ない', () => {
      expect(julFromMaster.issues.filter((i) => i.level === 'BLOCKING').map((i) => i.message)).toEqual([]);
    });

    it('商品コードは全件6桁の文字列', () => {
      expect(julRows.every((r) => typeof r.code === 'string' && r.code.length === 6)).toBe(true);
    });
  });

  describe('7月の管理レポートが現行帳票と一致する（受入条件5）', () => {
    it('当月売上高を分析用 C4 から読む', () => {
      expect(julReport.totalSales).toBe(JULY_EXPECTED!.totalSales);
    });

    it('使用高合計が【結果】ファイルと一致する', () => {
      expect(julReport.totalUsageAmount).toBeCloseTo(JULY_EXPECTED!.totalUsageAmount, 6);
    });

    it('食材期末在庫計が【結果】ファイルと一致する', () => {
      expect(julReport.totalClosingAmount).toBeCloseTo(JULY_EXPECTED!.totalClosingAmount!, 6);
    });

    it('ロス引き後原価率が【結果】ファイルと一致する', () => {
      expect(julReport.costRateAfterLossPercent).toBeCloseTo(
        JULY_EXPECTED!.costRateAfterLossPercent,
        8,
      );
    });

    it('サラダ野菜使用高が【結果】ファイルと一致する', () => {
      expect(julReport.saladVegetableUsage).toBeCloseTo(JULY_EXPECTED!.saladVegetableUsage, 6);
    });

    it('検算（6月ファイル）が通り W010 が出ない', () => {
      expect(julFromMaster.issues.filter((i) => i.code === 'W010').map((i) => i.message)).toEqual([]);
    });

    it('明細の当月使用高がExcelのキャッシュ値と全件一致する', async () => {
      const wb = await XlsxWorkbook.load(new Uint8Array(readFileSync(F.julResult)));
      const mismatches: string[] = [];
      for (const row of julRows) {
        const excel = wb.cell('入力用', `L${row.lineNo}`)?.value;
        if (typeof excel === 'number' && Math.abs(excel - (row.usageAmount ?? 0)) > 1e-6) {
          mismatches.push(`${row.code}: system=${row.usageAmount} excel=${excel}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  describe('6月のレポート値も再現する', () => {
    it('6月の使用高合計と原価率が一致する', () => {
      const prev = junReport;
      expect(prev.totalUsageAmount).toBeCloseTo(JUNE_EXPECTED!.totalUsageAmount, 6);
      expect(prev.costRateAfterLossPercent).toBeCloseTo(JUNE_EXPECTED!.costRateAfterLossPercent, 8);
      expect(prev.saladVegetableUsage).toBeCloseTo(JUNE_EXPECTED!.saladVegetableUsage, 6);
    });
  });

  describe('期首引継ぎ（6月期末 → 7月期首）', () => {
    it('7月マスタは期首・期中仕入・期末がすべて空', async () => {
      const wb = await XlsxWorkbook.load(new Uint8Array(readFileSync(F.julMaster)));
      const read = readInventorySheet(wb, HQ_MASTER_PROFILE, { fileName: '7月マスタ.xlsx' });
      expect(read.rows.every((r) => r.openingQty === 0 && r.purchaseQty === 0 && r.closingQty === 0)).toBe(true);
    });

    it('継続商品の期首がすべて6月の期末と一致する', () => {
      const prevByCode = new Map(julFromMaster.previousEntries.map((p) => [p.code as string, p]));
      const mismatches = julFromMaster.rows
        .filter((r) => prevByCode.has(r.code))
        .filter((r) => r.openingQty !== prevByCode.get(r.code)!.closingQty)
        .map((r) => r.code);
      expect(mismatches).toEqual([]);
    });

    it('引き継いだ期首が、現行7月帳票の期首と225/229一致する', async () => {
      // 残り4件は現行側の手修正。差の内訳を固定して、変化したら気づけるようにする。
      const wb = await XlsxWorkbook.load(new Uint8Array(readFileSync(F.julResult)));
      const sheetOpening = new Map<string, number>();
      for (const row of julRows) {
        const v = wb.cell('入力用', `I${row.lineNo}`)?.value;
        sheetOpening.set(row.code, typeof v === 'number' ? v : 0);
      }
      const prevCodes = new Set(julFromMaster.previousEntries.map((p) => p.code as string));
      const diffs = julFromMaster.rows
        .filter((r) => prevCodes.has(r.code))
        .filter((r) => r.openingQty !== sheetOpening.get(r.code))
        .map((r) => `${r.code}:${r.openingQty}→${sheetOpening.get(r.code)}`)
        .sort();

      expect(diffs).toEqual([
        '005927:0→1',
        '006738:0→1',
        '007420:1→0',
        '007423:0→195',
      ]);
    });
  });

  describe('商品差分（6月→7月）', () => {
    it('継続229・新規25・削除5になる', () => {
      expect(julFromMaster.newProducts).toHaveLength(25);
      expect(julFromMaster.deletedProducts).toHaveLength(5);
      expect(julFromMaster.rows.length - julFromMaster.newProducts.length).toBe(229);
    });

    it('新規商品の期首はすべて0', () => {
      expect(julFromMaster.newProducts.every((r) => r.openingQty === 0)).toBe(true);
    });

    it('削除5件はいずれも6月期末残が0なので W001 が出ない', () => {
      expect(julFromMaster.deletedProducts.every((p) => p.closingQty === 0)).toBe(true);
      expect(julFromMaster.issues.filter((i) => i.code === 'W001')).toEqual([]);
    });

    it('夏企画の新規商品が新規として検出される', () => {
      const codes = julFromMaster.newProducts.map((r) => r.code as string);
      expect(codes).toContain('041296'); // ドリンク景品第１弾（夏企画）
      expect(codes).toContain('041330'); // カレー提供付属品セット(夏企画)
    });

    it('削除商品が当月の計算対象から外れる', () => {
      const codes = new Set(julFromMaster.rows.map((r) => r.code as string));
      for (const p of julFromMaster.deletedProducts) {
        expect(codes.has(p.code)).toBe(false);
      }
    });
  });

  describe('前月比較（要件§10-3・初の実データ検証）', () => {
    it('レポート比較が前月値・当月値・差を持つ', () => {
      const rate = reportDiffs.find(
        (d) => d.scope === 'OVERALL' && d.metric === 'COST_RATE_AFTER_LOSS',
      )!;
      expect(rate.previous).toBeCloseTo(JUNE_EXPECTED!.costRateAfterLossPercent, 8);
      expect(rate.current).toBeCloseTo(JULY_EXPECTED!.costRateAfterLossPercent, 8);
      expect(rate.diff).toBeCloseTo(
        JULY_EXPECTED!.costRateAfterLossPercent - JUNE_EXPECTED!.costRateAfterLossPercent,
        8,
      );
      expect(rate.unit).toBe('pt');
      expect(rate.comparable).toBe(true);
    });

    it('使用高合計の差は円で表す', () => {
      const usage = reportDiffs.find(
        (d) => d.scope === 'OVERALL' && d.metric === 'USAGE_AMOUNT',
      )!;
      expect(usage.diff).toBeCloseTo(
        JULY_EXPECTED!.totalUsageAmount - JUNE_EXPECTED!.totalUsageAmount,
        6,
      );
      expect(usage.unit).toBe('円');
    });

    it('新規商品は前月値が null（0ではない）', () => {
      const d = productDiffs.find((x) => x.code === '041296')!;
      expect(d.status).toBe('NEW');
      expect(d.metrics.closingQty.previous).toBeNull();
      expect(d.metrics.closingQty.diff).toBeNull();
    });

    it('削除商品は当月値が null で、比較結果に現れる', () => {
      const d = productDiffs.find((x) => x.code === '007398')!; // 菜の花カット
      expect(d.status).toBe('DELETED');
      expect(d.metrics.closingQty.current).toBeNull();
    });

    it('継続商品は前月・当月・差額を持つ', () => {
      const d = productDiffs.find((x) => x.code === '000158')!;
      expect(d.status).toBe('CONTINUED');
      expect(d.metrics.usageAmount.previous).not.toBeNull();
      expect(d.metrics.usageAmount.current).not.toBeNull();
      expect(d.metrics.usageAmount.diff).not.toBeNull();
    });
  });

  describe('異常判定（初の実データ検証）', () => {
    it('全体のロス引き後原価率が +2.46pt で異常と判定される', () => {
      const overall = anomalies.find((a) => a.scope === 'OVERALL');
      expect(overall).toBeDefined();
      // 判定用の差は小数第2位に丸めてから引く（40.54% → 43.00% で +2.46pt）。
      // レポート比較の diff は丸め前の 2.4596... を持つが、表示はどちらも +2.46pt になる。
      expect(overall!.diffPt).toBeCloseTo(2.46, 8);
      expect(overall!.previousPercent).toBeCloseTo(JUNE_EXPECTED!.costRateAfterLossPercent, 8);
      expect(overall!.currentPercent).toBeCloseTo(JULY_EXPECTED!.costRateAfterLossPercent, 8);
      expect(overall!.thresholdPt).toBe(2.0);
    });

    it('異常はレポート比較の該当行にも反映される', () => {
      const rate = reportDiffs.find(
        (d) => d.scope === 'OVERALL' && d.metric === 'COST_RATE_AFTER_LOSS',
      )!;
      expect(rate.isAnomaly).toBe(true);
    });

    it('カテゴリ別にも異常判定が働く', () => {
      const cats = anomalies.filter((a) => a.scope === 'CATEGORY');
      expect(cats.length).toBeGreaterThan(0);
      for (const a of cats) {
        expect(Math.abs(Math.round(a.diffPt * 100) / 100)).toBeGreaterThanOrEqual(2.0);
      }
    });

    it('閾値未満のカテゴリは異常にならない', () => {
      const flagged = new Set(anomalies.filter((a) => a.scope === 'CATEGORY').map((a) => a.category));
      const notFlagged = reportDiffs.filter(
        (d) => d.scope === 'CATEGORY' && d.metric === 'COST_RATE' && !flagged.has(d.category),
      );
      for (const d of notFlagged) {
        if (d.diff === null) continue;
        expect(Math.abs(Math.round(d.diff * 100) / 100)).toBeLessThan(2.0);
      }
    });
  });

  describe('新規商品の換算係数の確認（運用要望）', () => {
    it('単位計算マスタに無い新規の食材を確認対象として挙げる', () => {
      const codes = julFromMaster.factorConfirmations.map((f) => f.code).sort();
      expect(codes).toContain('007426'); // マンゴ＆パッションフルーツソース１本
    });

    // 2026-09-27 確認: 備品（数値部5桁）はこの棚卸表で計算しない。
    // 以前は 041303 ドリンク提供付属品セット・041330 カレー提供付属品セット も
    // 確認対象に挙げていたが、そもそも対象外なので聞く必要がない。
    it('備品は確認対象に含めない', () => {
      const codes = julFromMaster.factorConfirmations.map((f) => f.code);
      expect(codes).not.toContain('041303');
      expect(codes).not.toContain('041330');
      expect(codes.filter((c) => String(Number(c)).length === 5)).toEqual([]);
    });

    it('発注のある1件を先頭に並べ、確認必須として示す', () => {
      const withOrder = julFromMaster.factorConfirmations.filter((f) => f.hasOrder);
      expect(withOrder.map((f) => f.code)).toEqual(['007426']);
      expect(julFromMaster.factorConfirmations[0]!.hasOrder).toBe(true);
    });

    it('当月マスタP列の値を初期値として提示する', () => {
      const f = julFromMaster.factorConfirmations.find((x) => x.code === '007426')!;
      expect(f.name).toContain('マンゴ');
      expect(f.hasOrder).toBe(true);
      expect(f.orderQty).not.toBeNull();
    });

    it('自店購入品は確認対象に含めない', () => {
      const own = new Set(['006063', '001250', 'A00043', '005249', '007193']);
      const codes = julFromMaster.factorConfirmations.map((f) => f.code);
      expect(codes.filter((c) => own.has(c))).toEqual([]);
    });

    it('発注のある未登録商品があれば W019 で知らせる', () => {
      const w019 = julFromMaster.issues.filter((i) => i.code === 'W019');
      expect(w019).toHaveLength(1);
      expect(w019[0]!.message).toContain('1 件');
    });

    it('係数を確認・登録すると以後は聞かれず、その値で換算される', async () => {
      const r = await runPipeline({
        targetYm: '2026-07',
        master: load(F.julMaster, '7月マスタ.xlsx'),
        previous: load(F.junResult, '6月結果.xlsx'),
        orders: load(F.julOrders),
        unitMaster: load(F.unitMaster),
        approveNewOpening: true,
        confirmedFactors: new Map([['041330', 60], ['041303', 50], ['007426', 1]]),
      });

      expect(r.factorConfirmations.map((f) => f.code)).not.toContain('041330');
      expect(r.issues.filter((i) => i.code === 'W019')).toEqual([]);

      const line = r.orderLines.find((l) => l.code === '041330')!;
      expect(line.orderQty).toBe(9);
      expect(line.conversionFactor).toBe(60);
      expect(line.convertedQty).toBe(540);
      expect(line.factorSource).toBe('CONFIRMED');
    });

    it('7月→8月の新規商品は全件が単位計算マスタにあるため確認不要', async () => {
      const r = await runPipeline({
        targetYm: '2026-08',
        master: load(join(AUG_DIR, '【当月本部マスタ】営業-2026.8月食材レジ前商品棚卸表マスタ.xlsx'), '8月マスタ.xlsx'),
        previous: load(F.julResult, '7月結果.xlsx'),
        unitMaster: load(F.unitMaster),
        approveNewOpening: true,
      });
      expect(r.factorConfirmations.filter((f) => f.hasOrder)).toEqual([]);
      expect(r.issues.filter((i) => i.code === 'W019')).toEqual([]);
    });
  });

  describe('単位計算マスタの取得元による差（運用上の注意）', () => {
    it('同梱CSV「発注累計計算単位」は6商品で計算単位が誤っており W009 が出る', async () => {
      const r = await runPipeline({
        targetYm: '2026-07',
        master: load(F.julMaster, '7月マスタ.xlsx'),
        previous: load(F.junResult, '6月結果.xlsx'),
        orders: load(F.julOrders),
        unitMaster: load(F.julUnitCsv, '発注累計計算単位.csv'),
        approveNewOpening: true,
        totalSalesOverride: JULY_EXPECTED!.totalSales,
      });
      // 6商品の不一致は1件の W009 にまとめ、どの商品かは details で追えるようにする
      const w009 = r.issues.filter((i) => i.code === 'W009');
      expect(w009).toHaveLength(1);
      expect(w009[0]!.count).toBe(6);
      expect(w009[0]!.details.map((d) => d.ref.productCode).sort()).toEqual([
        '002155', '002158', '005850', '006748', '007088', '007212',
      ]);
      // 確認先は本部ではなく店舗オーナー
      expect(w009[0]!.message).toContain('店舗オーナー');
    });

    it('CSV形式の単位計算マスタも取り込める', async () => {
      const r = await runPipeline({
        targetYm: '2026-07',
        master: load(F.julMaster, '7月マスタ.xlsx'),
        orders: load(F.julOrders),
        unitMaster: load(F.julUnitCsv, '発注累計計算単位.csv'),
        approveNewOpening: true,
      });
      expect(r.unitMaster.size).toBe(131);
      expect(r.issues.filter((i) => i.code === 'E008')).toEqual([]);
    });

    it('正式な単位計算マスタ（xlsx）は7月の棚卸表P列と食い違わない', () => {
      expect(julFromMaster.issues.filter((i) => i.code === 'W009')).toEqual([]);
    });
  });

  describe('集計期間の検証', () => {
    it('7月の発注累計は 2026/07/01〜07/31 で対象年月と一致する', () => {
      expect(julFromMaster.orderMeta).toMatchObject({
        storeCodes: [REAL_EXPECTED_STORE],
        periodFrom: '2026/07/01',
        periodTo: '2026/07/31',
      });
      expect(julFromMaster.issues.filter((i) => i.code === 'E004')).toEqual([]);
      expect(julFromMaster.issues.filter((i) => i.code === 'W015')).toEqual([]);
    });

    it('対象年月を8月にすると E004 で止まる', async () => {
      const r = await runPipeline({
        targetYm: '2026-08',
        master: load(F.julMaster, '7月マスタ.xlsx'),
        orders: load(F.julOrders),
        unitMaster: load(F.unitMaster),
        approveNewOpening: true,
      });
      expect(r.issues.filter((i) => i.code === 'E004')).toHaveLength(1);
      expect(r.hasBlocking).toBe(true);
    });
  });
});

describe.skipIf(available)('6月・7月データ未配置', () => {
  it('ファイルが無いためスキップした', () => {
    expect(available).toBe(false);
  });
});
