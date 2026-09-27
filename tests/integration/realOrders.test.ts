/**
 * 発注累計照会（実ファイル・2026年8月）の検証。
 *
 * 実ファイルは店舗の実データを含むためリポジトリにはコミットしない。
 * 見つからなければスキップする。探索場所は環境変数で上書きできる。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { XlsxWorkbook } from '@/xlsx/workbook';
import { readInventorySheet } from '@/ingest/inventorySheet';
import { readOrderTable, readUnitMasterTable } from '@/ingest/orderFile';
import { tableFromCsv, tableFromSheet } from '@/ingest/tabular';
import { HQ_MASTER_PROFILE, ORDER_PROFILE, UNIT_MASTER_PROFILE } from '@/ingest/profiles';
import { convertOrderLines, applyPurchases } from '@/domain/purchase';
import { checkOrderPeriod } from '@/domain/period';
import { runPipeline } from '@/app/pipeline';
import type { ProductRow, UnitConversionEntry } from '@/domain/models';
import { REAL_EXPECTED, REAL_EXPECTED_STORE } from '../helpers/realExpected';

const INVENTORY_DIR =
  process.env['REAL_FIXTURES'] ??
  join('C:', 'Users', 'kimi4', 'Downloads', '棚卸表設計', '棚卸表設計');

const SEARCH_DIRS = [
  INVENTORY_DIR,
  process.env['REAL_ORDERS_DIR'] ?? join('C:', 'Users', 'kimi4', 'Downloads'),
];

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

const PREV_FILE = findVersioned(INVENTORY_DIR, '【前月食品棚卸表】営業-2026.8月') ?? '';
const UNIT_MASTER_FILE = '【単位計算マスタ】発注品計算単位マスタ.xlsx';

/** 「発注累計照会」で始まる CSV を探す（ファイル名に出力日時が入るため） */
function findOrderCsv(): string | null {
  for (const dir of SEARCH_DIRS) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.startsWith('発注累計照会') && f.toLowerCase().endsWith('.csv'));
    if (hit) return join(dir, hit);
  }
  return null;
}

const ORDER_CSV = findOrderCsv();
const PREV_PATH = join(INVENTORY_DIR, PREV_FILE);
const available =
  ORDER_CSV !== null && PREV_FILE !== '' && existsSync(PREV_PATH) && REAL_EXPECTED !== null;

