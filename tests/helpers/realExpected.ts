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

export interface RealExpected {
  /** 発注累計照会に入っている店舗コード */
  storeCode: string;
  august: MonthlyExpected;
  july: MonthlyExpected;
  june: Omit<MonthlyExpected, 'totalClosingAmount' | 'costAfterLoss'>;
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
