// @vitest-environment happy-dom
/**
 * 画面テスト M-16〜M-18（ファイルの取り違え）。
 * 手順: docs/06_画面テスト手順書.md §9
 *
 * 取り違えは画面上エラーにならず数字だけが静かに狂うため、必ず実施する区分。
 * 取込履歴は localStorage に残るので、ケースごとにリセットの有無を意識する。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { buildNormalSet, TARGET_YM, PREVIOUS_YM, type TestFile } from '../helpers/testdataSet';
import {
  setupApp,
  restartApp,
  importNormalSet,
  selectFile,
  setTargetYm,
  runImport,
  issuesOf,
  issueCodes,
  badgeCounts,
  type Harness,
} from '../helpers/uiHarness';

let set: Awaited<ReturnType<typeof buildNormalSet>>;
beforeAll(async () => {
  set = await buildNormalSet();
});
afterEach(() => cleanup());

/** 同じ中身で名前だけ違うファイルを作る（利用者がコピーを取ったときの状況） */
const renamed = (file: TestFile, name: string): TestFile => ({ ...file, name });

/** 対象年月を指定して当月マスタだけ取り込む（履歴を作る最小の操作） */
async function importMasterAs(h: Harness, ym: string, file: TestFile = set.master): Promise<void> {
  await selectFile(h, 'master', file); // STEP 1 へ戻ってから指定する
  await setTargetYm(h, ym);
  await runImport(h);
}

describe('M-16 同じファイルを2つの欄に入れる（W022）', () => {
  it('当月マスタを前月欄にも指定すると W022 が出る', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { previous: set.master });

    const w022 = issuesOf('W022');
    expect(w022).toHaveLength(1);
    expect(w022[0]!.message).toContain('当月本部マスタ棚卸表 と 前月食品棚卸表');
    expect(w022[0]!.message).toContain('欄を取り違えていないか確認してください');
    expect(w022[0]!.level).toBe('警告');
  }, 60000);

  it('正しく別々のファイルなら W022 は出ない', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    expect(issuesOf('W022')).toEqual([]);
  }, 60000);

  it('警告なので処理は止まらない', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { previous: set.master });

    expect(badgeCounts().blocking).toBe(0);
  }, 60000);
});

describe('M-17 名前を変えたコピーでも検知する（W022）', () => {
  it('ファイル名が違っても中身が同じなら W022 が出る', async () => {
    const h = setupApp();
    await importNormalSet(h, set, {
      previous: renamed(set.master, '当月マスタ (1).xlsx'),
    });

    const w022 = issuesOf('W022');
    expect(w022).toHaveLength(1);
    // 両方のファイル名が内訳として読める
    expect(w022[0]!.message).toContain('01_当月マスタ_2026-09.xlsx');
    expect(w022[0]!.message).toContain('当月マスタ (1).xlsx');
  }, 60000);

  it('名前が同じでも中身が違えば W022 は出ない', async () => {
    const h = setupApp();
    await importNormalSet(h, set, {
      previous: renamed(set.previous, '01_当月マスタ_2026-09.xlsx'),
    });

    expect(issuesOf('W022')).toEqual([]);
  }, 60000);
});

describe('M-18 前月のファイルを当月欄に入れる（W008）', () => {
  it('別の年月で取り込んだファイルを指定すると W008 が出る', async () => {
    const h = setupApp();
    // 1回目: 2026-08 として取り込み、履歴を作る
    await importMasterAs(h, PREVIOUS_YM);
    expect(issuesOf('W008')).toEqual([]);

    // 2回目: 対象年月を 2026-09 に変えて、同じファイルを指定し直す
    await importMasterAs(h, TARGET_YM);

    const w008 = issuesOf('W008');
    expect(w008).toHaveLength(1);
    expect(w008[0]!.message).toContain(PREVIOUS_YM);
    expect(w008[0]!.message).toContain('当月本部マスタ棚卸表');
    expect(w008[0]!.message).toContain('前月分のファイルを指定していないか確認してください');
  }, 60000);

  it('警告であって処理は止めない', async () => {
    const h = setupApp();
    await importMasterAs(h, PREVIOUS_YM);
    await importMasterAs(h, TARGET_YM);

    expect(issuesOf('W008')[0]!.level).toBe('警告');
    expect(badgeCounts().blocking).toBe(0);
  }, 60000);

  it('別の欄に入れ替えても検知する', async () => {
    const h = setupApp();
    await importMasterAs(h, TARGET_YM);

    // 同じファイルを今度は前月欄にも指定する（種別の取り違え）
    await selectFile(h, 'previous', set.master);
    await runImport(h);

    const w008 = issuesOf('W008');
    expect(w008).toHaveLength(1);
    expect(w008[0]!.message).toContain('前月食品棚卸表');
  }, 60000);

  it('同じ年月・同じ欄で取り直しても W008 は出ない（通常運用）', async () => {
    const h = setupApp();
    await importMasterAs(h, TARGET_YM);
    await importMasterAs(h, TARGET_YM);

    expect(issuesOf('W008')).toEqual([]);
  }, 60000);

  it('取り直しを繰り返しても履歴が膨らんで自分自身に反応しない', async () => {
    const h = setupApp();
    for (let i = 0; i < 4; i += 1) {
      await importMasterAs(h, TARGET_YM);
      expect(issuesOf('W008')).toEqual([]);
    }
  }, 60000);
});

describe('取込履歴の保存（W008 の前提）', () => {
  it('画面を開き直しても履歴が残り、W008 が出る', async () => {
    const first = setupApp();
    await importMasterAs(first, PREVIOUS_YM);

    // ブラウザを再読込した状況
    const second = restartApp(first);
    await importMasterAs(second, TARGET_YM);

    expect(issuesOf('W008')).toHaveLength(1);
  }, 60000);

  it('履歴をリセットすれば W008 は出ない（手順書 §2.3）', async () => {
    const first = setupApp();
    await importMasterAs(first, PREVIOUS_YM);

    first.rendered.unmount();
    const second = setupApp(); // localStorage.clear() を伴う
    await importMasterAs(second, TARGET_YM);

    expect(issuesOf('W008')).toEqual([]);
  }, 60000);
});

describe('取り違えの検知は取込の最初に出る', () => {
  it('W022 と W008 が指摘一覧の先頭に並ぶ', async () => {
    const h = setupApp();
    await importMasterAs(h, PREVIOUS_YM);
    await importNormalSet(h, set, { previous: set.master });

    const codes = issueCodes();
    // ファイルの取り違えは取込の最初に判定するので一覧の先頭に出る。
    // 後ろに回ると、読み進めるうちに埋もれてしまう。
    expect(codes.slice(0, 2)).toEqual(['W022', 'W008']);
  }, 60000);
});
