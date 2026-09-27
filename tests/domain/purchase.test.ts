import { describe, it, expect } from 'vitest';
import { convertOrderLines, applyPurchases } from '@/domain/purchase';
import { makeRow, makeOrder, makeUnitEntry, code } from '../helpers/factories';

describe('単位換算（期中仕入 = 発注数 × 換算係数）', () => {
  /** 単位計算マスタを正とし、当月マスタP列はフォールバック兼検証に使う */
  const sources = (opts: { unit?: [string, number][]; masterP?: [string, number][] }) => ({
    unitMaster: new Map(
      (opts.unit ?? []).map(([c, f]) => [c, makeUnitEntry({ code: code(c), factor: f })]),
    ),
    masterP: new Map(opts.masterP ?? []),
  });

  describe('実データによる検算', () => {
    it.each([
      ['001868', 'クリームコロッケ（Ｈ６）', 6, 40, 240],
      ['006185', 'フィッシュフライ２０枚１袋（Ｈ２６）', 11, 20, 220],
      ['002138', 'ロースカツ５０枚１箱Ｈ２８', 8, 50, 400],
      ['002035', 'チキンカツ（Ｈ７）', 8, 30, 240],
      ['001467', 'パリパリチキン', 54, 10, 540],
      ['005971', '豚しゃぶ１０Ｐ１袋（Ｈ２４）', 55, 10, 550],
      ['001400', 'パックライス３０個入（国産）', 2, 30, 60],
    ])('%s %s: 発注数%d × 換算係数%d = %d', (c, _name, orderQty, factor, expected) => {
      const orders = [makeOrder({ code: code(c), orderQty })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [[c, factor]], masterP: [[c, factor]] }),
      );

      expect(result.lines[0]!.convertedQty).toBe(expected);
    });

    it('換算係数1の商品はそのまま（000158 甘口ポークソース）', () => {
      const orders = [makeOrder({ code: code('000158'), orderQty: 76 })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [['000158', 1]], masterP: [['000158', 1]] }),
      );
      expect(result.lines[0]!.convertedQty).toBe(76);
    });
  });

  describe('換算係数の出所（単位計算マスタが正）', () => {
    it('単位計算マスタから取り、factorSource に記録する', () => {
      const orders = [makeOrder({ code: code('001868'), orderQty: 6 })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [['001868', 40]], masterP: [['001868', 40]] }),
      );

      expect(result.lines[0]!.factorSource).toBe('UNIT_MASTER');
      expect(result.lines[0]!.conversionFactor).toBe(40);
    });

    it('当月マスタP列と一致すれば I003 を記録する', () => {
      const orders = [makeOrder({ code: code('001868'), orderQty: 6 })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [['001868', 40]], masterP: [['001868', 40]] }),
      );

      expect(result.issues.filter((i) => i.code === 'I003')).toHaveLength(1);
    });

    it('当月マスタP列と不一致なら W009 を出し、単位計算マスタを採用する', () => {
      const orders = [makeOrder({ code: code('001868'), orderQty: 6 })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [['001868', 40]], masterP: [['001868', 20]] }),
      );

      expect(result.issues.filter((i) => i.code === 'W009')).toHaveLength(1);
      expect(result.lines[0]!.convertedQty).toBe(240); // 6 × 40（単位計算マスタ）
      expect(result.lines[0]!.factorSource).toBe('UNIT_MASTER');
    });

    it('W009 のメッセージに両方の値と採用した側を示す', () => {
      const orders = [makeOrder({ code: code('001868'), orderQty: 6 })];
      const issue = convertOrderLines(
        orders,
        sources({ unit: [['001868', 40]], masterP: [['001868', 20]] }),
      ).issues.find((i) => i.code === 'W009')!;

      expect(issue.message).toContain('40');
      expect(issue.message).toContain('20');
      expect(issue.message).toContain('単位計算マスタ');
    });

    it('棚卸対象商品が単位計算マスタに無ければ P列へフォールバックし W016 を出す', () => {
      const orders = [makeOrder({ code: code('000158'), orderQty: 76 })];
      const result = convertOrderLines(orders, sources({ masterP: [['000158', 1]] }));

      expect(result.lines[0]!.factorSource).toBe('MASTER_P');
      expect(result.lines[0]!.convertedQty).toBe(76);
      expect(result.issues.filter((i) => i.code === 'W016')).toHaveLength(1);
    });

    it('フォールバックが複数あっても W016 は1件にまとめる', () => {
      const orders = [
        makeOrder({ code: code('000158'), orderQty: 1 }),
        makeOrder({ code: code('000155'), orderQty: 1 }),
        makeOrder({ code: code('000108'), orderQty: 1 }),
      ];
      const result = convertOrderLines(
        orders,
        sources({ masterP: [['000158', 1], ['000155', 1], ['000108', 1]] }),
      );

      const w016 = result.issues.filter((i) => i.code === 'W016');
      expect(w016).toHaveLength(1);
      expect(w016[0]!.message).toContain('3 商品');
    });

    it('棚卸表に無い商品は単位計算マスタの係数で換算する（集計対象外だが数量は保持）', () => {
      // 消耗品も単位計算マスタには載っている。換算自体は可能。
      const orders = [makeOrder({ code: code('040416'), orderQty: 2 })];
      const result = convertOrderLines(orders, sources({ unit: [['040416', 400]] }));

      expect(result.lines[0]!.convertedQty).toBe(800);
      expect(result.issues.filter((i) => i.code === 'E005')).toEqual([]);
      expect(result.issues.filter((i) => i.code === 'W016')).toEqual([]);
    });
  });

  describe('換算不能（要件§5「推測せず出力確定を止める」）', () => {
    it.each([
      ['係数が0', 0],
      ['係数が負', -1],
      ['係数がNaN', Number.NaN],
    ])('棚卸対象商品でどちらの係数も%sなら E005 を出す', (_label, factor) => {
      const orders = [makeOrder({ code: code('000140'), orderQty: 10 })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [['000140', factor]], masterP: [['000140', factor]] }),
      );

      expect(result.issues.filter((i) => i.code === 'E005')).toHaveLength(1);
      expect(result.lines[0]!.convertedQty).toBeNull();
    });

    it('単位計算マスタの係数が不正でもP列が有効なら救済し W016 を出す', () => {
      const orders = [makeOrder({ code: code('000140'), orderQty: 10 })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [['000140', 0]], masterP: [['000140', 5]] }),
      );

      expect(result.lines[0]!.convertedQty).toBe(50);
      expect(result.lines[0]!.factorSource).toBe('MASTER_P');
      expect(result.issues.filter((i) => i.code === 'W016')).toHaveLength(1);
      expect(result.issues.filter((i) => i.code === 'E005')).toEqual([]);
    });

    it('ゼロ扱いにしない（受入条件3）', () => {
      const orders = [makeOrder({ code: code('000140'), orderQty: 10 })];
      const result = convertOrderLines(orders, sources({ masterP: [['000140', 0]] }));

      expect(result.lines[0]!.convertedQty).not.toBe(0);
      expect(result.lines[0]!.convertedQty).toBeNull();
    });

    it('棚卸表にも単位計算マスタにも無い商品は E005 にしない', () => {
      // 集計対象外であり、換算できないこと自体は問題ではない。
      const orders = [makeOrder({ code: code('040416'), orderQty: 1 })];
      const result = convertOrderLines(orders, sources({}));

      expect(result.issues.filter((i) => i.code === 'E005')).toEqual([]);
      expect(result.lines[0]!.convertedQty).toBeNull();
    });

    it('棚卸表に無い食材は applyPurchases が W011 として報告する', () => {
      // 4桁は食材。マスタに無いのは確認すべき事象なので警告になる
      const rows = [makeRow({ code: code('000140') })];
      const orders = [makeOrder({ code: code('009999'), orderQty: 1 })];
      const converted = convertOrderLines(orders, sources({}));
      const applied = applyPurchases(rows, converted.lines);

      expect(applied.issues.filter((i) => i.code === 'W011')).toHaveLength(1);
      expect(applied.issues.filter((i) => i.code === 'E005')).toEqual([]);
    });

    it('備品（5桁コード）は W011 ではなく I004 として記録する', () => {
      // 備品はそもそもこの棚卸表の計算対象外（要件§10-2）。
      // マスタに無いことが問題なのではないので、警告ではなく情報にする。
      const rows = [makeRow({ code: code('000140') })];
      const orders = [makeOrder({ code: code('040416'), orderQty: 1 })];
      const converted = convertOrderLines(orders, sources({}));
      const applied = applyPurchases(rows, converted.lines);

      expect(applied.issues.filter((i) => i.code === 'W011')).toEqual([]);
      const i004 = applied.issues.filter((i) => i.code === 'I004');
      expect(i004).toHaveLength(1);
      expect(i004[0]!.level).toBe('INFO');
      expect(i004[0]!.message).toContain('計算対象外');
    });

    it('マスタにある備品でも期中仕入には反映しない', () => {
      const rows = [makeRow({ code: code('041304'), isSupply: true, purchaseQty: 0 })];
      const lines = [makeOrder({ code: code('041304'), convertedQty: 4 })];

      const result = applyPurchases(rows, lines);

      expect(result.rows[0]!.purchaseQty).toBe(0);
      expect(result.issues.filter((i) => i.code === 'I004')).toHaveLength(1);
    });
  });

  describe('返品・取消', () => {
    it('発注数が負なら返品として扱い、換算も負になる', () => {
      const orders = [makeOrder({ code: code('001868'), orderQty: -2 })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [['001868', 40]], masterP: [['001868', 40]] }),
      );

      expect(result.lines[0]!.isReturn).toBe(true);
      expect(result.lines[0]!.convertedQty).toBe(-80);
    });

    // 返品は本システムの管理対象外だが（要件§10-1）、式どおり計算すると
    // 負の発注数はそのまま期中仕入から引かれる。年数回しか起きないため、
    // 引いたことを必ず知らせる（2026-09-27 確定）。
    it('返品行があると W023 で知らせる', () => {
      const orders = [makeOrder({ code: code('001868'), orderQty: -2 })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [['001868', 40]], masterP: [['001868', 40]] }),
      );

      const w023 = result.issues.filter((i) => i.code === 'W023');
      expect(w023).toHaveLength(1);
      expect(w023[0]!.level).toBe('WARNING');
      expect(w023[0]!.message).toContain('発注数 -2');
      expect(w023[0]!.message).toContain('期中仕入から差し引いて計算します');
    });

    it('返品行が複数でも1メッセージにまとめる', () => {
      const orders = [
        makeOrder({ code: code('001868'), orderQty: -2, lineNo: 5 }),
        makeOrder({ code: code('000158'), orderQty: -1, lineNo: 9 }),
      ];
      const result = convertOrderLines(
        orders,
        sources({
          unit: [['001868', 40], ['000158', 1]],
          masterP: [['001868', 40], ['000158', 1]],
        }),
      );

      const w023 = result.issues.filter((i) => i.code === 'W023');
      expect(w023).toHaveLength(1);
      expect(w023[0]!.count).toBe(2);
      expect(w023[0]!.details).toHaveLength(2);
    });

    it('返品が無ければ W023 は出ない', () => {
      const orders = [makeOrder({ code: code('001868'), orderQty: 2 })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [['001868', 40]], masterP: [['001868', 40]] }),
      );

      expect(result.issues.filter((i) => i.code === 'W023')).toEqual([]);
    });

    it('警告であって処理は止めない', () => {
      const orders = [makeOrder({ code: code('001868'), orderQty: -2 })];
      const result = convertOrderLines(
        orders,
        sources({ unit: [['001868', 40]], masterP: [['001868', 40]] }),
      );

      expect(result.issues.filter((i) => i.level === 'BLOCKING')).toEqual([]);
      expect(result.lines[0]!.convertedQty).toBe(-80);
    });
  });
});

