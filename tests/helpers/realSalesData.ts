/**
 * リアル売上算出のテストデータ（**すべて架空の値**）。
 *
 * このリポジトリは公開しているため、店舗の売上・料率・容器単価は使わない。
 * 実データでの受入（2026年8月の期待値）は tests/integration/realSalesFiles.test.ts が
 * gitignore 済みの tests/fixtures/real/expected.json から読んで検証する。
 *
 * 架空の値でも、実データと同じ性質を持たせてある。
 *  - 写真の表記ゆれ（「UEらーめん代」）と対象外の売掛項目（ナカペイ・モバイル・C）
 *  - 検算①（売掛合計）と②（CSV の売上金額合計）が1円単位で成立する
 *  - 倍精度で合計すると誤差が出る（59901.89500000001）が、十進なら 59901.895
 */
import type { JournalEntry } from '@/domain/realSales/compute';
import { channelRow, DEFAULT_MASTERS, type RealSalesMasters } from '@/domain/realSales/masters';

/** 架空の料率・容器単価を入れたマスタ */
export function testMasters(): RealSalesMasters {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_MASTERS)),
    channels: [
      channelRow('menu', '0.2'),
      channelRow('sharedeli', '0.275'),
      channelRow('ue-delivery', '0.33'),
      channelRow('ue-menya', '0.33'),
      channelRow('ue-ramen', '0.33'),
      channelRow('rocketnow', '0.15'),
    ],
    containerPrices: [{ price: '40', validFrom: '2000-01', validTo: null }],
  } as RealSalesMasters;
}

/** 架空のジャーナル（写真の印字どおりの表記で並べる） */
export const TEST_JOURNAL: JournalEntry = {
  businessYm: '2026-08',
  storeName: 'テスト店',
  grossTotal: '1234567',
  discountTotal: '1000',
  discountTax: '80',
  receivableTotal: '245694',
  receivables: [
    { label: 'ナカペイ', amount: '11111' },
    { label: 'menu', amount: '2345' },
    { label: 'シェアデリ', amount: '30003' },
    { label: 'UE配達代行', amount: '123457' },
    { label: 'モバイル・C', amount: '22222' },
    { label: 'UE麺屋代行', amount: '9876' },
    { label: 'UEらーめん代', amount: '1001' },
    { label: 'ロケットナウ', amount: '45679' },
  ],
};

/** 期待値（上の値から手計算したもの） */
export const TEST_EXPECTED = {
  feeTotal: '59901.895',
  fees: {
    menu: '469',
    シェアデリ: '8250.825',
    UE配達代行: '40740.81',
    UE麺屋代行: '3259.08',
    UEラーメン代行: '330.33',
    ロケットナウ: '6851.85',
  },
  containerQty: 255,
  excludedQty: 570,
  containerCost: '10200',
  realSales: '1164465.105',
  /** 総計1 − 値割引合計 + 値割引消費税 */
  csvAmountTotal: 1233647,
};

/**
 * 画面テストで STEP 5（売上計算）を通すための架空の一式。
 *
 * 確定値がちょうど TOTAL_SALES（当月マスタの分析用 C4 と同じ 5,000,000）になるようにしてある。
 * こうしておくと、売上計算を挟んでも分析・出力の期待値が変わらない。
 *   5,075,000 −（250,000 × 0.2）−（625 × 40）= 5,000,000
 * 検算①（売掛合計＝内訳）と②（総計1 − 値割引 + 税 ＝ CSV の売上金額合計）はどちらも成立する。
 */
export const HARNESS_SALES = {
  grossTotal: '5075000',
  receivableLabel: 'menu',
  receivableAmount: '250000',
  containerQty: 625,
  realSales: 5_000_000,
};

/** 上の一式に対応するマスタ（写真に出るチャネルだけ。W027 を出さない） */
export function harnessMasters(): RealSalesMasters {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_MASTERS)),
    channels: [channelRow('menu', '0.2')],
    containerPrices: [{ price: '40', validFrom: '2000-01', validTo: null }],
  } as RealSalesMasters;
}

/** 上の一式に対応する商品別売上CSV（対象出数 625、売上金額合計 5,075,000） */
export function harnessSalesCsv(): Uint8Array {
  return buildProductSalesCsv([['カレー', 'テイクアウト_カレー', 'TO_カレー（A）', HARNESS_SALES.containerQty, 5_075_000]]);
}

const HEADER = '大分類,中分類,小分類,商品コード,商品名,価格,販売数,販売数構成比,一日当たり平均販売数,10万円当たり,売上金額,売上金額構成比';

/** [大分類, 中分類, 小分類, 販売数, 売上金額] */
export type SalesRow = [string, string, string, number, number];

/** 対象 255個（115 + 85 + 22 + 33）、除外トッピング 570個。売上金額の合計は 1,233,647 */
export const TEST_SALES_ROWS: SalesRow[] = [
  ['カレー', 'イートイン_カレー', 'EI_カレー（A）', 400, 1233647],
  ['カレー', 'イートイン_カレー', 'EI_トッピング', 900, 0],
  ['カレー', 'テイクアウト_カレー', 'TO_カレー（A）', 100, 0],
  ['カレー', 'テイクアウト_カレー', 'TO_カレー2品MIX（A）', 10, 0],
  ['カレー', 'テイクアウト_カレー', 'TO_生ソース（A）', 5, 0],
  ['カレー', 'テイクアウト_カレー', 'TO_トッピング', 300, 0],
  ['カレー', '代行_カレー', 'HD_カレー（A）', 80, 0],
  ['カレー', '代行_カレー', 'HD_カレー2品MIX（A）', 4, 0],
  ['カレー', '代行_カレー', 'HD_生ソース（A）', 1, 0],
  ['カレー', '代行_カレー', 'HD_トッピング', 200, 0],
  ['サラダ', 'テイクアウト_サラダ', 'TO_サラダ', 12, 0],
  ['期間限定', 'イートイン_期間限定', 'EI_カレー（A）', 60, 0],
  ['期間限定', 'テイクアウト_期間限定', 'TO_カレー（A）', 20, 0],
  ['期間限定', 'テイクアウト_期間限定', 'TO_生ソース（A）', 2, 0],
  ['期間限定', 'テイクアウト_期間限定', 'TO_トッピング', 30, 0],
  ['期間限定', '代行_期間限定', 'HD_カレー（A）', 30, 0],
  ['期間限定', '代行_期間限定', 'HD_生ソース（A）', 3, 0],
  ['期間限定', '代行_期間限定', 'HD_トッピング', 40, 0],
];

export function buildProductSalesCsv(rows: SalesRow[] = TEST_SALES_ROWS, header = HEADER): Uint8Array {
  const lines = [header, ...rows.map(([b, m, s, q, a], i) => `${b},${m},${s},${i + 1},商品${i + 1},0,${q},0%,0,0,${a},0%`)];
  return new TextEncoder().encode(lines.join('\r\n'));
}
