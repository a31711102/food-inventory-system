/**
 * 実ファイルによる検証（受入条件1・3・5）。
 *
 * 実ファイルには店舗の実原価データが含まれるためリポジトリにはコミットしない。
 * ローカルに存在するときだけ実行し、無ければスキップする。
 * パスは環境変数 REAL_FIXTURES で上書きできる。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { XlsxWorkbook, FormulaCellWriteError } from '@/xlsx/workbook';
import { readInventorySheet, toPreviousEntries } from '@/ingest/inventorySheet';
import { readUnitMasterTable } from '@/ingest/orderFile';
import { tableFromSheet } from '@/ingest/tabular';
import { HQ_MASTER_PROFILE, UNIT_MASTER_PROFILE } from '@/ingest/profiles';
import { buildReport } from '@/domain/report';
import { applyCarryover } from '@/domain/carryover';
import { computeAllDerived } from '@/domain/calculation';
import { validateProductRows } from '@/domain/validation';
import { convertOrderLines } from '@/domain/purchase';
import { makeOrder, code } from '../helpers/factories';
import { REAL_EXPECTED } from '../helpers/realExpected';

const DIR =
  process.env['REAL_FIXTURES'] ??
  join('C:', 'Users', 'kimi4', 'Downloads', '棚卸表設計', '棚卸表設計');

/**
 * 版の付いたファイル名に追従する。
 *
 * 本部から配られる帳票は修正のたびに `...v1.xlsx` `...v2.xlsx` と版が付く。
 * 固定名で探すとファイルが見つからずテストが黙ってスキップされるため、
 * 前方一致で探し、**いちばん新しい版**を使う。
 */
function findVersioned(dir: string, prefix: string): string | null {
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
    .sort();
  return hits.length > 0 ? hits[hits.length - 1]! : null;
}

const PREV_FILE = findVersioned(DIR, '【前月食品棚卸表】営業-2026.8月') ?? '';
const MASTER_FILE = findVersioned(DIR, '【当月本部マスタ】営業-2026.8月') ?? '';
const UNIT_FILE = '【単位計算マスタ】発注品計算単位マスタ.xlsx';
const REF_FILE = '【参考資料】食材棚卸表_20260913.xlsx';

// 実業績値はリポジトリに含めないため、未配置ならスキップする
const EX = REAL_EXPECTED?.august ?? null;
const available = PREV_FILE !== '' && MASTER_FILE !== '' && EX !== null;

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(DIR, name)));
}

