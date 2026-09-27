/**
 * メッセージ体系そのもののテスト。
 *
 * 運用方針は2つ。
 *   1. 別の事象には別のコードを与える（同じコードに複数の意味を持たせない）
 *   2. 1つの事象につきメッセージは1件（数十件並べて重要な指摘を埋もれさせない）
 *
 * ここではその土台となる IssueCollector / summarize / foldByCode の挙動を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  ISSUE_CATALOG,
  IssueCollector,
  createIssue,
  foldByCode,
  levelOf,
  summarize,
  type IssueCode,
  type IssueDetail,
} from '@/domain/issues';

function detail(text: string, ref = {}): IssueDetail {
  return { ref, text };
}

describe('ISSUE_CATALOG', () => {
  it('コードの接頭辞とレベルが一致する（E=BLOCKING, W=WARNING, I=INFO）', () => {
    for (const [code, meta] of Object.entries(ISSUE_CATALOG)) {
      const expected = { E: 'BLOCKING', W: 'WARNING', I: 'INFO' }[code[0]!];
      expect(`${code}:${meta.level}`).toBe(`${code}:${expected}`);
    }
  });

  it('タイトルが重複していない（別の事象に同じ見出しを付けない）', () => {
    const titles = Object.values(ISSUE_CATALOG).map((m) => m.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('levelOf はカタログのレベルを返す', () => {
    expect(levelOf('E005')).toBe('BLOCKING');
    expect(levelOf('W008')).toBe('WARNING');
    expect(levelOf('I003')).toBe('INFO');
  });
});

describe('createIssue', () => {
  it('コードからレベルとタイトルを引く', () => {
    const issue = createIssue('W009', '不一致があります。');
    expect(issue.level).toBe('WARNING');
    expect(issue.title).toBe(ISSUE_CATALOG.W009.title);
    expect(issue.count).toBe(1);
    expect(issue.details).toEqual([]);
  });

  it('メッセージ本文にコードを埋め込まない（画面で二重表示になるため）', () => {
    // 実装側の全メッセージはコード接頭辞を持たない方針。代表例で回帰を防ぐ。
    const issue = createIssue('E010', 'A1 は数式セルです。');
    expect(issue.message).not.toMatch(/^[EWI]\d{3}[: ]/);
  });
});

describe('summarize', () => {
  it('内訳をスラッシュ区切りで並べる', () => {
    expect(summarize([detail('A'), detail('B')])).toBe('A / B');
  });

  it('上限を超えたら「ほか」で締める', () => {
    const many = Array.from({ length: 10 }, (_, i) => detail(`X${i}`));
    const text = summarize(many, 3);
    expect(text).toBe('X0 / X1 / X2 ほか');
  });

  it('ちょうど上限なら「ほか」を付けない', () => {
    expect(summarize([detail('A'), detail('B')], 2)).toBe('A / B');
  });

  it('空なら空文字', () => {
    expect(summarize([])).toBe('');
  });
});

describe('IssueCollector.addMany', () => {
  it('複数件を1件のメッセージにまとめ、内訳を details に残す', () => {
    const issues = new IssueCollector();
    issues.addMany('W002', [detail('a'), detail('b'), detail('c')], (n) => `${n} 件あります。`);

    expect(issues.all).toHaveLength(1);
    expect(issues.all[0]!.message).toBe('3 件あります。');
    expect(issues.all[0]!.count).toBe(3);
    expect(issues.all[0]!.details).toHaveLength(3);
  });

  it('内訳が空なら何も記録しない', () => {
    const issues = new IssueCollector();
    issues.addMany('W002', [], () => '出てはいけないメッセージ');
    expect(issues.all).toEqual([]);
  });

  it('1件だけなら、その行・商品コードを代表位置にする', () => {
    const issues = new IssueCollector();
    issues.addMany(
      'W012',
      [detail('x', { rowNo: 42, productCode: '000140' })],
      (n) => `${n} 件`,
      { fileName: '当月マスタ.xlsx' },
    );

    const issue = issues.all[0]!;
    expect(issue.ref.rowNo).toBe(42);
    expect(issue.ref.productCode).toBe('000140');
    expect(issue.ref.fileName).toBe('当月マスタ.xlsx');
  });

  it('複数件なら特定の行を指さず、ファイル・シートまでに留める', () => {
    const issues = new IssueCollector();
    issues.addMany(
      'W012',
      [detail('x', { rowNo: 42 }), detail('y', { rowNo: 43 })],
      (n) => `${n} 件`,
      { fileName: '当月マスタ.xlsx', sheetName: '入力用' },
    );

    const issue = issues.all[0]!;
    expect(issue.ref.rowNo).toBeUndefined();
    expect(issue.ref.fileName).toBe('当月マスタ.xlsx');
  });
});

describe('foldByCode', () => {
  it('同じコードの複数メッセージを1件に畳む', () => {
    const input = [
      createIssue('E003', '商品コードが空欄です。', { rowNo: 5 }),
      createIssue('E003', '商品コードが空欄です。', { rowNo: 9 }),
      createIssue('W002', '商品名が変わりました。', { rowNo: 7 }),
    ];

    const out = foldByCode(input, ['E003'], (_c, n) => `${n} 行が空欄です。`);
    const e003 = out.filter((i) => i.code === 'E003');

    expect(e003).toHaveLength(1);
    expect(e003[0]!.message).toBe('2 行が空欄です。');
    expect(e003[0]!.count).toBe(2);
    // 対象外のコードはそのまま残す
    expect(out.filter((i) => i.code === 'W002')).toHaveLength(1);
  });

  it('畳む対象が1件でも畳んだ側の文言を使う（対処方法まで書けるため）', () => {
    const out = foldByCode([createIssue('E003', '空欄です。', { rowNo: 5 })], ['E003'], (_c, n) => `${n} 行`);
    expect(out[0]!.message).toBe('1 行');
    expect(out[0]!.count).toBe(1);
    expect(out[0]!.ref.rowNo).toBe(5);
  });

  it('対象コードが1件もなければ入力をそのまま返す', () => {
    const input = [createIssue('W002', 'a')];
    expect(foldByCode(input, ['E003'], () => 'x')).toEqual(input);
  });

  it('既にまとめ済みの内訳も引き継ぐ', () => {
    const collector = new IssueCollector();
    collector.addMany('E003', [detail('a'), detail('b')], (n) => `${n} 件`);
    const folded = foldByCode([...collector.all, createIssue('E003', 'c')], ['E003'], (_c, n) => `${n} 件`);

    expect(folded).toHaveLength(1);
    expect(folded[0]!.count).toBe(3);
  });

  it('並び順を保つ', () => {
    const input = [
      createIssue('W002', 'a'),
      createIssue('E003', 'b'),
      createIssue('W003', 'c'),
    ];
    const out = foldByCode(input, ['E003'], (_c, n) => `${n}`);
    expect(out.map((i) => i.code)).toEqual(['W002', 'E003', 'W003']);
  });
});

describe('IssueCollector の集計', () => {
  it('レベル別に数える', () => {
    const issues = new IssueCollector();
    issues.add('E003', 'a');
    issues.add('W002', 'b');
    issues.add('I001', 'c');

    expect(issues.counts()).toEqual({ BLOCKING: 1, WARNING: 1, INFO: 1 });
    expect(issues.hasBlocking()).toBe(true);
  });

  it('BLOCKING がなければ hasBlocking は false', () => {
    const issues = new IssueCollector();
    issues.add('W002', 'b');
    expect(issues.hasBlocking()).toBe(false);
  });

  it('コードで絞り込める', () => {
    const issues = new IssueCollector();
    issues.add('W002', 'a');
    issues.add('W003', 'b');
    expect(issues.byCode('W002' as IssueCode)).toHaveLength(1);
  });
});
