import { describe, it, expect } from 'vitest';
import { validateProductRows } from '@/domain/validation';
import { computeAllDerived } from '@/domain/calculation';
import { makeRow, code } from '../helpers/factories';

describe('E002 商品コード重複（要件§4・§5）', () => {
  it('同一コードが複数行にあれば E002 を出す', () => {
    const rows = [
      makeRow({ lineNo: 10, code: code('000140') }),
      makeRow({ lineNo: 55, code: code('000140') }),
    ];
    const issues = validateProductRows(rows);

    expect(issues.filter((i) => i.code === 'E002')).toHaveLength(1);
  });

  it('自動集約せず BLOCKING で止める', () => {
    const rows = [
      makeRow({ code: code('000140'), purchaseQty: 10 }),
      makeRow({ code: code('000140'), purchaseQty: 20 }),
    ];
    const issue = validateProductRows(rows).find((i) => i.code === 'E002');

    expect(issue?.level).toBe('BLOCKING');
  });

  it('該当する全行の行番号をメッセージに含める', () => {
    const rows = [
      makeRow({ lineNo: 10, code: code('000140') }),
      makeRow({ lineNo: 55, code: code('000140') }),
      makeRow({ lineNo: 91, code: code('000140') }),
    ];
    const issue = validateProductRows(rows).find((i) => i.code === 'E002');

    expect(issue?.message).toContain('10');
    expect(issue?.message).toContain('55');
    expect(issue?.message).toContain('91');
  });

  it('重複がなければ E002 を出さない', () => {
    const rows = [makeRow({ code: code('000140') }), makeRow({ code: code('000158') })];
    expect(validateProductRows(rows).filter((i) => i.code === 'E002')).toHaveLength(0);
  });

  it('先頭ゼロが異なるコードは別物として扱う', () => {
    const rows = [makeRow({ code: code('000140') }), makeRow({ code: code('140') })];
    expect(validateProductRows(rows).filter((i) => i.code === 'E002')).toHaveLength(0);
  });
});

describe('W012 当月使用高がマイナス', () => {
  // 分析用シートの注意書き「当月使用高がマイナスになってないか確認をお願いいたします」に対応
  it('使用高が負なら W012 を出す', () => {
    const rows = computeAllDerived([
      makeRow({ code: code('000140'), unitPrice: 100, closingQty: 10, purchaseQty: 0, openingQty: 3 }),
    ]);
    expect(validateProductRows(rows).filter((i) => i.code === 'W012')).toHaveLength(1);
  });

  it('使用高が0なら W012 を出さない', () => {
    const rows = computeAllDerived([
      makeRow({ unitPrice: 100, closingQty: 3, purchaseQty: 0, openingQty: 3 }),
    ]);
    expect(validateProductRows(rows).filter((i) => i.code === 'W012')).toHaveLength(0);
  });

  it('使用高が正なら W012 を出さない', () => {
    const rows = computeAllDerived([
      makeRow({ unitPrice: 100, closingQty: 1, purchaseQty: 5, openingQty: 0 }),
    ]);
    expect(validateProductRows(rows).filter((i) => i.code === 'W012')).toHaveLength(0);
  });

  it('警告に商品コードと行番号を含める', () => {
    const rows = computeAllDerived([
      makeRow({ lineNo: 42, code: code('000140'), unitPrice: 100, closingQty: 10, openingQty: 3 }),
    ]);
    const issue = validateProductRows(rows).find((i) => i.code === 'W012');

    expect(issue?.ref.rowNo).toBe(42);
    expect(issue?.ref.productCode).toBe('000140');
  });
});

describe('E015 期末在庫が負の値', () => {
  // 期末在庫は店舗が数えて手入力する実在庫。負になることは物理的にあり得ないため、
  // 入力誤りとみなして処理を止める（2026-09-27 店舗オーナーの判断）。
  it('負の期末在庫は BLOCKING で報告する', () => {
    const rows = computeAllDerived([
      makeRow({ lineNo: 10, code: code('000140'), closingQty: -3, unitPrice: 100 }),
    ]);
    const issue = validateProductRows(rows).find((i) => i.code === 'E015');

    expect(issue).toBeDefined();
    expect(issue!.level).toBe('BLOCKING');
    expect(issue!.message).toContain('期末在庫 -3');
    expect(issue!.message).toContain('元ファイルの期末在庫欄を確認して修正してください');
  });

  it('位置（行・商品コード）を示す', () => {
    const rows = computeAllDerived([
      makeRow({ lineNo: 42, code: code('000158'), closingQty: -1, unitPrice: 100 }),
    ]);
    const issue = validateProductRows(rows).find((i) => i.code === 'E015')!;

    expect(issue.ref.rowNo).toBe(42);
    expect(issue.ref.productCode).toBe('000158');
  });

  it('複数件でも1メッセージにまとめ、内訳を残す', () => {
    const rows = computeAllDerived([
      makeRow({ lineNo: 10, code: code('000140'), closingQty: -3, unitPrice: 100 }),
      makeRow({ lineNo: 11, code: code('000158'), closingQty: -1, unitPrice: 100 }),
    ]);
    const issues = validateProductRows(rows).filter((i) => i.code === 'E015');

    expect(issues).toHaveLength(1);
    expect(issues[0]!.count).toBe(2);
    expect(issues[0]!.details).toHaveLength(2);
  });

  it('0 は正常（在庫を使い切った状態）', () => {
    const rows = computeAllDerived([makeRow({ closingQty: 0, unitPrice: 100 })]);
    expect(validateProductRows(rows).filter((i) => i.code === 'E015')).toEqual([]);
  });

  it('正の期末在庫では出ない', () => {
    const rows = computeAllDerived([makeRow({ closingQty: 5, unitPrice: 100 })]);
    expect(validateProductRows(rows).filter((i) => i.code === 'E015')).toEqual([]);
  });

  it('期中仕入が負（返品）でも期末在庫が正なら出ない', () => {
    // 返品は発注数が負で表される想定。期末在庫の検査とは別の事象
    const rows = computeAllDerived([
      makeRow({ closingQty: 2, purchaseQty: -1, openingQty: 5, unitPrice: 100 }),
    ]);
    expect(validateProductRows(rows).filter((i) => i.code === 'E015')).toEqual([]);
  });
});

describe('W013 未知の分類', () => {
  it('17分類に含まれない分類は W013 を出す', () => {
    const rows = [makeRow({ category: '99.新しい分類' })];
    expect(validateProductRows(rows).filter((i) => i.code === 'W013')).toHaveLength(1);
  });

  it('既知の分類なら警告しない', () => {
    const rows = [makeRow({ category: '01.ソース' }), makeRow({ category: '16.靴他' })];
    expect(validateProductRows(rows).filter((i) => i.code === 'W013')).toHaveLength(0);
  });

  it('同じ未知分類が複数行あっても1件にまとめる', () => {
    const rows = [
      makeRow({ code: code('000001'), category: '99.新しい分類' }),
      makeRow({ code: code('000002'), category: '99.新しい分類' }),
    ];
    expect(validateProductRows(rows).filter((i) => i.code === 'W013')).toHaveLength(1);
  });
});

describe('位置情報', () => {
  it('ファイル名・シート名を引き継ぐ', () => {
    const rows = [makeRow({ code: code('000140') }), makeRow({ code: code('000140') })];
    const issues = validateProductRows(rows, {
      fileName: '当月マスタ.xlsx',
      sheetName: '入力用',
    });

    expect(issues[0]!.ref.fileName).toBe('当月マスタ.xlsx');
    expect(issues[0]!.ref.sheetName).toBe('入力用');
  });
});
