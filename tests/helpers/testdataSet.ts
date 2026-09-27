/**
 * 画面テスト用のサンプルデータ一式。
 *
 * 手動テスト（`npm run testdata` → docs/06_画面テスト手順書.md）と
 * 自動の画面テスト（tests/ui/）が**同じデータ**を使うための共有定義。
 * 片方だけ直すと手順書の期待値と自動テストがずれるため、必ずここを直す。
 *
 * 店舗の実データは使わない。実帳票と同じ構造（入力用: 見出し行2・データ行3〜、
 * J/L/M に数式、U/V に SUMIF、分析用: C4/K7/C22/L11/L14）を合成して作る。
 */
import { buildSyntheticWorkbook, type SyntheticRow } from './buildXlsx';

export const TARGET_YM = '2026-09';
export const PREVIOUS_YM = '2026-08';
/** テスト用の架空の売上高。実店舗の数字は使わない */
export const TOTAL_SALES = 5_000_000;

/**
 * 前月(8月)の完成棚卸表。期首引継ぎ元かつ前月比較の対象。
 * 000999 は当月マスタから消える商品で、期末残があるため W001 が出る。
 */
export const PREV_ROWS: SyntheticRow[] = [
  { code: '000140', name: '２Ｎ甘口ポークソース１．６５ｋｇ', category: '01.ソース', unitPrice: 1791, openingQty: 2, purchaseQty: 4, closingQty: 3 },
  { code: '000158', name: '甘口ポークソース２．２ｋｇＲ８', category: '01.ソース', unitPrice: 1194, openingQty: 5, purchaseQty: 76, closingQty: 7 },
  { code: '000155', name: '２．２Ｎポークソース４ｋｇＲ６', category: '01.ソース', unitPrice: 4972, openingQty: 5, purchaseQty: 116, closingQty: 6 },
  { code: '006747', name: '特原を使用しないカレー１２袋', category: '01.ソース', unitPrice: 104, conversionFactor: 12, openingQty: 12, purchaseQty: 0, closingQty: 6 },
  { code: '001868', name: 'クリームコロッケ（Ｈ６）', category: '03.主食材Ｂ', unitPrice: 50, conversionFactor: 40, openingQty: 44, purchaseQty: 240, closingQty: 10 },
  { code: 'A00043', name: 'キャベツ(自店購入）', category: '09.野菜', unitPrice: 273, openingQty: 0, purchaseQty: 24, closingQty: 2 },
  { code: '001250', name: 'ミニトマト', category: '09.野菜', unitPrice: 429, openingQty: 0, purchaseQty: 22, closingQty: 1 },
  { code: '041303', name: 'ドリンク提供付属品セット第１弾', category: '16.靴他', unitPrice: 13850, openingQty: 0, purchaseQty: 0, closingQty: 0 },
  { code: '000999', name: '旧カレールウ（取扱終了）', category: '01.ソース', unitPrice: 800, openingQty: 4, purchaseQty: 0, closingQty: 3 },
];

/**
 * 当月(9月)マスタ。店舗が期末在庫だけ入力した状態。
 * 取り込むと期首は前月期末から、期中仕入は発注累計から埋まる。
 */