describe.skipIf(!available)('発注累計照会 実ファイル検証（2026年8月）', () => {
  let orders: ReturnType<typeof readOrderTable>;
  let masterRows: ProductRow[];
  let unitMaster: Map<string, UnitConversionEntry>;
  /** 換算係数の取得元。単位計算マスタが正、当月マスタP列はフォールバック */
  let sources: { unitMaster: Map<string, UnitConversionEntry>; masterP: Map<string, number> };

  beforeAll(async () => {
    const bytes = new Uint8Array(readFileSync(ORDER_CSV!));
    const table = tableFromCsv(bytes, ORDER_PROFILE.header.detectBy);
    orders = readOrderTable(table, ORDER_PROFILE, { fileName: 'order.csv' });

    const wb = await XlsxWorkbook.load(new Uint8Array(readFileSync(PREV_PATH)));
    masterRows = readInventorySheet(wb, HQ_MASTER_PROFILE, {
      fileName: PREV_FILE,
      approveOpening: true,
    }).rows;

    const uwb = await XlsxWorkbook.load(new Uint8Array(readFileSync(join(INVENTORY_DIR, UNIT_MASTER_FILE))));
    unitMaster = readUnitMasterTable(
      tableFromSheet(uwb, '発注品計算単位一覧', 1, 2),
      UNIT_MASTER_PROFILE,
      { fileName: UNIT_MASTER_FILE },
    ).entries;

    sources = {
      unitMaster,
      masterP: new Map(masterRows.map((r) => [r.code as string, r.conversionFactor])),
    };
  });

  describe('取込', () => {
    it('CP932のCSVを文字化けせず読む', () => {
      expect(orders.lines.length).toBeGreaterThan(0);
    });

    it('149行の発注明細を読む', () => {
      expect(orders.lines).toHaveLength(149);
    });

    it('必須列が揃い BLOCKING が出ない', () => {
      expect(orders.issues.filter((i) => i.level === 'BLOCKING').map((i) => i.message)).toEqual([]);
    });

    it('原材料コードは6桁の文字列で、先頭ゼロが保持される', () => {
      expect(orders.lines.every((l) => l.code.length === 6)).toBe(true);
      expect(orders.lines.some((l) => l.code === '001464')).toBe(true);
      expect(orders.lines.some((l) => l.code === '018898')).toBe(true);
    });

    it('コードの型変換（I001）が発生しない', () => {
      expect(orders.issues.filter((i) => i.code === 'I001')).toEqual([]);
    });

    it('発注数はすべて正の数（この月に返品行はない）', () => {
      expect(orders.lines.every((l) => l.orderQty > 0)).toBe(true);
      expect(orders.lines.every((l) => !l.isReturn)).toBe(true);
    });
  });

  describe('集計期間（未確定事項A-2の確定）', () => {
    it('納品日From/To を読める', () => {
      expect(orders.meta.periodFrom).toBe('2026/08/01');
      expect(orders.meta.periodTo).toBe('2026/08/31');
    });

    it('月初〜月末であることが確認できる', () => {
      expect(checkOrderPeriod('2026-08', orders.meta.periodFrom, orders.meta.periodTo, 'o.csv')).toEqual([]);
    });

    it('別の月を対象にすると E004 で止まる', () => {
      const issues = checkOrderPeriod('2026-09', orders.meta.periodFrom, orders.meta.periodTo, 'o.csv');
      expect(issues.map((i) => i.code)).toEqual(['E004']);
    });

    it('店舗コードは単一（1930）', () => {
      expect(orders.meta.storeCodes).toEqual([REAL_EXPECTED_STORE]);
    });
  });

  describe('換算係数の出所（設計判断の裏づけ）', () => {
    it('149行の内訳は 棚卸表にある115行（112商品）＋ 棚卸表にない34行', () => {
      const known = new Set(masterRows.map((r) => r.code as string));
      const inMaster = orders.lines.filter((l) => known.has(l.code));
      const notInMaster = orders.lines.filter((l) => !known.has(l.code));

      expect(inMaster).toHaveLength(115); // 重複3コード（各2行）を含む行数
      expect(new Set(inMaster.map((l) => l.code)).size).toBe(112); // 商品数
      expect(notInMaster).toHaveLength(34); // すべて備品（数値部が5桁）
      expect(orders.lines).toHaveLength(149);
    });

    // 2026-09-27 確認: 備品（数値部5桁）はこの棚卸表で計算しない。
    // 棚卸表に無かった34件はすべて備品だったため、警告ではなく情報 I004 になった。
    it('棚卸表にない34件はすべて備品で、I004 に1件へまとまる', () => {
      const conv = convertOrderLines(orders.lines, sources);
      const applied = applyPurchases(masterRows, conv.lines);

      expect(applied.issues.filter((i) => i.code === 'W011')).toEqual([]);
      const i004 = applied.issues.filter((i) => i.code === 'I004');
      expect(i004).toHaveLength(1);
      expect(i004[0]!.level).toBe('INFO');
      expect(i004[0]!.count).toBe(35); // 備品35コード（うち1件は棚卸表にもある 041304）
    });

    it('棚卸表にある商品は全件換算できる（E005 が出ない）', () => {
      const conv = convertOrderLines(orders.lines, sources);
      expect(conv.issues.filter((i) => i.code === 'E005')).toEqual([]);
    });

    it('単位計算マスタが発注商品146件すべてを網羅する', () => {
      const missing = [...new Set(orders.lines.map((l) => l.code as string))].filter(
        (c) => !unitMaster.has(c),
      );
      expect(missing).toEqual([]);
      expect(new Set(orders.lines.map((l) => l.code)).size).toBe(146);
    });

    it('当月マスタP列は発注商品の112件しか網羅しない（単位計算マスタを正とする根拠）', () => {
      const known = new Set(masterRows.map((r) => r.code as string));
      const covered = [...new Set(orders.lines.map((l) => l.code as string))].filter((c) =>
        known.has(c),
      );
      expect(covered).toHaveLength(112);
    });

    it('全行が単位計算マスタ由来の係数で換算される', () => {
      const conv = convertOrderLines(orders.lines, sources);
      expect(conv.lines.every((l) => l.factorSource === 'UNIT_MASTER')).toBe(true);
      expect(conv.issues.filter((i) => i.code === 'W016')).toEqual([]);
    });

    it('単位計算マスタと当月マスタP列の係数が112件すべて一致する（W009 なし）', () => {
      const conv = convertOrderLines(orders.lines, sources);
      expect(conv.issues.filter((i) => i.code === 'W009').map((i) => i.message)).toEqual([]);
      const agreed = conv.issues.filter((i) => i.code === 'I003');
      expect(agreed).toHaveLength(1);
      expect(agreed[0]!.count).toBe(115);
    });
  });

  describe('期中仕入の検算（発注数 × 仕入れ単位P）', () => {
    function computeMismatches(): { code: string; name: string; calc: number; sheet: number }[] {
      const conv = convertOrderLines(orders.lines, sources);
      const applied = applyPurchases(
        masterRows.map((r) => ({ ...r, purchaseQty: 0 })),
        conv.lines,
      );
      const ordered = new Set(conv.lines.map((l) => l.code as string));

      const out: { code: string; name: string; calc: number; sheet: number }[] = [];
      for (const row of applied.rows) {
        if (!ordered.has(row.code)) continue;
        const sheet = masterRows.find((m) => m.code === row.code)!.purchaseQty;
        if (Math.abs(row.purchaseQty - sheet) > 1e-9) {
          out.push({ code: row.code, name: row.name, calc: row.purchaseQty, sheet });
        }
      }
      return out;
    }

    it('発注のある食材111商品のうち109件が現行帳票の期中仕入と一致する', () => {
      // 2026-09-27 の本部回答と、修正版(v2)の帳票を反映した結果:
      //   ・備品 041304 を計算対象外にした（差 1件が解消）
      //   ・v2 でグループA 7件とパセリの期中仕入が発注累計に揃った（差 8件が解消）
      // 残る2件はグループBのコード切替と、カキフライの月またぎ納品。
      const mismatches = computeMismatches();
      expect(mismatches).toHaveLength(2);
    });

    it('一致しない2件は既知のもので、内訳が変わっていない', () => {
      // 2026-09-27 に本部へ確認済み（要件§10-2）。
      // 8件（グループA）は現行帳票の期首在庫の入力誤りで、発注累計が正しい。
      // 2件（グループB）は商品コードの切替で、今後は発注累計のコードに揃える。
      // システムの計算式の誤りではないことを固定して、変化したら気づけるようにする。
      const mismatches = computeMismatches().map((m) => m.code).sort();
      expect(mismatches).toEqual(
        [
          '002133', // とび辛用油（発注4・帳票0）。007331（Ｒ７）へ計上されている。
          //          今後は発注累計のコードに揃える（2026-09-27 本部確認）
          '005113', // カキフライ（発注1×60=60・帳票120）。
          //          納品が月をまたいだものと思われ、帳票側に1箱分多い
        ].sort(),
      );
    });

    it('代表例の換算が正しい（カキフライ 1箱 × 60 = 60）', () => {
      const conv = convertOrderLines(orders.lines, sources);
      const line = conv.lines.find((l) => l.code === '005113')!;

      expect(line.orderQty).toBe(1);
      expect(line.conversionFactor).toBe(60);
      expect(line.convertedQty).toBe(60);
    });

    it('入数（内容量）を換算係数に使っていない', () => {
      // 001464 輪切り唐辛子: 入数=5(ｇ) だが 棚卸単位への換算は 1
      const conv = convertOrderLines(orders.lines, sources);
      const line = conv.lines.find((l) => l.code === '001464')!;

      expect(line.conversionFactor).toBe(1);
      expect(line.convertedQty).toBe(line.orderQty); // 6 × 1
      expect(line.convertedQty).not.toBe(line.orderQty * 5);
    });

    it('同一コードの複数行を合算する（実データに3件ある）', () => {
      const counts = new Map<string, number>();
      for (const l of orders.lines) counts.set(l.code, (counts.get(l.code) ?? 0) + 1);
      const dup = [...counts.entries()].filter(([, n]) => n > 1).map(([c]) => c);
      expect(dup.sort()).toEqual(['002269', '005913', '006746']);

      // 合算した結果が現行帳票と一致すること
      const conv = convertOrderLines(orders.lines, sources);
      const applied = applyPurchases(
        masterRows.map((r) => ({ ...r, purchaseQty: 0 })),
        conv.lines,
      );
      for (const c of dup) {
        const sheet = masterRows.find((m) => m.code === c)!.purchaseQty;
        const calc = applied.rows.find((m) => m.code === c)!.purchaseQty;
        expect({ code: c, calc }).toEqual({ code: c, calc: sheet });
      }
    });
  });
});