describe('applyPurchases（換算後の発注を明細へ反映）', () => {
  it('同一商品の複数行を合算する', () => {
    const rows = [makeRow({ code: code('000158') })];
    const lines = [
      makeOrder({ code: code('000158'), convertedQty: 40 }),
      makeOrder({ code: code('000158'), convertedQty: 36 }),
    ];

    const result = applyPurchases(rows, lines);

    expect(result.rows[0]!.purchaseQty).toBe(76);
  });

  it('返品行を差し引く', () => {
    const rows = [makeRow({ code: code('000158') })];
    const lines = [
      makeOrder({ code: code('000158'), convertedQty: 100 }),
      makeOrder({ code: code('000158'), convertedQty: -24, isReturn: true }),
    ];

    expect(applyPurchases(rows, lines).rows[0]!.purchaseQty).toBe(76);
  });

  it('発注がない商品の期中仕入は0のまま', () => {
    const rows = [makeRow({ code: code('000140'), purchaseQty: 0 })];
    expect(applyPurchases(rows, []).rows[0]!.purchaseQty).toBe(0);
  });

  it('当月マスタにない商品コードの発注は W011 を出す', () => {
    const rows = [makeRow({ code: code('000140') })];
    const lines = [makeOrder({ code: code('009999'), convertedQty: 5 })];

    const result = applyPurchases(rows, lines);

    expect(result.issues.filter((i) => i.code === 'W011')).toHaveLength(1);
  });

  it('換算不能な行(convertedQty=null)は合算せず、期中仕入を確定しない', () => {
    const rows = [makeRow({ code: code('000158') })];
    const lines = [
      makeOrder({ code: code('000158'), convertedQty: 40 }),
      makeOrder({ code: code('000158'), convertedQty: null }),
    ];

    const result = applyPurchases(rows, lines);

    // 一部でも換算不能なら合計を信用できないので、部分合計(40)を書き込まない。
    // 出力は convertOrderLines の E005 でブロックされる。
    expect(result.rows[0]!.purchaseQty).toBe(0);
    // 原因は convertOrderLines 側で1件にまとめて報告済みなので、ここでは重ねて出さない
    expect(result.issues.filter((i) => i.code === 'E005')).toEqual([]);
  });

  it('自店購入（Aコード）は発注累計に現れないため0のまま', () => {
    const rows = [makeRow({ code: code('A00043'), isOwnPurchase: true })];
    const result = applyPurchases(rows, []);

    expect(result.rows[0]!.purchaseQty).toBe(0);
    expect(result.issues.filter((i) => i.code === 'W011')).toHaveLength(0);
  });

  it('入力配列を破壊しない', () => {
    const rows = [makeRow({ code: code('000158'), purchaseQty: 0 })];
    applyPurchases(rows, [makeOrder({ code: code('000158'), convertedQty: 40 })]);
    expect(rows[0]!.purchaseQty).toBe(0);
  });
});