export const CURRENT_ROWS: SyntheticRow[] = [
  { code: '000140', name: '２Ｎ甘口ポークソース１．６５ｋｇ', category: '01.ソース', unitPrice: 1791, openingQty: 0, purchaseQty: 0, closingQty: 2 },
  // 商品名が変わった → W002
  { code: '000158', name: '甘口ポークソース２．２ｋｇＲ８（新）', category: '01.ソース', unitPrice: 1194, openingQty: 0, purchaseQty: 0, closingQty: 9 },
  // 分類が変わった → W003（使用高の集計先が移る）
  { code: '000155', name: '２．２Ｎポークソース４ｋｇＲ６', category: '02.主食材Ａ', unitPrice: 4972, openingQty: 0, purchaseQty: 0, closingQty: 4 },
  { code: '006747', name: '特原を使用しないカレー１２袋', category: '01.ソース', unitPrice: 104, conversionFactor: 12, openingQty: 0, purchaseQty: 0, closingQty: 5 },
  { code: '001868', name: 'クリームコロッケ（Ｈ６）', category: '03.主食材Ｂ', unitPrice: 50, conversionFactor: 40, openingQty: 0, purchaseQty: 0, closingQty: 12 },
  // 自店購入品。発注累計に現れないので STEP 4 で入力する。
  // 4桁の本部コードでも自店購入になる（2026-09-27 確認。Aコードかどうかでは決まらない）
  { code: 'A00043', name: 'キャベツ(自店購入）', category: '09.野菜', unitPrice: 273, openingQty: 0, purchaseQty: 0, closingQty: 1 },
  { code: '001250', name: 'ミニトマト', category: '09.野菜', unitPrice: 429, openingQty: 0, purchaseQty: 0, closingQty: 0 },
  // 備品（数値部が5桁）。この棚卸表の計算対象外
  { code: '041303', name: 'ドリンク提供付属品セット第１弾', category: '16.靴他', unitPrice: 13850, openingQty: 0, purchaseQty: 0, closingQty: 0 },
  // 新規商品 → W004。発注があるが単位計算マスタに無いため W016・W019 も出る
  { code: '002100', name: '新商品ホワイトソース２ｋｇ', category: '01.ソース', unitPrice: 980, conversionFactor: 3, openingQty: 0, purchaseQty: 0, closingQty: 3 },
  { code: '002101', name: '新商品デミグラスソース１ｋｇ', category: '01.ソース', unitPrice: 720, conversionFactor: 1, openingQty: 0, purchaseQty: 0, closingQty: 0 },
];

const ORDER_HEADER = '店舗コード,店舗名,納品日From,納品日To,原材料コード,原材料名,発注数,単位,金額';
const order = (code: string, name: string, qty: string | number, from = '2026/09/01', to = '2026/09/30'): string =>
  `1930,テスト店,${from},${to},${code},${name},${qty},袋,0`;

const UNIT_HEADER = '原材料コード,原材料名,計算単位';

export const ORDER_CSV = [
  ORDER_HEADER,
  order('000140', '２Ｎ甘口ポークソース１．６５ｋｇ', 4),
  order('000158', '甘口ポークソース２．２ｋｇＲ８', 60),
  order('001868', 'クリームコロッケ（Ｈ６）', 6),
  order('002100', '新商品ホワイトソース２ｋｇ', 3),
  // 当月マスタに無い食材 → W011
  order('009001', '取扱終了ソース', 2),
  // 備品（5桁）→ I004。計算対象外なので期中仕入に入らない
  order('040416', 'ポリ袋小・長', 10),
];

export const UNIT_CSV = [
  UNIT_HEADER,
  '000140,２Ｎ甘口ポークソース１．６５ｋｇ,1',
  '000158,甘口ポークソース２．２ｋｇＲ８,1',
  '001868,クリームコロッケ（Ｈ６）,40',
  // 同じコードが2行。計算単位が同じなので W014（警告）で通る
  '001868,クリームコロッケ（Ｈ６）,40',
  '009001,取扱終了ソース,1',
  '040416,ポリ袋小・長,1',
];

// ---------------------------------------------------------------------------
// CP932（Shift_JIS）エンコード
// ---------------------------------------------------------------------------

/**
 * CP932 のエンコード表を、標準のデコーダから逆算して作る。
 * 本番の発注累計照会は CP932 で出力されるため、テストデータも同じ文字コードにする
 * （UTF-8 で作ると文字コード判定の経路を通らず、観点 G-7 を確認できない）。
 */
function buildCp932Table(): Map<string, number[]> {
  const decoder = new TextDecoder('shift_jis');
  const map = new Map<string, number[]>();
  for (let b = 0x20; b <= 0x7e; b += 1) map.set(String.fromCharCode(b), [b]);
  for (let hi = 0x81; hi <= 0xfc; hi += 1) {
    if (hi >= 0xa0 && hi <= 0xdf) continue; // 半角カナ領域
    for (let lo = 0x40; lo <= 0xfc; lo += 1) {
      if (lo === 0x7f) continue;
      const ch = decoder.decode(Uint8Array.from([hi, lo]));
      if (ch.length !== 1 || ch === '�' || map.has(ch)) continue;
      map.set(ch, [hi, lo]);
    }
  }
  return map;
}

let cp932: Map<string, number[]> | null = null;

