import { describe, it, expect } from 'vitest';
import { add, fromInt, mul, parseDecimal, sub, toDecimalString, toNumber, type Fixed } from '@/domain/realSales/fixed';

const d = (s: string): Fixed => parseDecimal(s)!;

describe('十進固定小数（要件§11.2 途中で丸めない）', () => {
  it('カンマ・円記号つきの金額と小数の料率を読む', () => {
    expect(toDecimalString(d('¥1,234,567'))).toBe('1234567');
    expect(toDecimalString(d('0.275'))).toBe('0.275');
    expect(toDecimalString(d('-12.5'))).toBe('-12.5');
  });

  it('読めない値・小数7桁以上は null（丸めて受け付けない）', () => {
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('1.2345678')).toBeNull();
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal(null)).toBeNull();
  });

  it('倍精度だと手数料の合計に誤差が出るが、十進なら出ない', () => {
    const asDouble = 2345 * 0.2 + 30003 * 0.275 + 123457 * 0.33 + 9876 * 0.33 + 1001 * 0.33 + 45679 * 0.15;
    expect(asDouble).toBe(59901.89500000001); // 倍精度の誤差
    const exact = add(
      mul(d('2345'), d('0.2')),
      mul(d('30003'), d('0.275')),
      mul(d('123457'), d('0.33')),
      mul(d('9876'), d('0.33')),
      mul(d('1001'), d('0.33')),
      mul(d('45679'), d('0.15')),
    );
    expect(toDecimalString(exact)).toBe('59901.895');
  });

  it('引き算まで含めて丸めず、Excel へは十進表記に最も近い倍精度値で渡す', () => {
    const real = sub(sub(d('1234567'), d('59901.895')), mul(fromInt(255), d('40')));
    expect(toDecimalString(real)).toBe('1164465.105');
    expect(toNumber(real)).toBe(1164465.105);
  });

  it('小数6桁に収まらない掛け算は丸めずに例外にする', () => {
    expect(() => mul(d('0.001'), d('0.0001'))).toThrow();
  });
});
