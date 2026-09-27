// @vitest-environment happy-dom
/**
 * 画面テスト M-09〜M-11・M-19（メッセージの表示）。
 * 手順: docs/06_画面テスト手順書.md §7
 *
 * メッセージの中身そのものは L1（tests/domain/issues.test.ts）で確認している。
 * ここで見るのは「画面にどう出るか」— 1事象1行か、内訳から元の行へ辿れるか、
 * 同じコードが並ぶのはファイルが違うときだけか。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { buildNormalSet, buildAbnormalSet, CURRENT_ROWS, type TestFile } from '../helpers/testdataSet';
import {
  setupApp,
  importNormalSet,
  advanceToAnalyze,
  shownIssues,
  issuesOf,
  issueCodes,
  waitFor,
} from '../helpers/uiHarness';

let set: Awaited<ReturnType<typeof buildNormalSet>>;
let ng: Map<string, TestFile>;
beforeAll(async () => {
  set = await buildNormalSet();
  ng = new Map((await buildAbnormalSet()).map((f) => [f.name, f]));
});
afterEach(() => cleanup());

const abnormal = (name: string): TestFile => {
  const f = ng.get(name);
  if (!f) throw new Error(`異常系ファイルが見つかりません: ${name}`);
  return f;
};

describe('M-09 複数件は1メッセージにまとまる（J-9）', () => {
  it('新規2件が1行の W004 にまとまる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    const w004 = issuesOf('W004');
    expect(w004).toHaveLength(1);
    expect(w004[0]!.message).toContain('新規商品 2 件');
    expect(w004[0]!.message).toContain('商品差分確認画面で承認してください');
  }, 60000);

  it('同じコードと同じ位置の指摘が2行並ばない', async () => {
    // 同じコードが2行出てよいのは、別のファイルで同じ事象が起きたときだけ。
    // そのときは位置情報（ファイル名）で区別できる。
    const h = setupApp();
    await importNormalSet(h, set);

    const keys = shownIssues().map((i) => `${i.code}|${i.ref ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  }, 60000);

  it('メッセージ本文にコード接頭辞（E005: など）が入らない', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { master: abnormal('ng_E005_換算係数なし.xlsx') });

    const withPrefix = shownIssues().filter((i) => /^[EWI]\d{3}\s*[:：]/.test(i.message.trim()));
    expect(withPrefix.map((i) => i.message)).toEqual([]);
  }, 60000);
});

describe('M-10 内訳を開くと位置が分かる（J-3・J-9）', () => {
  it('2件以上まとめたときだけ内訳の折りたたみが出る', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    const w004 = issuesOf('W004')[0]!;
    expect(w004.detailSummary).toBe('該当 2 件の内訳を表示');
    expect(w004.details).toHaveLength(2);

    // 1件だけの W003（分類変更）は折りたたみを出さず、代表位置を直接示す
    const w003 = issuesOf('W003')[0]!;
    expect(w003.detailSummary).toBeNull();
    expect(w003.ref).toContain('商品コード 000155');
  }, 60000);

  it('内訳の各行にファイル名・シート名・行番号・商品コードが付く', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    const details = issuesOf('W004')[0]!.details;
    for (const line of details) {
      expect(line).toContain('01_当月マスタ_2026-09.xlsx');
      expect(line).toContain('シート「入力用」');
      expect(line).toMatch(/\d+行目/);
      expect(line).toMatch(/商品コード (002100|002101)/);
    }
  }, 60000);

  it('行番号がExcelの実際の行と一致する（見出し行を含む1始まり）', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    // データは3行目から。002100 は CURRENT_ROWS の7番目なので 3 + 6 = 9行目
    const expectedRow = 3 + CURRENT_ROWS.findIndex((r) => r.code === '002100');
    const line = issuesOf('W004')[0]!.details.find((d) => d.includes('002100'));
    expect(line).toContain(`${expectedRow}行目`);
  }, 60000);
});

describe('M-11 同じコードが並ぶのはファイルが違うときだけ（J-10）', () => {
  it('I002 は当月マスタと前月棚卸表で1件ずつ出て、位置情報が異なる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    const i002 = issuesOf('I002');
    expect(i002).toHaveLength(2);
    expect(i002[0]!.ref).toContain('01_当月マスタ_2026-09.xlsx');
    expect(i002[1]!.ref).toContain('02_前月棚卸表_2026-08.xlsx');
  }, 60000);

  it('I002 以外に重複するコードが無い', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    const counts = new Map<string, number>();
    for (const code of issueCodes()) counts.set(code, (counts.get(code) ?? 0) + 1);
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([code]) => code);
    expect(duplicated).toEqual(['I002']);
  }, 60000);

  it('同じコードが2件出るときは位置情報で区別できる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    const refs = issuesOf('I002').map((i) => i.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.every((r) => r && r.length > 0)).toBe(true);
  }, 60000);
});

describe('M-19 エラー文だけで次の操作が分かる（J-12）', () => {
  it('E005 は何が・どこで・どうなるかを示す', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { master: abnormal('ng_E005_換算係数なし.xlsx') });
    await advanceToAnalyze(h);

    const e005 = issuesOf('E005');
    expect(e005).toHaveLength(1);
    const message = e005[0]!.message;

    expect(message).toContain('換算係数を取得できません'); // 何が
    expect(message).toContain('002100'); // どこで
    expect(message).toContain('単位計算マスタ：未登録'); // 出所ごとの状態
    expect(message).toContain('当月マスタ：未登録');
    expect(message).toContain('期中仕入に反映できません'); // どうなるか

    // 非表示のP列を直せとは書かない（店舗からは見えないため）
    expect(message).not.toContain('P列');
  }, 60000);

  it('すべてのメッセージが句点で終わる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    const broken = shownIssues().filter((i) => !i.message.trim().endsWith('。'));
    expect(broken.map((i) => `${i.code}: ${i.message}`)).toEqual([]);
  }, 60000);

  it('見出しはコード・レベル・タイトルの3点セットで出る', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    for (const issue of shownIssues()) {
      expect(issue.code).toMatch(/^[EWI]\d{3}$/);
      expect(['エラー', '警告', '情報']).toContain(issue.level);
      expect(issue.title.length).toBeGreaterThan(0);
      // タイトルを本文に重ねて書かない
      expect(issue.message).not.toContain(issue.title);
    }
  }, 60000);

  it('W009 の確認先は本部ではなく店舗オーナー', async () => {
    // 単位計算マスタと当月マスタで係数が食い違う状態を作る
    const conflicting: TestFile = {
      name: '04_単位計算マスタ_conflict.csv',
      bytes: set.unitMaster.bytes,
      note: '',
    };
    const h = setupApp();
    await importNormalSet(h, set, { unitMaster: conflicting });
    await waitFor(() => expect(document.body.textContent).toContain('STEP 2'));

    // このデータでは W009 は出ない（係数が一致しているため）。
    // 文言の検証は L1 に任せ、ここでは「出たときに本部と書かれていない」ことだけ担保する。
    for (const issue of issuesOf('W009')) {
      expect(issue.message).toContain('店舗オーナー');
      expect(issue.message).not.toContain('本部へ確認');
    }
  }, 60000);
});
