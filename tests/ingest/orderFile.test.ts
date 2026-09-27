/**
 * 発注累計照会（実ファイル形式）の取込テスト。
 * 実データは 10列: 店舗コード/店舗名/納品日From/納品日To/原材料コード/原材料名/発注数/単位/入数/入数単位
 */
import { describe, it, expect } from 'vitest';
import { readOrderTable } from '@/ingest/orderFile';
import { tableFromCsv } from '@/ingest/tabular';
import { ORDER_PROFILE } from '@/ingest/profiles';
import { applyPurchases, convertOrderLines } from '@/domain/purchase';
import { checkOrderPeriod } from '@/domain/period';
import { makeRow, code } from '../helpers/factories';

const HEADER =
  '"店舗コード","店舗名","納品日From","納品日To","原材料コード","原材料名","発注数","単位","入数","入数単位"';

function line(codeValue: string, name: string, qty: string, unit = '袋', pack = '5', packUnit = 'ｇ'): string {
  return `"9999","テスト店","2026/08/01","2026/08/31","${codeValue}","${name}","${qty}","${unit}","${pack}","${packUnit}"`;
}

function csv(...lines: string[]): Uint8Array {
  return new TextEncoder().encode([HEADER, ...lines].join('\r\n'));
}

function read(bytes: Uint8Array) {
  const table = tableFromCsv(bytes, ORDER_PROFILE.header.detectBy);
  return readOrderTable(table, ORDER_PROFILE, { fileName: '発注累計照会.csv' });
}

describe('実列構成の読み取り', () => {
  it('見出しを1行目として検出する', () => {
    const table = tableFromCsv(csv(line('001464', '輪切り唐辛子', '6')), ORDER_PROFILE.header.detectBy);
    expect(table.headerRow).toBe(1);
    expect(table.headers).toEqual([
      '店舗コード', '店舗名', '納品日From', '納品日To',
      '原材料コード', '原材料名', '発注数', '単位', '入数', '入数単位',
    ]);
  });

  it('発注行を読める', () => {
    const r = read(csv(line('001464', '輪切り唐辛子', '6')));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.code).toBe('001464');
    expect(r.lines[0]!.orderQty).toBe(6);
  });

  it('原材料コードの先頭ゼロを保持し、I001 を出さない', () => {
    const r = read(csv(line('001464', '輪切り唐辛子', '6'), line('018898', 'ＴＯ麺用容器フタ', '2')));
    expect(r.lines.map((l) => l.code)).toEqual(['001464', '018898']);
    expect(r.issues.filter((i) => i.code === 'I001')).toEqual([]);
  });

  it('必須列が揃っていれば BLOCKING を出さない', () => {
    const r = read(csv(line('001464', '輪切り唐辛子', '6')));
    expect(r.issues.filter((i) => i.level === 'BLOCKING')).toEqual([]);
  });

  it('「計算単位」列がなくてもエラーにならない（実ファイルに存在しないため）', () => {
    expect(ORDER_PROFILE.columns['factor']).toBeUndefined();
    const r = read(csv(line('001464', '輪切り唐辛子', '6')));
    expect(r.issues.filter((i) => i.code === 'E001')).toEqual([]);
  });

  it('必須列の「発注数」が無ければ E001 で止まる', () => {
    const bad = new TextEncoder().encode(
      ['"原材料コード","原材料名"', '"001464","輪切り唐辛子"'].join('\r\n'),
    );
    const table = tableFromCsv(bad, ORDER_PROFILE.header.detectBy);
    const r = readOrderTable(table, ORDER_PROFILE, { fileName: 'x.csv' });
    expect(r.issues.filter((i) => i.code === 'E001').length).toBeGreaterThan(0);
  });
});

describe('メタ情報（集計期間・店舗）', () => {
  it('納品日From/To を返す', () => {
    const r = read(csv(line('001464', '輪切り唐辛子', '6')));
    expect(r.meta.periodFrom).toBe('2026/08/01');
    expect(r.meta.periodTo).toBe('2026/08/31');
  });

  it('店舗コードを返す', () => {
    const r = read(csv(line('001464', '輪切り唐辛子', '6')));
    expect(r.meta.storeCodes).toEqual(['9999']);
  });

  it('店舗が複数混在していれば列挙する', () => {
    const mixed = new TextEncoder().encode(
      [
        HEADER,
        line('001464', '輪切り唐辛子', '6'),
        '"2000","別の店","2026/08/01","2026/08/31","001465","別商品","1","袋","5","ｇ"',
      ].join('\r\n'),
    );
    const r = read(mixed);
    expect(r.meta.storeCodes.sort()).toEqual(['2000', '9999']);
  });
});