export function encodeCp932(text: string): Uint8Array {
  cp932 ??= buildCp932Table();
  const out: number[] = [];
  for (const ch of text) {
    if (ch === '\r') { out.push(0x0d); continue; }
    if (ch === '\n') { out.push(0x0a); continue; }
    const bytes = cp932.get(ch);
    if (!bytes) throw new Error(`CP932 に変換できない文字が含まれています: ${ch}`);
    out.push(...bytes);
  }
  return Uint8Array.from(out);
}

export function csvBytes(lines: readonly string[]): Uint8Array {
  return encodeCp932(lines.join('\r\n') + '\r\n');
}

// ---------------------------------------------------------------------------
// ファイル一式
// ---------------------------------------------------------------------------

export interface TestFile {
  name: string;
  bytes: Uint8Array;
  /** 手順書の説明。生成スクリプトの出力に使う */
  note: string;
}

/** 正常系4ファイル。正しい欄に入れたときエラーは0件になる。 */
export async function buildNormalSet(): Promise<Record<'master' | 'previous' | 'orders' | 'unitMaster', TestFile>> {
  return {
    master: {
      name: '01_当月マスタ_2026-09.xlsx',
      bytes: await buildSyntheticWorkbook({ rows: CURRENT_ROWS, totalSales: TOTAL_SALES, monthLabel: '2026年9月' }),
      note: '① 当月本部マスタ。継続6件＋新規2件、商品名変更1件・分類変更1件',
    },
    previous: {
      name: '02_前月棚卸表_2026-08.xlsx',
      bytes: await buildSyntheticWorkbook({ rows: PREV_ROWS, totalSales: 6000000, monthLabel: '2026年8月' }),
      note: '② 前月食品棚卸表。7件、うち1件は当月に無く期末残あり',
    },
    orders: {
      name: '03_発注累計照会_2026-09.csv',
      bytes: csvBytes(ORDER_CSV),
      note: '③ 発注累計照会。5行、うち1行は当月マスタに無い消耗品',
    },
    unitMaster: {
      name: '04_単位計算マスタ_2026-09.csv',
      bytes: csvBytes(UNIT_CSV),
      note: '④ 単位計算マスタ。4件、うち1件は同値で重複',
    },
  };
}

