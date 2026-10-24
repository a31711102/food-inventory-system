/**
 * 十進の固定小数点（小数6桁）。
 *
 * リアル売上は要件§11.2で「途中で切り捨て・四捨五入しない」「浮動小数点誤差が
 * 受入結果に影響しないこと」が求められている。手数料を倍精度で合計すると、
 * 59901.895 が 59901.89500000001 になる（既存Excelの表示も同種の誤差を含む）。
 *
 * 値は 10^6 倍した BigInt で持つ。金額は整数円、料率は小数3桁程度なので、
 * 掛け算の結果も小数6桁に必ず収まる。収まらない掛け算は丸めずに例外にする
 * （黙って丸めると「丸めない」という要件を破るため）。
 */

const SCALE = 1_000_000n;
const DIGITS = 6;

export type Fixed = bigint & { readonly __brand: 'Fixed' };

const asFixed = (v: bigint): Fixed => v as Fixed;

export const ZERO = asFixed(0n);

export function fromInt(n: number | bigint): Fixed {
  if (typeof n === 'number' && !Number.isInteger(n)) {
    throw new Error(`整数ではありません: ${n}`);
  }
  return asFixed(BigInt(n) * SCALE);
}

/**
 * "0.275" "1,234,567" "¥1,000" "-12.5" を読む。小数7桁以上は丸めずに拒否する。
 * 読めなければ null（呼び出し側で「未入力」「不正値」として扱う）。
 */
export function parseDecimal(text: string | null | undefined): Fixed | null {
  if (text === null || text === undefined) return null;
  const t = text.trim().replace(/[,，¥￥\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const frac = m[3] ?? '';
  if (frac.length > DIGITS) return null;
  const v = BigInt(m[2]!) * SCALE + BigInt(frac.padEnd(DIGITS, '0') || '0');
  return asFixed(m[1] === '-' ? -v : v);
}

export function add(...xs: Fixed[]): Fixed {
  return asFixed(xs.reduce((a, b) => a + b, 0n));
}

export function sub(a: Fixed, b: Fixed): Fixed {
  return asFixed(a - b);
}

/** 掛け算。結果が小数6桁に収まらなければ例外（丸めない）。 */
export function mul(a: Fixed, b: Fixed): Fixed {
  const p = a * b;
  if (p % SCALE !== 0n) {
    throw new Error(`小数${DIGITS}桁に収まらない掛け算です（${toDecimalString(a)} × ${toDecimalString(b)}）`);
  }
  return asFixed(p / SCALE);
}

/** 余計な0を付けない十進表記。1164465.105 → "1164465.105"、10200 → "10200"。 */
export function toDecimalString(f: Fixed): string {
  const neg = f < 0n;
  const abs = neg ? -f : f;
  const int = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(DIGITS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/**
 * 倍精度へ。十進表記を経由するので、得られるのは「その十進数に最も近い倍精度値」になる。
 * Excel に書き込む値もこれ（1164465.105 は 1164465.105 として書かれ、Excel が同じ値を保持する）。
 */
export function toNumber(f: Fixed): number {
  return Number(toDecimalString(f));
}

export function isInteger(f: Fixed): boolean {
  return f % SCALE === 0n;
}

export function compare(a: Fixed, b: Fixed): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
