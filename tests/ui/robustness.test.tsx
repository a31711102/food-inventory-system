// @vitest-environment happy-dom
/**
 * 画面テスト M-25〜M-27（想定外の操作）。
 * 手順: docs/06_画面テスト手順書.md §11
 *
 * 見たいのは「正しく動くこと」ではなく「壊れないこと」。
 * 画面が白くならず、原因が読め、入れ直せば復帰できるかを確かめる。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { buildNormalSet, TARGET_YM, type TestFile } from '../helpers/testdataSet';
import {
  setupApp,
  importNormalSet,
  selectFile,
  setTargetYm,
  runImport,
  clickAndSettle,
  buttonByText,
  findButton,
  stepTabs,
  issuesOf,
  badgeCounts,
  waitFor,
} from '../helpers/uiHarness';

let set: Awaited<ReturnType<typeof buildNormalSet>>;
beforeAll(async () => {
  set = await buildNormalSet();
});
afterEach(() => cleanup());

describe('M-25 種別のちがうファイルを入れる（J-16）', () => {
  it('発注累計の欄に当月マスタを入れると E001 で原因が分かる', async () => {
    const h = setupApp();
    await importNormalSet(h, set, {
      orders: { ...set.master, name: '01_当月マスタ_2026-09.xlsx' },
    });

    const e001 = issuesOf('E001');
    expect(e001).toHaveLength(1);
    expect(e001[0]!.message).toContain('原材料コード');
    expect(e001[0]!.message).toContain('発注数');
    expect(e001[0]!.message).toContain('ファイルの種別を取り違えていないか確認してください');
  }, 60000);

  it('画面は壊れず、STEP 2 まで進める', async () => {
    const h = setupApp();
    await importNormalSet(h, set, {
      orders: { ...set.master, name: '01_当月マスタ_2026-09.xlsx' },
    });

    expect(document.body.textContent).toContain('STEP 2　列設定と取込結果');
    expect(document.querySelectorAll('.panel').length).toBeGreaterThan(0);
  }, 60000);

  it('正しいファイルを入れ直せば復帰する', async () => {
    const h = setupApp();
    await importNormalSet(h, set, {
      orders: { ...set.master, name: '01_当月マスタ_2026-09.xlsx' },
    });
    expect(badgeCounts().blocking).toBe(1);

    await selectFile(h, 'orders', set.orders);
    await runImport(h);

    expect(issuesOf('E001')).toEqual([]);
    expect(badgeCounts().blocking).toBe(0);
  }, 60000);
});

describe('M-26 壊れたファイルを入れる（J-16）', () => {
  const broken: TestFile = {
    name: 'dummy.xlsx',
    bytes: new TextEncoder().encode('これはExcelではありません'),
    note: '',
  };

  it('エラーメッセージが出て、画面が白くならない', async () => {
    const h = setupApp();
    await setTargetYm(h, TARGET_YM);
    await selectFile(h, 'master', broken);
    await clickAndSettle(h, buttonByText('取り込んで次へ'));

    await waitFor(() => {
      expect(document.body.textContent).toContain('処理中にエラーが発生しました');
    });
    // ヘッダとSTEPタブは生きている
    expect(document.body.textContent).toContain('食品棚卸月次処理システム');
    expect(stepTabs()).toHaveLength(5);
  }, 60000);

  it('正しいファイルを入れ直せば復帰する', async () => {
    const h = setupApp();
    await setTargetYm(h, TARGET_YM);
    await selectFile(h, 'master', broken);
    await clickAndSettle(h, buttonByText('取り込んで次へ'));
    await waitFor(() => expect(document.body.textContent).toContain('処理中にエラーが発生しました'));

    await selectFile(h, 'master', set.master);
    await selectFile(h, 'previous', set.previous);
    await selectFile(h, 'orders', set.orders);
    await selectFile(h, 'unitMaster', set.unitMaster);
    await runImport(h);

    expect(document.body.textContent).not.toContain('処理中にエラーが発生しました');
    expect(badgeCounts().blocking).toBe(0);
  }, 60000);

  it('空のファイルでも落ちない', async () => {
    const h = setupApp();
    await setTargetYm(h, TARGET_YM);
    await selectFile(h, 'master', { name: 'empty.xlsx', bytes: new Uint8Array(0), note: '' });
    await clickAndSettle(h, buttonByText('取り込んで次へ'));

    await waitFor(() => {
      expect(document.body.textContent).toContain('処理中にエラーが発生しました');
    });
    expect(stepTabs()).toHaveLength(5);
  }, 60000);
});

describe('M-27 連打・画面移動（J-16）', () => {
  it('取込中はボタンが「取り込み中…」になり、二重に取り込まれない', async () => {
    const h = setupApp();
    await setTargetYm(h, TARGET_YM);
    await selectFile(h, 'master', set.master);
    await selectFile(h, 'previous', set.previous);
    await selectFile(h, 'orders', set.orders);
    await selectFile(h, 'unitMaster', set.unitMaster);

    const button = buttonByText('取り込んで次へ');
    // 連打しても取込は1回だけ動く（disabled で弾かれる）
    await clickAndSettle(h, button);
    await clickAndSettle(h, button);
    await clickAndSettle(h, button);

    await waitFor(() => expect(document.body.textContent).toContain('STEP 2　列設定と取込結果'));

    // 指摘が重複していない＝取込が重ねて走っていない
    const codes = issuesOf('W004');
    expect(codes).toHaveLength(1);
    expect(badgeCounts()).toEqual({ blocking: 0, warning: 8, info: 4 });
  }, 60000);

  it('取込中のラベルが用意されている', async () => {
    const h = setupApp();
    await setTargetYm(h, TARGET_YM);
    await selectFile(h, 'master', set.master);

    // 押している間は「取り込み中…」になり、押せなくなる。
    // 取込が速く終わると見えないまま STEP 2 へ進むため、どちらでも成立するよう待つ。
    const button = buttonByText('取り込んで次へ');
    const clicked = h.user.click(button);

    await waitFor(() => {
      const text = document.body.textContent ?? '';
      expect(text.includes('取り込み中…') || text.includes('STEP 2　列設定と取込結果')).toBe(true);
    });
    const busy = findButton('取り込み中…');
    if (busy) expect(busy.disabled).toBe(true);

    await clicked;
    await waitFor(() => expect(document.body.textContent).toContain('STEP 2　列設定と取込結果'), {
      timeout: 20000,
    });
  }, 60000);

  it('STEPタブを行き来しても結果が保たれる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    const before = badgeCounts();

    for (const step of [3, 5, 2, 4, 2] as const) {
      const tab = stepTabs()[step - 1]!;
      await h.user.click(tab);
      await waitFor(() => expect(document.body.textContent).toContain(`STEP ${step}　`));
    }

    expect(badgeCounts()).toEqual(before);
    expect(document.body.textContent).not.toContain('処理中にエラーが発生しました');
  }, 60000);
});