/** 異常系。1ファイルにつき1事象だけを仕込む。 */
export async function buildAbnormalSet(): Promise<TestFile[]> {
  return [
    {
      name: 'ng_E002_コード重複.xlsx',
      bytes: await buildSyntheticWorkbook({
        rows: [...CURRENT_ROWS, { ...CURRENT_ROWS[0]!, name: '２Ｎ甘口ポークソース（重複行）', closingQty: 1 }],
        totalSales: TOTAL_SALES,
      }),
      note: '① と差し替える。E002',
    },
    {
      name: 'ng_E003_E013_コード空欄とNaN.xlsx',
      bytes: await buildSyntheticWorkbook({
        rows: [
          ...CURRENT_ROWS,
          // 全角スペースだけのセル → E003。完全な空セルは「データの終わり」として読み飛ばす
          { code: '　', name: 'コードが空白の行', category: '01.ソース', unitPrice: 100, closingQty: 1 },
          // 現行ツールが空欄を "NaN" と書き出した行 → E013
          { code: 'NaN', name: 'コードがNaNの行', category: '01.ソース', unitPrice: 100, closingQty: 1 },
        ],
        totalSales: TOTAL_SALES,
      }),
      note: '① と差し替える。E003・E013',
    },
    {
      name: 'ng_E005_換算係数なし.xlsx',
      bytes: await buildSyntheticWorkbook({
        // 発注のある 002100 の係数が単位計算マスタにも当月マスタにも無い
        rows: CURRENT_ROWS.map((r) => (r.code === '002100' ? { ...r, conversionFactor: 0 } : r)),
        totalSales: TOTAL_SALES,
      }),
      note: '① と差し替える。E005（出力がブロックされる）',
    },
    {
      name: 'ng_I001_コードが数値型.xlsx',
      bytes: await buildSyntheticWorkbook({ rows: CURRENT_ROWS, totalSales: TOTAL_SALES, codesAsNumbers: true }),
      note: '① と差し替える。I001（先頭ゼロ喪失の予兆）',
    },
    {
      name: 'ng_W005_E011_売上高なし.xlsx',
      bytes: await buildSyntheticWorkbook({ rows: CURRENT_ROWS, totalSales: null }),
      note: '① と差し替える。W005（画面で売上高を入力すると解消）',
    },
    {
      name: 'ng_E015_期末在庫がマイナス.xlsx',
      bytes: await buildSyntheticWorkbook({
        // 期末在庫は手入力の実在庫。負になることは物理的にあり得ないので処理を止める
        rows: CURRENT_ROWS.map((r) => (r.code === '000140' ? { ...r, closingQty: -2 } : r)),
        totalSales: TOTAL_SALES,
      }),
      note: '① と差し替える。E015（出力がブロックされる）',
    },
    {
      name: 'ng_W012_W013_使用高マイナスと未知分類.xlsx',
      bytes: await buildSyntheticWorkbook({
        rows: [
          ...CURRENT_ROWS,
          { code: '003100', name: '期末が多すぎる商品', category: '01.ソース', unitPrice: 500, openingQty: 0, purchaseQty: 0, closingQty: 99 },
          { code: '003200', name: '未知分類の商品', category: '99.新しい分類', unitPrice: 500, openingQty: 0, purchaseQty: 0, closingQty: 1 },
        ],
        totalSales: TOTAL_SALES,
      }),
      note: '① と差し替える。W012・W013',
    },
    {
      name: 'ng_W023_発注累計_返品行あり.csv',
      bytes: csvBytes([
        ORDER_HEADER,
        order('000140', '２Ｎ甘口ポークソース１．６５ｋｇ', 4),
        // 返品（発注数がマイナス）。年数回しか起きないが、起きたら知らせる
        order('000158', '甘口ポークソース２．２ｋｇＲ８', -3),
      ]),
      note: '③ と差し替える。W023（期中仕入から差し引いたことを知らせる）',
    },
    {
      name: 'ng_E001_発注累計_列名ちがい.csv',
      bytes: csvBytes([
        // 「発注数」が「数量」になっている（本部の帳票改訂を模す）
        '店舗コード,店舗名,納品日From,納品日To,原材料コード,原材料名,数量,単位,金額',
        '1930,テスト店,2026/09/01,2026/09/30,000140,２Ｎ甘口ポークソース１．６５ｋｇ,4,袋,0',
      ]),
      note: '③ と差し替える。E001',
    },
    {
      name: 'ng_E004_発注累計_別の月.csv',
      bytes: csvBytes([ORDER_HEADER, order('000140', '２Ｎ甘口ポークソース１．６５ｋｇ', 4, '2026/08/01', '2026/08/31')]),
      note: '③ と差し替える。E004（出力がブロックされる）',
    },
    {
      name: 'ng_E007_発注累計_発注数が文字.csv',
      bytes: csvBytes([ORDER_HEADER, order('000140', '２Ｎ甘口ポークソース１．６５ｋｇ', '約4')]),
      note: '③ と差し替える。E007',
    },
    {
      name: 'ng_W015_発注累計_期間が月末でない.csv',
      bytes: csvBytes([ORDER_HEADER, order('000140', '２Ｎ甘口ポークソース１．６５ｋｇ', 4, '2026/09/01', '2026/09/25')]),
      note: '③ と差し替える。W015',
    },
    {
      name: 'ng_W017_発注累計_期間混在.csv',
      bytes: csvBytes([
        ORDER_HEADER,
        order('000140', '２Ｎ甘口ポークソース１．６５ｋｇ', 4),
        order('000158', '甘口ポークソース２．２ｋｇＲ８', 60, '2026/08/01', '2026/08/31'),
      ]),
      note: '③ と差し替える。W017',
    },
    {
      name: 'ng_E012_単位計算マスタ_矛盾.csv',
      bytes: csvBytes([
        UNIT_HEADER,
        '000140,２Ｎ甘口ポークソース１．６５ｋｇ,1',
        // 同じコードで計算単位が違う → E012（処理を止める）
        '000140,２Ｎ甘口ポークソース１．６５ｋｇ,20',
      ]),
      note: '④ と差し替える。E012（出力がブロックされる）',
    },
  ];
}