describe.skipIf(!available)('実ファイル検証（2026年8月）', () => {
  let prevWb: XlsxWorkbook;
  let prev: ReturnType<typeof readInventorySheet>;

  beforeAll(async () => {
    prevWb = await XlsxWorkbook.load(load(PREV_FILE));
    prev = readInventorySheet(prevWb, HQ_MASTER_PROFILE, {
      fileName: PREV_FILE,
      approveOpening: true,
    });
  });

  describe('取込', () => {
    it('入力用シートから266商品を読む', () => {
      expect(prev.rows).toHaveLength(266);
    });

    it('データ行は3行目から268行目', () => {
      expect(prev.rows[0]!.lineNo).toBe(3);
      expect(prev.rows.at(-1)!.lineNo).toBe(268);
    });

    it('列マッピングが全項目を完全一致で解決する', () => {
      for (const [field, col] of Object.entries(prev.resolved.columns)) {
        expect({ field, exact: col.exact }).toEqual({ field, exact: true });
      }
    });

    it('必須列欠落などの BLOCKING が出ない', () => {
      const blocking = prev.issues.filter((i) => i.level === 'BLOCKING');
      expect(blocking.map((i) => `${i.code}:${i.message}`)).toEqual([]);
    });
  });

  describe('商品コード（受入条件1）', () => {
    it('全件が6桁の文字列', () => {
      expect(prev.rows.every((r) => typeof r.code === 'string' && r.code.length === 6)).toBe(true);
    });

    it('先頭ゼロが保持されている', () => {
      expect(prev.rows[0]!.code).toBe('000140');
      expect(prev.rows.some((r) => r.code === '000158')).toBe(true);
    });

    it('コードが数値型で読まれていない（I001 が出ない）', () => {
      expect(prev.issues.filter((i) => i.code === 'I001')).toHaveLength(0);
    });

    // 2026-09-27 確認: 自店購入は4品＋レモンスライスの5品で、Aコードかどうかでは決まらない。
    // 実データのAコード21件のうち自店購入はキャベツ1件だけで、
    // 残りは日めくり・炭酸ガスボンベ・カプセルトイ・レターパックなどの備品や本部商品だった。
    it('自店購入は既定リストの5品のうち当月マスタにあるものだけ', () => {
      const own = prev.rows.filter((r) => r.isOwnPurchase).map((r) => r.code).sort();
      expect(own).toEqual(['001250', '005249', '006063', '007193', 'A00043']);
    });

    it('Aコードでも自店購入とは限らない', () => {
      const aCodes = prev.rows.filter((r) => r.code.startsWith('A'));
      expect(aCodes).toHaveLength(21);
      expect(aCodes.filter((r) => r.isOwnPurchase).map((r) => r.code)).toEqual(['A00043']);
    });

    it('備品（数値部が5桁）がある', () => {
      // セレクトボックス・ギフト・ぬいぐるみ・FANBOOK・ドリンク提供付属品セットなど
      const supplies = prev.rows.filter((r) => r.isSupply);
      expect(supplies.length).toBeGreaterThan(20);
      expect(supplies.every((r) => !/^0?0/.test(String(Number(r.code.replace(/^A/, '')))))).toBe(true);
    });

    it('食材には2桁・3桁のコードもある（4桁だけではない）', () => {
      const digits = (c: string) => String(Number(c.startsWith('A') ? c.slice(1) : c)).length;
      const food = prev.rows.filter((r) => !r.isSupply).map((r) => digits(r.code));
      expect(Math.min(...food)).toBeLessThan(4);
      expect(Math.max(...food)).toBe(4);
    });

    it('商品コードの重複がない', () => {
      expect(validateProductRows(prev.rows).filter((i) => i.code === 'E002')).toHaveLength(0);
    });
  });

  describe('明細の計算が現行帳票と一致する', () => {
    it.each([
      ['000158', 74, 88356, 8358],
      ['000155', 115, 571780, 29832],
      ['006747', 6, 624, 624],
    ])('%s: 期中使用量=%d 当月使用高=%d 期末在庫高=%d', (c, usageQty, usageAmount, closingAmount) => {
      const row = prev.rows.find((r) => r.code === c)!;
      expect(row.usageQty).toBe(usageQty);
      expect(row.usageAmount).toBe(usageAmount);
      expect(row.closingAmount).toBe(closingAmount);
    });

    it('全明細の J 列がExcelのキャッシュ値と一致する', () => {
      const mismatches: string[] = [];
      for (const row of prev.rows) {
        const excel = prevWb.cell('入力用', `J${row.lineNo}`)?.value;
        if (typeof excel === 'number' && Math.abs(excel - (row.usageQty ?? 0)) > 1e-9) {
          mismatches.push(`${row.code} 行${row.lineNo}: system=${row.usageQty} excel=${excel}`);
        }
      }
      expect(mismatches).toEqual([]);
    });

    it('全明細の L 列（当月使用高）がExcelのキャッシュ値と一致する', () => {
      const mismatches: string[] = [];
      for (const row of prev.rows) {
        const excel = prevWb.cell('入力用', `L${row.lineNo}`)?.value;
        if (typeof excel === 'number' && Math.abs(excel - (row.usageAmount ?? 0)) > 1e-6) {
          mismatches.push(`${row.code} 行${row.lineNo}: system=${row.usageAmount} excel=${excel}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  describe('管理レポートが現行帳票と一致する（受入条件5）', () => {
    it('当月売上高を分析用 C4 から読む', () => {
      expect(prev.analysis.totalSales).toBe(EX!.totalSales);
    });

    it('ロス額は空欄', () => {
      expect(prev.analysis.lossAmount).toBeNull();
    });

    // 2026-09-27: 参照ファイルを v1 から v2（修正版）へ切り替えた。
    // v1 は期首在庫が1行ずれており（7月期末との一致が 172/254）、
    // v2 は 254/254 で完全一致する。期待値は v2 の分析用シートの値
    // （実数は tests/fixtures/real/expected.json。リポジトリには含めない）。
    it('使用高合計が分析用シートと一致する（ガチャ玉・靴他を除外）', () => {
      const report = buildReport(prev.rows, {
        targetYm: '2026-08',
        totalSales: prev.analysis.totalSales,
      });
      expect(report.totalUsageAmount).toBeCloseTo(EX!.totalUsageAmount, 6);
    });

    it('ロス引き後原価率が分析用シートと一致する', () => {
      const report = buildReport(prev.rows, {
        targetYm: '2026-08',
        totalSales: prev.analysis.totalSales,
      });
      expect(report.costRateAfterLossPercent).toBeCloseTo(EX!.costRateAfterLossPercent, 8);
    });

    it('食材期末在庫計が分析用シートと一致する', () => {
      const report = buildReport(prev.rows, {
        targetYm: '2026-08',
        totalSales: prev.analysis.totalSales,
      });
      expect(report.totalClosingAmount).toBeCloseTo(EX!.totalClosingAmount!, 6);
    });

    it('サラダ野菜使用高が分析用シートと一致する', () => {
      const report = buildReport(prev.rows, {
        targetYm: '2026-08',
        totalSales: prev.analysis.totalSales,
      });
      expect(report.saladVegetableUsage).toBeCloseTo(EX!.saladVegetableUsage, 6);
    });

    it('カテゴリ別当月使用高が入力用 U列と全件一致する', () => {
      const report = buildReport(prev.rows, {
        targetYm: '2026-08',
        totalSales: prev.analysis.totalSales,
      });
      // 入力用 S列3〜19行の分類に対応する U列
      const inputRowOf = new Map(
        [
          '01.ソース','02.主食材Ａ','03.主食材Ｂ','04.米','05.油','06.ＴＯ(レジ前)','07.福神漬',
          '08.ビール','09.野菜','10.副食材','11.ドリンク','12.朝食メニュー','13.ドレッシング',
          '14.限定','15.ガチャ玉','16.靴他','17.カレーらーめん',
        ].map((c, i) => [c, i + 3] as const),
      );

      const mismatches: string[] = [];
      for (const cat of report.categories) {
        const row = inputRowOf.get(cat.category)!;
        const excel = prevWb.cell('入力用', `U${row}`)?.value;
        if (typeof excel === 'number' && Math.abs(excel - cat.usageAmount) > 1e-6) {
          mismatches.push(`${cat.category}: system=${cat.usageAmount} excel=${excel}`);
        }
      }
      expect(mismatches).toEqual([]);
    });

    it('ガチャ玉と靴他は合計に含まれない', () => {
      const report = buildReport(prev.rows, {
        targetYm: '2026-08',
        totalSales: prev.analysis.totalSales,
      });
      const excluded = report.categories.filter((c) => !c.includedInTotal);
      const excludedSum = excluded.reduce((s, c) => s + c.usageAmount, 0);

      expect(excluded.map((c) => c.category)).toEqual(['15.ガチャ玉', '16.靴他']);
      // v2 では備品の在庫が0に直されたため、除外分も0になった
      expect(excludedSum).toBeCloseTo(0, 6);
    });
  });

  describe('期首引継ぎ（受入条件1・現行ツールのバグ回帰テスト）', () => {
    it('当月マスタは前月と同じ266商品を持つ', async () => {
      const masterWb = await XlsxWorkbook.load(load(MASTER_FILE));
      const master = readInventorySheet(masterWb, HQ_MASTER_PROFILE, { fileName: MASTER_FILE });
      expect(master.rows).toHaveLength(266);
    });

    it('前月期末が当月期首へ正しく引き継がれる', async () => {
      const masterWb = await XlsxWorkbook.load(load(MASTER_FILE));
      const master = readInventorySheet(masterWb, HQ_MASTER_PROFILE, {
        fileName: MASTER_FILE,
        approveOpening: true,
      });
      const prevMap = new Map(toPreviousEntries(prev.rows).map((p) => [p.code as string, p]));
      const carried = applyCarryover(master.rows, prevMap);

      const mismatches: string[] = [];
      for (const row of carried.rows) {
        const source = prevMap.get(row.code);
        if (source && source.closingQty !== row.openingQty) {
          mismatches.push(`${row.code}: 前月期末=${source.closingQty} 当月期首=${row.openingQty}`);
        }
      }
      expect(mismatches).toEqual([]);
    });

    it('全商品が継続と判定され、新規・削除は発生しない', async () => {
      const masterWb = await XlsxWorkbook.load(load(MASTER_FILE));
      const master = readInventorySheet(masterWb, HQ_MASTER_PROFILE, {
        fileName: MASTER_FILE,
        approveOpening: true,
      });
      const prevMap = new Map(toPreviousEntries(prev.rows).map((p) => [p.code as string, p]));
      const carried = applyCarryover(master.rows, prevMap);

      expect(carried.newProducts).toHaveLength(0);
      expect(carried.deletedProducts).toHaveLength(0);
    });

    it.skipIf(!existsSync(join(DIR, REF_FILE)))(
      '現行ツールは商品コードを数値型で保持しており、Aコードが突合から落ちる',
      async () => {
        // 2026-09-27 訂正:
        // かつてこのテストは「現行ツールは50行以上で前月期末と食い違う」と主張していたが、
        // それは人手版(v1)を正と仮定した比較だった。v1 自体に期首在庫の入力ずれがあり
        // （7月期末との一致が 172/254）、店舗担当者の申告で修正版(v2)が正と確定した。
        //
        // 実際に7月期末と突き合わせると、現行ツールの期首在庫は 228/233 一致しており、
        // 転記そのものはほぼ正しかった。ツールに残る実害は**商品コードの型**である。
        const refWb = await XlsxWorkbook.load(load(REF_FILE));
        const cells = refWb.cells('自動処理結果');
        const byRow = new Map<number, Record<number, unknown>>();
        for (const c of cells.values()) {
          const m = byRow.get(c.row) ?? {};
          m[c.col] = c.value;
          byRow.set(c.row, m);
        }
        const codeCol = Math.min(...[...cells.values()].map((c) => c.col));
        const codes = [...byRow.entries()]
          .filter(([row]) => row >= 2)
          .map(([, m]) => m[codeCol])
          .filter((v) => v !== null && v !== undefined && v !== '');

        // コードが number と string の混在＝先頭ゼロが失われている
        expect(new Set(codes.map((c) => typeof c))).toEqual(new Set(['number', 'string']));
        // 数値にできないのはAコードで、6桁ゼロ埋めの突合からは落ちる
        const nonNumeric = codes.filter((c) => !Number.isFinite(Number(c))).map(String);
        expect(nonNumeric.filter((c) => c.startsWith('A')).length).toBeGreaterThan(20);
        // 数値型で保持された分は先頭ゼロが失われている（140 のように3桁で入っている）
        const numeric = codes.filter((c) => typeof c === 'number') as number[];
        expect(numeric.some((c) => String(c).length < 6)).toBe(true);
      },
    );

    it('本システムは商品コードを文字列で保持し、Aコードも落とさない', async () => {
      const masterWb = await XlsxWorkbook.load(load(MASTER_FILE));
      const master = readInventorySheet(masterWb, HQ_MASTER_PROFILE, {
        fileName: MASTER_FILE,
        approveOpening: true,
      });
      const aCodes = master.rows.filter((r) => r.code.startsWith('A'));

      expect(aCodes).toHaveLength(21);
      expect(master.rows.every((r) => typeof r.code === 'string')).toBe(true);
      expect(master.rows.every((r) => r.code.length === 6)).toBe(true);
    });
  });

  describe.skipIf(!existsSync(join(DIR, UNIT_FILE)))('単位計算マスタ', () => {
    it('149行から重複3件を除いた146コードを読み込み、商品コードを6桁へ復元する', async () => {
      const wb = await XlsxWorkbook.load(load(UNIT_FILE));
      const table = tableFromSheet(wb, '発注品計算単位一覧', 1, 2);
      const result = readUnitMasterTable(table, UNIT_MASTER_PROFILE, { fileName: UNIT_FILE });

      expect(result.entries.size).toBe(146);
      expect(result.entries.has('001464')).toBe(true);
      expect(result.entries.get('005113')?.factor).toBe(60); // カキフライ 1箱=60
    });

    it('重複行を黙って上書きせず W014 で警告する', async () => {
      const wb = await XlsxWorkbook.load(load(UNIT_FILE));
      const table = tableFromSheet(wb, '発注品計算単位一覧', 1, 2);
      const result = readUnitMasterTable(table, UNIT_MASTER_PROFILE, { fileName: UNIT_FILE });

      // 1事象1メッセージ。3件の重複は1件の W014 にまとめ、内訳を details に持つ。
      const dup = result.issues.filter((i) => i.code === 'W014');
      expect(dup).toHaveLength(1);
      expect(dup[0]!.count).toBe(3);
      expect(dup[0]!.details.map((d) => d.ref.productCode).sort()).toEqual([
        '002269',
        '005913',
        '006746',
      ]);
    });

    it('重複の計算単位は一致しているため E002 にはならない', async () => {
      const wb = await XlsxWorkbook.load(load(UNIT_FILE));
      const table = tableFromSheet(wb, '発注品計算単位一覧', 1, 2);
      const result = readUnitMasterTable(table, UNIT_MASTER_PROFILE, { fileName: UNIT_FILE });

      expect(result.issues.filter((i) => i.code === 'E002')).toEqual([]);
    });

    it('数値型コードの復元を I001 として可視化する', async () => {
      const wb = await XlsxWorkbook.load(load(UNIT_FILE));
      const table = tableFromSheet(wb, '発注品計算単位一覧', 1, 2);
      const result = readUnitMasterTable(table, UNIT_MASTER_PROFILE, { fileName: UNIT_FILE });

      expect(result.issues.filter((i) => i.code === 'I001').length).toBeGreaterThan(0);
    });

    it('マスタP列と単位計算マスタの計算単位が一致する（不一致0件）', async () => {
      const wb = await XlsxWorkbook.load(load(UNIT_FILE));
      const table = tableFromSheet(wb, '発注品計算単位一覧', 1, 2);
      const unit = readUnitMasterTable(table, UNIT_MASTER_PROFILE, { fileName: UNIT_FILE }).entries;

      const factorByCode = new Map(prev.rows.map((r) => [r.code as string, r.conversionFactor]));
      const orders = [...unit.keys()]
        .filter((c) => factorByCode.has(c))
        .map((c, i) => makeOrder({ code: code(c), orderQty: 1, lineNo: i + 2 }));

      const result = convertOrderLines(orders, { unitMaster: unit, masterP: factorByCode });

      expect(result.issues.filter((i) => i.code === 'W009')).toEqual([]);
      const agreed = result.issues.filter((i) => i.code === 'I003');
      expect(agreed).toHaveLength(1);
      expect(agreed[0]!.count).toBe(112);
    });
  });

  describe('出力（受入条件8）', () => {
    it('書き戻し後も数式・他シートが保たれ、再計算フラグが立つ', async () => {
      const wb = await XlsxWorkbook.load(load(MASTER_FILE));
      wb.setNumber('入力用', 'I3', 5);
      wb.setNumber('入力用', 'H3', 76);
      wb.enableFullCalcOnLoad();

      const out = await XlsxWorkbook.load(await wb.toUint8Array());

      expect(out.cell('入力用', 'I3')?.value).toBe(5);
      expect(out.cell('入力用', 'J3')?.formula).toBe('SUM(H3:I3)-G3');
      expect(out.cell('入力用', 'L3')?.formula).toBe('K3*J3');
      expect(out.cell('分析用', 'C22')?.formula).toBe('SUM(C5:D19)');
      expect(out.cell('分析用', 'L11')?.formula).toBe('K9/C4*100');
      expect(out.sheetNames).toEqual(['注意事項', '入力用', '分析用']);
      // 注意事項シートの内容が残っている
      expect(out.cells('注意事項').size).toBeGreaterThan(5);
    });

    it('数式セルへの書き込みは拒否される（E010）', async () => {
      const wb = await XlsxWorkbook.load(load(MASTER_FILE));
      expect(() => wb.setNumber('入力用', 'J3', 1)).toThrow(FormulaCellWriteError);
      expect(() => wb.setNumber('分析用', 'L11', 1)).toThrow(FormulaCellWriteError);
    });

  });

  it('全明細を再計算しても元の値と変わらない（冪等）', () => {
    const again = computeAllDerived(prev.rows);
    expect(again.map((r) => r.usageAmount)).toEqual(prev.rows.map((r) => r.usageAmount));
  });
});

describe.skipIf(available)('実ファイル未配置', () => {
  it('実ファイルが無いためスキップした旨を示す', () => {
    expect(available).toBe(false);
  });
});