describe.skipIf(!available)('4ファイルすべてを通した処理（2026年8月）', () => {
  const MASTER_FILE = '【当月本部マスタ】営業-2026.8月食材レジ前商品棚卸表マスタ.xlsx';
  const UNIT_FILE = '【単位計算マスタ】発注品計算単位マスタ.xlsx';

  const load = (dir: string, name: string) => ({
    fileName: name,
    bytes: new Uint8Array(readFileSync(join(dir, name))),
  });

  async function run(targetYm = '2026-08') {
    return runPipeline({
      targetYm,
      master: load(INVENTORY_DIR, MASTER_FILE),
      previous: load(INVENTORY_DIR, PREV_FILE),
      orders: { fileName: 'order.csv', bytes: new Uint8Array(readFileSync(ORDER_CSV!)) },
      unitMaster: load(INVENTORY_DIR, UNIT_FILE),
      approveNewOpening: true,
      totalSalesOverride: REAL_EXPECTED!.august.totalSales,
    });
  }

  it('BLOCKING なしで完走する', async () => {
    const r = await run();
    expect(r.issues.filter((i) => i.level === 'BLOCKING').map((i) => `${i.code} ${i.message}`)).toEqual([]);
    expect(r.hasBlocking).toBe(false);
  });

  it('266商品を処理する', async () => {
    const r = await run();
    expect(r.rows).toHaveLength(266);
  });

  it('期中仕入が入るのは発注のあった食材111商品（備品は対象外）', async () => {
    const r = await run();
    expect(r.rows.filter((x) => x.purchaseQty !== 0)).toHaveLength(111);
  });

  it('期首在庫が前月期末から引き継がれる', async () => {
    const r = await run();
    const prevByCode = new Map(r.previousEntries.map((p) => [p.code as string, p]));
    const mismatches = r.rows
      .filter((x) => prevByCode.has(x.code))
      .filter((x) => x.openingQty !== prevByCode.get(x.code)!.closingQty)
      .map((x) => x.code);
    expect(mismatches).toEqual([]);
  });

  it('検算（前月ファイル）が通り W010 が出ない', async () => {
    // 前月ファイルは完成済みなので、システムの計算値とExcelの数式結果が一致するはず。
    const r = await run();
    expect(r.issues.filter((i) => i.code === 'W010').map((i) => i.message)).toEqual([]);
  });

  it('備品の発注は I004 にまとまり、警告にはならない', async () => {
    const r = await run();
    expect(r.issues.filter((i) => i.code === 'W011')).toEqual([]);
    const i004 = r.issues.filter((i) => i.code === 'I004');
    expect(i004).toHaveLength(1);
    expect(i004[0]!.level).toBe('INFO');
    expect(r.issues.filter((i) => i.code === 'E005')).toEqual([]);
  });

  it('集計期間の情報を保持する', async () => {
    const r = await run();
    expect(r.orderMeta).toEqual({
      storeCodes: [REAL_EXPECTED_STORE],
      periodFrom: '2026/08/01',
      periodTo: '2026/08/31',
      periods: [{ from: '2026/08/01', to: '2026/08/31' }],
    });
  });

  it('集計期間が1種類のみで、混在していない（W017 なし）', async () => {
    const r = await run();
    expect(r.orderMeta?.periods).toHaveLength(1);
    expect(r.issues.filter((i) => i.code === 'W017')).toEqual([]);
  });

  it('対象年月が発注累計の期間と食い違うと E004 で止まる', async () => {
    const r = await run('2026-09');
    expect(r.issues.filter((i) => i.code === 'E004')).toHaveLength(1);
    expect(r.hasBlocking).toBe(true);
  });

  // 「1エラーに対して1エラーメッセージ」。同じコードが並ぶと重要な指摘が埋もれる。
  describe('1事象1メッセージ（実データでの担保）', () => {
    it('同じコードのメッセージが同一ファイル内で重複しない', async () => {
      const r = await run();
      const seen = new Map<string, number>();
      for (const i of r.issues) {
        const key = `${i.code}|${i.ref.fileName ?? ''}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      const duplicated = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
      expect(duplicated).toEqual([]);
    });

    it('メッセージ本文にコード接頭辞（E005: など）を含めない', async () => {
      const r = await run();
      expect(r.issues.filter((i) => /^[EWI]\d{3}\s*[:：]/.test(i.message)).map((i) => i.message)).toEqual(
        [],
      );
    });

    it('まとめたメッセージは件数と内訳を持つ', async () => {
      const r = await run();
      for (const i of r.issues.filter((x) => x.count > 1)) {
        expect(i.details).toHaveLength(i.count);
        expect(i.message).toMatch(new RegExp(String.raw`${i.count}\s*(件|個|コード|種類|商品|行|組|列)`));
      }
    });

    it('全メッセージが空でなく、末尾が句点で終わる', async () => {
      const r = await run();
      const bad = r.issues.filter((i) => i.message.trim() === '' || !i.message.endsWith('。'));
      expect(bad.map((i) => `${i.code}: ${i.message}`)).toEqual([]);
    });
  });

  it('単位計算マスタの重複3件を W014 で報告する（メッセージは1件）', async () => {
    const r = await run();
    const w014 = r.issues.filter((i) => i.code === 'W014');
    expect(w014).toHaveLength(1);
    expect(w014[0]!.count).toBe(3);
  });

  it('換算係数がマスタP列と単位計算マスタで食い違わない（W009 なし）', async () => {
    const r = await run();
    expect(r.issues.filter((i) => i.code === 'W009').map((i) => i.message)).toEqual([]);
  });

  it('当月使用高がマイナスになる商品がない', async () => {
    const r = await run();
    expect(r.issues.filter((i) => i.code === 'W012').map((i) => i.message)).toEqual([]);
  });
});

describe.skipIf(available)('発注累計照会 未配置', () => {
  it('ファイルが無いためスキップした', () => {
    expect(available).toBe(false);
  });
});
