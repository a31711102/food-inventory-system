import { describe, it, expect } from 'vitest';
import { applyCarryover } from '@/domain/carryover';
import { makeRow, makePrev, prevMap, code } from '../helpers/factories';

describe('期首引継ぎ（前月期末 → 当月期首）', () => {
  it('継続商品は前月期末在庫を当月期首在庫に引き継ぐ', () => {
    const rows = [makeRow({ code: code('000158') })];
    const prev = prevMap([makePrev({ code: code('000158'), closingQty: 5 })]);

    const result = applyCarryover(rows, prev);

    expect(result.rows[0]!.openingQty).toBe(5);
    expect(result.rows[0]!.status).toBe('CONTINUED');
  });

  it('引継ぎ時に再計算しない（値をそのまま転記する）', () => {
    const rows = [makeRow({ code: code('000158') })];
    const prev = prevMap([makePrev({ code: code('000158'), closingQty: 12.5 })]);

    expect(applyCarryover(rows, prev).rows[0]!.openingQty).toBe(12.5);
  });

  describe('受入条件1: 並び替えと先頭ゼロで誤突合しない', () => {
    // 現行ツールはここで失敗し、266行中98行の期首在庫が1行ずれた。
    it('前月と当月で行順が逆でも商品コードで正しく突合する', () => {
      const rows = [
        makeRow({ lineNo: 3, code: code('007443') }),
        makeRow({ lineNo: 4, code: code('006128') }),
        makeRow({ lineNo: 5, code: code('007323') }),
      ];
      const prev = prevMap([
        makePrev({ lineNo: 10, code: code('007323'), closingQty: 45 }),
        makePrev({ lineNo: 11, code: code('006128'), closingQty: 0 }),
        makePrev({ lineNo: 12, code: code('007443'), closingQty: 2 }),
      ]);

      const result = applyCarryover(rows, prev);

      expect(result.rows.map((r) => [r.code, r.openingQty])).toEqual([
        ['007443', 2],
        ['006128', 0],
        ['007323', 45],
      ]);
    });

    it('先頭ゼロが異なるコードを同一視しない', () => {
      const rows = [makeRow({ code: code('000140') })];
      const prev = prevMap([makePrev({ code: code('140'), closingQty: 99 })]);

      const result = applyCarryover(rows, prev);

      // '140' は別商品として扱われ、'000140' は新規になる
      expect(result.rows[0]!.openingQty).toBe(0);
      expect(result.rows[0]!.status).toBe('NEW');
    });
  });

  describe('新規商品（当月マスタにのみ存在）', () => {
    it('期首在庫を0とし status を NEW にする', () => {
      const rows = [makeRow({ code: code('009999') })];
      const result = applyCarryover(rows, prevMap([]));

      expect(result.rows[0]!.openingQty).toBe(0);
      expect(result.rows[0]!.status).toBe('NEW');
    });

    it('newProducts に列挙する', () => {
      const rows = [makeRow({ code: code('009999') }), makeRow({ code: code('000140') })];
      const prev = prevMap([makePrev({ code: code('000140'), closingQty: 1 })]);

      const result = applyCarryover(rows, prev);

      expect(result.newProducts.map((r) => r.code)).toEqual(['009999']);
    });

    it('未承認なら W004 を出す', () => {
      const rows = [makeRow({ code: code('009999'), openingApproved: false })];
      const result = applyCarryover(rows, prevMap([]));

      expect(result.issues.filter((i) => i.code === 'W004')).toHaveLength(1);
    });

    it('承認済みなら W004 を出さない', () => {
      const rows = [makeRow({ code: code('009999'), openingApproved: true })];
      const result = applyCarryover(rows, prevMap([]));

      expect(result.issues.filter((i) => i.code === 'W004')).toHaveLength(0);
    });

    it('W004 には商品コードと行番号を含める', () => {
      const rows = [makeRow({ lineNo: 77, code: code('009999'), openingApproved: false })];
      const issue = applyCarryover(rows, prevMap([])).issues.find((i) => i.code === 'W004');

      expect(issue?.ref.productCode).toBe('009999');
      expect(issue?.ref.rowNo).toBe(77);
    });
  });

  describe('削除商品（前月にのみ存在）', () => {
    it('当月の計算対象に含めない', () => {
      const rows = [makeRow({ code: code('000140') })];
      const prev = prevMap([
        makePrev({ code: code('000140'), closingQty: 1 }),
        makePrev({ code: code('000999'), closingQty: 0 }),
      ]);

      const result = applyCarryover(rows, prev);

      expect(result.rows.map((r) => r.code)).toEqual(['000140']);
    });

    it('deletedProducts に列挙する', () => {
      const prev = prevMap([makePrev({ code: code('000999'), closingQty: 0 })]);
      const result = applyCarryover([], prev);

      expect(result.deletedProducts.map((r) => r.code)).toEqual(['000999']);
    });

    it('前月期末残が0でなければ W001 を出す', () => {
      const prev = prevMap([makePrev({ code: code('000999'), closingQty: 3 })]);
      const result = applyCarryover([], prev);

      expect(result.issues.filter((i) => i.code === 'W001')).toHaveLength(1);
    });

    it('前月期末残が0なら W001 を出さない', () => {
      const prev = prevMap([makePrev({ code: code('000999'), closingQty: 0 })]);
      const result = applyCarryover([], prev);

      expect(result.issues.filter((i) => i.code === 'W001')).toHaveLength(0);
    });
  });

  describe('属性変更の検知', () => {
    it('商品名が変わったら W002 を出し、当月の名称を採用する', () => {
      const rows = [makeRow({ code: code('000140'), name: '新しい名前' })];
      const prev = prevMap([makePrev({ code: code('000140'), name: '古い名前' })]);

      const result = applyCarryover(rows, prev);

      expect(result.issues.filter((i) => i.code === 'W002')).toHaveLength(1);
      expect(result.rows[0]!.name).toBe('新しい名前');
    });

    it('分類が変わったら W003 を出し、当月の分類を採用する', () => {
      const rows = [makeRow({ code: code('000140'), category: '02.主食材Ａ' })];
      const prev = prevMap([makePrev({ code: code('000140'), category: '01.ソース' })]);

      const result = applyCarryover(rows, prev);

      expect(result.issues.filter((i) => i.code === 'W003')).toHaveLength(1);
      expect(result.rows[0]!.category).toBe('02.主食材Ａ');
    });

    it('変更がなければ警告を出さない', () => {
      const rows = [makeRow({ code: code('000140'), name: '同じ', category: '01.ソース' })];
      const prev = prevMap([makePrev({ code: code('000140'), name: '同じ', category: '01.ソース' })]);

      const result = applyCarryover(rows, prev);

      expect(result.issues.filter((i) => i.code === 'W002' || i.code === 'W003')).toHaveLength(0);
    });
  });

  describe('前月データが存在しない場合（初回稼働月）', () => {
    it('全商品が新規になる', () => {
      const rows = [makeRow({ code: code('000140') }), makeRow({ code: code('000158') })];
      const result = applyCarryover(rows, prevMap([]));

      expect(result.rows.every((r) => r.status === 'NEW')).toBe(true);
      expect(result.rows.every((r) => r.openingQty === 0)).toBe(true);
    });
  });

  it('入力配列を破壊しない', () => {
    const rows = [makeRow({ code: code('000158'), openingQty: 0 })];
    const prev = prevMap([makePrev({ code: code('000158'), closingQty: 5 })]);

    applyCarryover(rows, prev);

    expect(rows[0]!.openingQty).toBe(0);
  });
});

