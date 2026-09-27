import { describe, it, expect } from 'vitest';
import { computeDerived, computeUsageQty, computeUsageAmount, computeClosingAmount } from '@/domain/calculation';
import type { ProductRow } from '@/domain/models';
import { unsafeProductCode } from '@/domain/productCode';

function row(partial: Partial<ProductRow>): ProductRow {
  return {
    lineNo: 3,
    code: unsafeProductCode('000140'),
    name: 'テスト商品',
    inventoryUnit: '袋',
    category: '01.ソース',
    unitPrice: 0,
    conversionFactor: 1,
    closingQty: 0,
    purchaseQty: 0,
    openingQty: 0,
    status: 'CONTINUED',
    isOwnPurchase: false,
    isSupply: false,
    openingApproved: true,
    usageQty: null,
    usageAmount: null,
    closingAmount: null,
    ...partial,
  };
}

describe('期中使用量 J = 期中仕入H + 期首在庫I − 期末在庫G', () => {
  it('実帳票 000158 甘口ポークソース２．２ｋｇＲ８ を再現する', () => {
    // G=7, H=76, I=5 → J = 76 + 5 - 7 = 74
    expect(computeUsageQty({ closingQty: 7, purchaseQty: 76, openingQty: 5 })).toBe(74);
  });

  it('実帳票 000155 ２．２Ｎポークソース４ｋｇＲ６ を再現する', () => {
    expect(computeUsageQty({ closingQty: 6, purchaseQty: 116, openingQty: 5 })).toBe(115);
  });

  it('実帳票 006747 特原を使用しないカレー１２袋（発注なし）を再現する', () => {
    expect(computeUsageQty({ closingQty: 6, purchaseQty: 0, openingQty: 12 })).toBe(6);
  });

  it('全てゼロなら0', () => {
    expect(computeUsageQty({ closingQty: 0, purchaseQty: 0, openingQty: 0 })).toBe(0);
  });

  it('期末在庫が期首+仕入を上回ると負になる（W012の検知対象）', () => {
    expect(computeUsageQty({ closingQty: 10, purchaseQty: 0, openingQty: 3 })).toBe(-7);
  });
});

describe('当月使用高 L = 単価K × 期中使用量J', () => {
  it('実帳票 000158 を再現する', () => {
    // K=1194, J=74
    expect(computeUsageAmount(1194, 74)).toBe(88356);
  });

  it('実帳票 000155 を再現する', () => {
    expect(computeUsageAmount(4972, 115)).toBe(571780);
  });

  it('小数単価でもExcelと同じ倍精度演算で一致する', () => {
    // 001400 パックライス３０個入（国産）の単価
    expect(computeUsageAmount(253.56666667, 37)).toBe(253.56666667 * 37);
  });

  it('期中使用量が負なら使用高も負', () => {
    expect(computeUsageAmount(100, -3)).toBe(-300);
  });
});

describe('期末在庫高 M = 期末在庫G × 単価K', () => {
  it('実帳票 000158 を再現する', () => {
    expect(computeClosingAmount(7, 1194)).toBe(8358);
  });

  it('実帳票 006747 を再現する', () => {
    expect(computeClosingAmount(6, 104)).toBe(624);
  });
});

describe('computeDerived', () => {
  it('明細1行の導出値をまとめて設定する', () => {
    const r = computeDerived(row({ closingQty: 7, purchaseQty: 76, openingQty: 5, unitPrice: 1194 }));
    expect(r.usageQty).toBe(74);
    expect(r.usageAmount).toBe(88356);
    expect(r.closingAmount).toBe(8358);
  });

  it('入力オブジェクトを破壊せず新しい行を返す', () => {
    const src = row({ closingQty: 7, purchaseQty: 76, openingQty: 5, unitPrice: 1194 });
    const out = computeDerived(src);
    expect(src.usageQty).toBeNull();
    expect(out).not.toBe(src);
  });

  it('丸めを行わない（現行Excelが丸めていないため）', () => {
    // 006017 濃厚バニラアイス４７個入 の単価。十進では 526.27659573 だが、
    // IEEE754 倍精度では 526.2765957299999 になる。Excel も同じ倍精度で計算しているため
    // この末尾まで一致することが「現行帳票と一致する」ことを意味する。
    // ここで丸めると逆に Excel と乖離する。
    const r = computeDerived(row({ closingQty: 0, purchaseQty: 3, openingQty: 0, unitPrice: 175.42553191 }));
    expect(r.usageAmount).toBe(175.42553191 * 3);
    expect(r.usageAmount).toBe(526.2765957299999);
  });
});