describe('確認済み換算係数（新規商品の運用要望）', () => {
  const src = (opts: {
    confirmed?: [string, number][];
    unit?: [string, number][];
    masterP?: [string, number][];
  }) => ({
    confirmed: opts.confirmed ? new Map(opts.confirmed) : undefined,
    unitMaster: new Map(
      (opts.unit ?? []).map(([c, f]) => [c, makeUnitEntry({ code: code(c), factor: f })]),
    ),
    masterP: new Map(opts.masterP ?? []),
  });

  it('確認済みの係数が単位計算マスタより優先される', () => {
    const orders = [makeOrder({ code: code('041330'), orderQty: 9 })];
    const r = convertOrderLines(
      orders,
      src({ confirmed: [['041330', 60]], unit: [['041330', 1]], masterP: [['041330', 1]] }),
    );

    expect(r.lines[0]!.conversionFactor).toBe(60);
    expect(r.lines[0]!.convertedQty).toBe(540);
    expect(r.lines[0]!.factorSource).toBe('CONFIRMED');
  });

  it('確認済みの係数はP列より優先される', () => {
    const orders = [makeOrder({ code: code('007426'), orderQty: 14 })];
    const r = convertOrderLines(orders, src({ confirmed: [['007426', 2]], masterP: [['007426', 1]] }));

    expect(r.lines[0]!.convertedQty).toBe(28);
    expect(r.lines[0]!.factorSource).toBe('CONFIRMED');
  });

  it('確認済みでも不正な値なら採用せず、次の取得元へ落ちる', () => {
    const orders = [makeOrder({ code: code('007426'), orderQty: 14 })];
    const r = convertOrderLines(orders, src({ confirmed: [['007426', 0]], masterP: [['007426', 1]] }));

    expect(r.lines[0]!.factorSource).toBe('MASTER_P');
    expect(r.lines[0]!.convertedQty).toBe(14);
  });

  it('確認済みの商品では W009・W016 を出さない', () => {
    const orders = [makeOrder({ code: code('041330'), orderQty: 9 })];
    const r = convertOrderLines(
      orders,
      src({ confirmed: [['041330', 60]], unit: [['041330', 1]], masterP: [['041330', 1]] }),
    );

    expect(r.issues.filter((i) => i.code === 'W009')).toEqual([]);
    expect(r.issues.filter((i) => i.code === 'W016')).toEqual([]);
  });

  it('確認済みが無い商品は従来どおりの優先順位で処理する', () => {
    const orders = [
      makeOrder({ code: code('000158'), orderQty: 76 }),
      makeOrder({ code: code('041330'), orderQty: 9 }),
    ];
    const r = convertOrderLines(
      orders,
      src({ confirmed: [['041330', 60]], unit: [['000158', 1]], masterP: [['000158', 1], ['041330', 1]] }),
    );

    expect(r.lines.find((l) => l.code === '000158')!.factorSource).toBe('UNIT_MASTER');
    expect(r.lines.find((l) => l.code === '041330')!.factorSource).toBe('CONFIRMED');
  });
});