describe('W018 期首在庫の上書き', () => {
  it('当月マスタに期首が入っていて引継ぎ値と違えば警告する', () => {
    const rows = [makeRow({ code: code('007423'), name: '夏ベジカレーペースト', openingQty: 195 })];
    const prev = prevMap([makePrev({ code: code('007423'), name: '夏ベジカレーペースト', closingQty: 0 })]);

    const result = applyCarryover(rows, prev);

    expect(result.issues.filter((i) => i.code === 'W018')).toHaveLength(1);
    expect(result.rows[0]!.openingQty).toBe(0); // 引継ぎ値で上書きする
  });

  it('警告に元の値と引継ぎ値の両方を含める', () => {
    const rows = [makeRow({ code: code('007423'), openingQty: 195 })];
    const prev = prevMap([makePrev({ code: code('007423'), closingQty: 0 })]);
    const issue = applyCarryover(rows, prev).issues.find((i) => i.code === 'W018')!;

    expect(issue.message).toContain('195');
    expect(issue.message).toContain('0');
  });

  it('期首が0（通常のマスタ）なら警告しない', () => {
    const rows = [makeRow({ code: code('000140'), openingQty: 0 })];
    const prev = prevMap([makePrev({ code: code('000140'), closingQty: 5 })]);

    expect(applyCarryover(rows, prev).issues.filter((i) => i.code === 'W018')).toEqual([]);
  });

  it('期首が引継ぎ値と一致していれば警告しない（再取込時）', () => {
    const rows = [makeRow({ code: code('000140'), openingQty: 5 })];
    const prev = prevMap([makePrev({ code: code('000140'), closingQty: 5 })]);

    expect(applyCarryover(rows, prev).issues.filter((i) => i.code === 'W018')).toEqual([]);
  });
});
