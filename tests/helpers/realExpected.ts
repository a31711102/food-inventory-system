/**
 * 実ファイル検証（L4）の期待値。
 *
 * 店舗の実業績値（売上高・使用高・原価率）はリポジトリに含めない。
 * `tests/fixtures/real/expected.json` に置き、このファイルから読む。
 * 無ければ null を返し、呼び出し側のテストはスキップする
 * （実ファイル本体が無いときと同じ扱い）。
 *
 * 構造の見本は `tests/fixtures/real/expected.example.json`（値はダミー）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MonthlyExpected {
  totalSales: number;
  totalUsageAmount: number;
  totalClosingAmount?: number;
  costAfterLoss?: number;
  costRateAfterLossPercent: number;
  saladVegetableUsage: number;
}

/** リアル売上算出の実データ期待値（要件§11.10 RS-01〜03） */
export interface RealSalesExpected {
  /** 写真から読み取った値（人が確認したもの） */
  journal: {
    businessYm: string;
    storeName: string;
    grossTotal: string;
    discountTotal: string;
    discountTax: string;
    receivableTotal: string;
    receivables: { label: string; amount: string }[];
  };
  /** 料率マスタ（店舗の契約情報） */
  rates: { id: string; rate: string }[];
  containerPrice: string;
  csvRows: number;
  includedRows: number;
  containerQty: number;
  csvAmountTotal: number;
  feeTotal: string;
  containerCost: string;
  realSales: string;
}

/** 店舗オーナーの「リアル売上算出」Excel と、その月のジャーナルの値 */
export interface SeptemberExpected {
  journal: RealSalesExpected['journal'];
  csvAmountTotal: number;
  /** Excel の「チャンネル／売上」の表にある行（表記はExcelのまま） */
  sheetChannels: { label: string; amount: string }[];
  /** Excel の弁当容器の表にある出数 */
  sheetContainerQty: number;
}

export interface RealExpected {
  /** 発注累計照会に入っている店舗コード */
  storeCode: string;
  august: MonthlyExpected;
  july: MonthlyExpected;
  june: Omit<MonthlyExpected, 'totalClosingAmount' | 'costAfterLoss'>;
  /** 無ければリアル売上の実データ検証はスキップする */
  realSales?: { august: RealSalesExpected; september?: SeptemberExpected };
}

const PATH = process.env['REAL_EXPECTED'] ?? join('tests', 'fixtures', 'real', 'expected.json');

function load(): RealExpected | null {
  if (!existsSync(PATH)) return null;
  try {
    return JSON.parse(readFileSync(PATH, 'utf-8')) as RealExpected;
  } catch {
    return null;
  }
}

/** 期待値。未配置なら null（テストはスキップする） */
export const REAL_EXPECTED = load();

/** 店舗コード。未配置なら空文字（テストはスキップされるので使われない） */
export const REAL_EXPECTED_STORE = REAL_EXPECTED?.storeCode ?? '';
