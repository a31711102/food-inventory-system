/**
 * 表示用の書式。
 *
 * 計算過程では丸めず、表示のときだけ丸める（設計書§7.5）。
 * 値が無いことと 0 は区別して表示する。新規・削除商品の欄を 0 と見せないため。
 */

export function formatAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Math.round(value).toLocaleString('ja-JP');
}

export function formatAmountPrecise(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
}

export function formatQty(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '算出不可';
  return `${value.toFixed(2)}%`;
}

export function formatPt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}pt`;
}

export function formatDiff(value: number | null | undefined, unit: '円' | 'pt'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (unit === 'pt') return formatPt(value);
  const sign = value > 0 ? '+' : '';
  return `${sign}${Math.round(value).toLocaleString('ja-JP')}`;
}

export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '算出不可';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export function previousYm(targetYm: string): string {
  const [y, m] = targetYm.split('-').map(Number);
  if (!y || !m) return targetYm;
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function defaultTargetYm(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