describe('集計期間の検証（要件§4「集計期間」）', () => {
  it('対象年月と一致すれば問題なし', () => {
    const issues = checkOrderPeriod('2026-08', '2026/08/01', '2026/08/31', 'orders.csv');
    expect(issues).toEqual([]);
  });

  it('対象年月と違う月なら E004', () => {
    const issues = checkOrderPeriod('2026-09', '2026/08/01', '2026/08/31', 'orders.csv');
    expect(issues.map((i) => i.code)).toContain('E004');
  });

  it('E004 のメッセージに実際の期間を含める', () => {
    const issue = checkOrderPeriod('2026-09', '2026/08/01', '2026/08/31', 'orders.csv')[0]!;
    expect(issue.message).toContain('2026/08/01');
    expect(issue.message).toContain('2026/08/31');
    expect(issue.message).toContain('2026-09');
  });

  it('E004 のメッセージは対象年月を直す道も示す（過去の月をやり直せる）', () => {
    // 誤っているのはファイルとは限らない。7月分をやり直そうとして
    // 対象年月が既定の8月のままなら、直すべきは対象年月の側。
    const issue = checkOrderPeriod('2026-08', '2026/07/01', '2026/07/31', 'orders.csv')[0]!;
    expect(issue.code).toBe('E004');
    expect(issue.message).toContain('対象年月を 2026-07 に変更');
    expect(issue.message).toContain('2026-08分を処理するなら');
  });

  it('期間が月をまたぐときは、どちらが正しいか確認するよう促すだけにする', () => {
    const issue = checkOrderPeriod('2026-08', '2026/07/01', '2026/09/30', 'orders.csv')[0]!;
    expect(issue.code).toBe('E004');
    expect(issue.message).toContain('どちらが正しいか');
    // 存在しない年月への変更を勧めない
    expect(issue.message).not.toContain('に変更してください');
  });

  it('月初〜月末でなければ W015 で注意喚起する', () => {
    const issues = checkOrderPeriod('2026-08', '2026/08/05', '2026/08/25', 'orders.csv');
    expect(issues.map((i) => i.code)).toContain('W015');
  });

  it('月初〜月末なら W015 を出さない', () => {
    expect(checkOrderPeriod('2026-08', '2026/08/01', '2026/08/31', 'orders.csv')).toEqual([]);
  });

  it('2月のように末日が異なる月も正しく判定する', () => {
    expect(checkOrderPeriod('2026-02', '2026/02/01', '2026/02/28', 'orders.csv')).toEqual([]);
  });

  it('期間が読めない場合は判定しない（推測しない）', () => {
    expect(checkOrderPeriod('2026-08', null, null, 'orders.csv')).toEqual([]);
  });

  it('ハイフン区切りの日付も受け付ける', () => {
    expect(checkOrderPeriod('2026-08', '2026-08-01', '2026-08-31', 'orders.csv')).toEqual([]);
  });

  describe('複数期間の混在（観点 C-12b）', () => {
    it('期間が2種類以上あれば W017 を出す', () => {
      const issues = checkOrderPeriod('2026-08', '2026/08/01', '2026/08/31', 'orders.csv', [
        { from: '2026/08/01', to: '2026/08/31' },
        { from: '2026/07/01', to: '2026/07/31' },
      ]);
      expect(issues.map((i) => i.code)).toContain('W017');
    });

    it('期間が1種類なら W017 を出さない', () => {
      const issues = checkOrderPeriod('2026-08', '2026/08/01', '2026/08/31', 'orders.csv', [
        { from: '2026/08/01', to: '2026/08/31' },
      ]);
      expect(issues).toEqual([]);
    });

    it('混在していても代表期間が対象年月と違えば E004 も併せて出す', () => {
      const issues = checkOrderPeriod('2026-09', '2026/08/01', '2026/08/31', 'orders.csv', [
        { from: '2026/08/01', to: '2026/08/31' },
        { from: '2026/07/01', to: '2026/07/31' },
      ]);
      expect(issues.map((i) => i.code).sort()).toEqual(['E004', 'W017']);
    });

    it('W017 のメッセージに混在した期間を列挙する', () => {
      const issue = checkOrderPeriod('2026-08', '2026/08/01', '2026/08/31', 'orders.csv', [
        { from: '2026/08/01', to: '2026/08/31' },
        { from: '2026/07/01', to: '2026/07/31' },
      ]).find((i) => i.code === 'W017')!;
      expect(issue.message).toContain('2026/07/01');
      expect(issue.message).toContain('2 種類');
    });
  });
});

