/**
 * リアル売上算出のマスタと、月ごとの売上算出方式の保存（ブラウザの localStorage）。
 *
 * 取込履歴と同じく、データベースを接続していなくても使えるようにする。
 * データベースへは「この処理結果を保存」のときに写しを残す（バックアップの対象になる）。
 * 保存先はこの店舗PCのブラウザだけで、外部へは送らない。
 */
import { DEFAULT_MASTERS, type RealSalesMasters } from '../domain/realSales/masters';
import type { SalesMethod } from '../app/pipeline';

const MASTERS_KEY = 'fis.realSales.masters.v1';
const HISTORY_KEY = 'fis.realSales.history.v1';

export interface SalesHistoryEntry {
  method: SalesMethod;
  realSales?: string;
  feeTotal?: string;
  containerQty?: number;
  confirmedAt?: string;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくても画面の操作は続けられる（次回また取り込む必要があるだけ）
  }
}

export function loadMasters(): RealSalesMasters {
  const m = read<RealSalesMasters>(MASTERS_KEY);
  if (!m || !Array.isArray(m.channels) || !Array.isArray(m.containerPrices)) return structuredClone(DEFAULT_MASTERS);
  // 抽出条件・対象外の一覧は、保存が無い・空なら初期値で補う
  return {
    channels: m.channels,
    containerPrices: m.containerPrices,
    ignoredPayments: Array.isArray(m.ignoredPayments) && m.ignoredPayments.length > 0 ? m.ignoredPayments : DEFAULT_MASTERS.ignoredPayments,
    extractRules: Array.isArray(m.extractRules) && m.extractRules.length > 0 ? m.extractRules : DEFAULT_MASTERS.extractRules,
  };
}

export function saveMasters(m: RealSalesMasters): void {
  write(MASTERS_KEY, m);
}

export function loadSalesHistory(): Record<string, SalesHistoryEntry> {
  return read<Record<string, SalesHistoryEntry>>(HISTORY_KEY) ?? {};
}

export function recordSales(ym: string, entry: SalesHistoryEntry): Record<string, SalesHistoryEntry> {
  const h = { ...loadSalesHistory(), [ym]: entry };
  write(HISTORY_KEY, h);
  return h;
}
