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

/** 「今日」を画面に出すための表示用。対象年月が今日から導かれていることを示す。 */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 対象年月の初期値＝今日の前月。
 *
 * 棚卸は月末に数え、翌月に処理するのが通常の運用のため。
 * 固定値ではなく、画面を開いた日から毎月ずれていく。
 * 当月末に当月分を処理する場合や、過去の月をやり直す場合は STEP 1 で変更する。
 */
export function defaultTargetYm(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
