/**
 * 商品の種別判定（備品・自店購入）。
 *
 * どちらも 2026-09-27 に本部・店舗オーナーへ確認して確定したルール（要件§10-2）。
 * 判定を間違えると集計対象や入力画面の候補が変わるため、境界を固定しておく。
 */
import { describe, it, expect } from 'vitest';
import {
  codeDigits,
  isSupplyCode,
  isOwnPurchase,
  DEFAULT_OWN_PURCHASE_CODES,
} from '@/domain/productKind';
import { unsafeProductCode } from '@/domain/productCode';

describe('codeDigits（先頭ゼロとAを除いた桁数）', () => {
  it.each([
    ['000140', 3], // 140
    ['001868', 4], // 1868
    ['006063', 4],
    ['041303', 5],
    ['020642', 5],
    ['A00043', 2], // 43
    ['A20309', 5], // 20309
  ])('%s は %i 桁', (code, expected) => {
    expect(codeDigits(code)).toBe(expected);
  });

  it('数値として読めないコードは0を返す', () => {
    expect(codeDigits('ABC')).toBe(0);
  });
});

describe('isSupplyCode（数値部が5桁なら備品）', () => {
  it('実データの備品を備品と判定する', () => {
    // セレクトボックス・ギフト・ドリンク提供付属品セットなど
    for (const code of ['020642', '020722', '040628', '041303', '041330', '041304']) {
      expect(isSupplyCode(code)).toBe(true);
    }
  });

  it('Aコードでも数値部が5桁なら備品', () => {
    expect(isSupplyCode('A20309')).toBe(true); // 日めくり「早起きの達人」
    expect(isSupplyCode('A10005')).toBe(true); // レターパック520
  });

  it('食材は備品にしない', () => {
    // 4桁だけでなく2桁・3桁の食材もある（01.ソース や 14.限定 に15件）
    for (const code of ['000140', '001868', '006063', '007193', '000012', 'A00043']) {
      expect(isSupplyCode(code)).toBe(false);
    }
  });

  it('境界：4桁は食材、5桁は備品、6桁も備品ではない', () => {
    expect(isSupplyCode('009999')).toBe(false); // 9999
    expect(isSupplyCode('010000')).toBe(true); // 10000
    expect(isSupplyCode('099999')).toBe(true); // 99999
    expect(isSupplyCode('100000')).toBe(false); // 100000（6桁）
  });
});

describe('isOwnPurchase（既定リストとの照合）', () => {
  const codes = new Set(DEFAULT_OWN_PURCHASE_CODES);

  it('既定リストは5品', () => {
    expect(DEFAULT_OWN_PURCHASE_CODES).toEqual([
      '006063', // 缶ビール６缶パック
      '001250', // ミニトマト
      'A00043', // キャベツ(自店購入）
      '005249', // コーラ１６０ＭＬ３０缶入
      '007193', // レモンハーフスライス５００ｇ１袋
    ]);
  });

  it('4品のうち3品は0始まりの本部コード（Aコードではない）', () => {
    // 「Aコード＝自店購入」という以前の判定は実態と合っていなかった
    const notA = DEFAULT_OWN_PURCHASE_CODES.filter((c) => !c.startsWith('A'));
    expect(notA).toHaveLength(4);
  });

  it('リストにあるコードだけを自店購入とする', () => {
    expect(isOwnPurchase(unsafeProductCode('006063'), codes)).toBe(true);
    expect(isOwnPurchase(unsafeProductCode('A00043'), codes)).toBe(true);
  });

  it('Aコードでもリストになければ自店購入にしない', () => {
    // A00049 牛乳(自店購入)・A10005 レターパック など、実データのAコード21件のうち
    // 自店購入はキャベツ1件だけだった
    expect(isOwnPurchase(unsafeProductCode('A00049'), codes)).toBe(false);
    expect(isOwnPurchase(unsafeProductCode('A10005'), codes)).toBe(false);
  });

  it('リストを差し替えられる（品目が増減したとき）', () => {
    const custom = new Set(['009999']);
    expect(isOwnPurchase(unsafeProductCode('009999'), custom)).toBe(true);
    expect(isOwnPurchase(unsafeProductCode('006063'), custom)).toBe(false);
  });
});