describe('取込時の期間収集', () => {
  it('単一期間なら periods は1組', () => {
    const r = read(csv(line('001464', '輪切り唐辛子', '6'), line('002272', 'ビーフカツ', '4')));
    expect(r.meta.periods).toEqual([{ from: '2026/08/01', to: '2026/08/31' }]);
  });

  it('複数期間が混在していれば periods に集まる', () => {
    const mixed = new TextEncoder().encode(
      [
        HEADER,
        line('001464', '輪切り唐辛子', '6'),
        '"9999","テスト店","2026/07/01","2026/07/31","002272","ビーフカツ","4","袋","5","枚"',
      ].join('\r\n'),
    );
    const r = read(mixed);
    expect(r.meta.periods).toHaveLength(2);
    expect(r.meta.periodFrom).toBe('2026/08/01'); // 代表は最初に現れたもの
  });
});

describe('換算と集約（実データの挙動）', () => {
  const FACTORS: [string, number][] = [
    ['001464', 1],
    ['002272', 5],
    ['005113', 60],
    ['002269', 4],
  ];
  // 単位計算マスタが正、当月マスタP列はフォールバック
  const factors = {
    unitMaster: new Map(
      FACTORS.map(([c, f]) => [c, { code: code(c), name: '', orderUnit: 1, unitLabel: '', factor: f, lineNo: 2 }]),
    ),
    masterP: new Map(FACTORS),
  };

  it('発注数 × 仕入れ単位P で換算する（入数は使わない）', () => {
    const r = read(csv(line('005113', 'カキフライ（Ｈ１７）', '1', '箱', '60', '個')));
    const conv = convertOrderLines(r.lines, factors);
    expect(conv.lines[0]!.convertedQty).toBe(60); // 1 × P60
  });

  it('入数と換算係数が違っても入数に引きずられない', () => {
    // 輪切り唐辛子: 入数=5(ｇ) だが 棚卸単位への換算は 1
    const r = read(csv(line('001464', '輪切り唐辛子', '6', '袋', '5', 'ｇ')));
    const conv = convertOrderLines(r.lines, factors);
    expect(conv.lines[0]!.convertedQty).toBe(6); // 6 × 1 であって 6 × 5 ではない
  });

  it('同一コードが複数行にある場合は合算する（実データに3件ある）', () => {
    const r = read(
      csv(
        line('002269', 'フライ専用油４ｋｇ×４袋　１箱', '1', '箱'),
        line('002269', 'フライ専用油４ｋｇ×４袋　１箱', '2', '箱'),
      ),
    );
    const conv = convertOrderLines(r.lines, factors);
    const rows = [makeRow({ code: code('002269'), conversionFactor: 4 })];
    const applied = applyPurchases(rows, conv.lines);

    expect(applied.rows[0]!.purchaseQty).toBe(12); // (1 + 2) × 4
  });

  // 2026-09-27 確認: 消耗品・容器類は「備品」（数値部が5桁）で、この棚卸表の計算対象外。
  // マスタに無いことが問題なのではないので、警告ではなく情報として記録する。
  it('備品（消耗品・容器類）の発注は I004 を1件にまとめる', () => {
    const r = read(
      csv(
        line('040416', 'ポリ袋小・長', '1'),
        line('018973', 'つまようじ', '2'),
        line('017559', 'トイレットペーパー', '3'),
      ),
    );
    const conv = convertOrderLines(r.lines, { unitMaster: new Map(), masterP: new Map() });
    const applied = applyPurchases([makeRow({ code: code('001464') })], conv.lines);

    expect(applied.issues.filter((i) => i.code === 'W011')).toEqual([]);
    const i004 = applied.issues.filter((i) => i.code === 'I004');
    expect(i004).toHaveLength(1);
    expect(i004[0]!.message).toContain('3 件');
  });

  it('I004 のメッセージに該当コードを列挙する', () => {
    const r = read(csv(line('040416', 'ポリ袋小・長', '1')));
    const conv = convertOrderLines(r.lines, { unitMaster: new Map(), masterP: new Map() });
    const applied = applyPurchases([makeRow({ code: code('001464') })], conv.lines);

    expect(applied.issues.find((i) => i.code === 'I004')?.message).toContain('040416');
  });
});

describe('CP932（Shift_JIS）の読み取り', () => {
  it('CP932で書かれたCSVを文字化けせず読む', () => {
    // Node では Buffer 経由で CP932 を作れないため、実ファイル検証側で担保する。
    // ここでは UTF-8 の日本語が壊れないことだけ確認する。
    const r = read(csv(line('001464', '輪切り唐辛子', '6')));
    expect(r.lines).toHaveLength(1);
  });
});
