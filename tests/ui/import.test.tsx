// @vitest-environment happy-dom
/**
 * 画面テスト M-01〜M-04（STEP 1〜2：取込）。
 * 手順: docs/06_画面テスト手順書.md §4
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { buildNormalSet, TARGET_YM } from '../helpers/testdataSet';
import {
  setupApp,
  selectFile,
  clearFile,
  setTargetYm,
  runImport,
  importNormalSet,
  advanceToAnalyze,
  goToStep,
  stepTabs,
  buttonByText,
  findButton,
  badgeCounts,
  waitFor,
} from '../helpers/uiHarness';

let set: Awaited<ReturnType<typeof buildNormalSet>>;
beforeAll(async () => {
  set = await buildNormalSet();
});
afterEach(() => cleanup());

describe('M-01 取込前はSTEP2以降が開けない（J-1）', () => {
  it('STEP 2〜5 のタブが押せない', () => {
    setupApp();
    const tabs = stepTabs();
    expect(tabs).toHaveLength(5);
    expect(tabs[0]!.disabled).toBe(false);
    expect(tabs.slice(1).map((t) => t.disabled)).toEqual([true, true, true, true]);
  });

  it('取込後はすべてのタブが開く', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    expect(stepTabs().map((t) => t.disabled)).toEqual([false, false, false, false, false]);
  }, 60000);
});

describe('M-02 必須ファイルが無いと取り込めない（J-1）', () => {
  it('当月マスタが未指定なら「取り込んで次へ」が押せない', async () => {
    const h = setupApp();
    await selectFile(h, 'previous', set.previous);
    await selectFile(h, 'orders', set.orders);
    await selectFile(h, 'unitMaster', set.unitMaster);

    expect(buttonByText('取り込んで次へ').disabled).toBe(true);
    expect(document.body.textContent).toContain('当月本部マスタは必須です。');
  }, 60000);

  it('当月マスタを指定すると押せるようになる', async () => {
    const h = setupApp();
    await selectFile(h, 'master', set.master);
    expect(buttonByText('取り込んで次へ').disabled).toBe(false);
  }, 60000);
});

describe('M-03 ファイルを変えると結果が無効になる（J-2）', () => {
  it('ファイルを取り消すと警告帯と再計算ボタンが出て、出力できなくなる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);

    // 出力できる状態であることを先に確かめる
    expect(findButton('完成Excelをダウンロード')?.disabled).toBe(false);

    await goToStep(h, 1);
    await clearFile(h, 'orders');

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        '入力ファイルまたは対象年月が変更されました。前回の計算結果は無効です。',
      );
    });
    expect(findButton('再計算する')).not.toBeNull();

    await goToStep(h, 5);
    expect(findButton('完成Excelをダウンロード')?.disabled).toBe(true);
  }, 60000);

  it('対象年月を変えても結果が無効になる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await setTargetYm(h, '2026-10');

    await waitFor(() => {
      expect(document.body.textContent).toContain('前回の計算結果は無効です');
    });
  }, 60000);
});

describe('M-04 取込結果の要約が正しい（J-1）', () => {
  it('商品数・前月件数・発注明細・単位計算マスタの件数が合う', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    const kpis = [...document.querySelectorAll('.kpi')].map((e) => e.textContent ?? '');
    expect(kpis[0]).toContain('取り込んだ商品');
    expect(kpis[0]).toContain('10 件');
    expect(kpis[0]).toContain('うち自店購入 2 件');
    expect(kpis[0]).toContain('備品（計算対象外） 1 件');
    expect(kpis[1]).toContain('前月データ');
    expect(kpis[1]).toContain('9 件');
    expect(kpis[2]).toContain('発注明細');
    expect(kpis[2]).toContain('6 行');
    expect(kpis[2]).toContain('換算不能 0 行');
    expect(kpis[3]).toContain('単位計算マスタ');
    expect(kpis[3]).toContain('5 件');
  }, 60000);

  it('正常系4ファイルではエラーが出ない', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    // STEP 2 時点では新規商品の期首が未承認なので警告8件・情報3件
    // 備品の発注を I004 として記録するため情報は4件
    expect(badgeCounts()).toEqual({ blocking: 0, warning: 8, info: 4 });
  }, 60000);

  it('対象年月は既定で前月になっており、指定すれば反映される', async () => {
    const h = setupApp();
    const input = document.querySelector<HTMLInputElement>('input[type=month]')!;
    const now = new Date();
    const expected = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    expect(input.value).toBe(
      `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}`,
    );

    await setTargetYm(h, TARGET_YM);
    expect(input.value).toBe(TARGET_YM);
  });
});

describe('対象年月と発注累計の突合（E004）', () => {
  it('対象年月を直さないと E004 で止まる', async () => {
    // 既定の対象年月（前月）のまま取り込むと、発注累計の集計期間(2026-09)と食い違う。
    // 手順書 §2.2 で対象年月を 2026-09 に設定させているのはこのため。
    const h = setupApp();
    await selectFile(h, 'master', set.master);
    await selectFile(h, 'previous', set.previous);
    await selectFile(h, 'orders', set.orders);
    await selectFile(h, 'unitMaster', set.unitMaster);
    await runImport(h);

    expect(badgeCounts().blocking).toBe(1);
    expect(document.body.textContent).toContain('発注累計照会の集計期間が対象年月と一致しません');
  }, 60000);

  it('E004 のメッセージが、対象年月を直す道を示している', async () => {
    const h = setupApp();
    await selectFile(h, 'master', set.master);
    await selectFile(h, 'previous', set.previous);
    await selectFile(h, 'orders', set.orders);
    await selectFile(h, 'unitMaster', set.unitMaster);
    await runImport(h);

    // 「ファイルが違う」だけでなく「対象年月を変える」も提示されていないと、
    // 過去の月をやり直そうとした人はここで詰まる。
    expect(document.body.textContent).toContain(`対象年月を ${TARGET_YM} に変更`);
  }, 60000);

  it('対象年月を合わせれば、既定の月でなくても処理できる', async () => {
    // 報告された事象の再現と回復。既定は「前月」だが、
    // 対象年月をファイルに合わせれば任意の月を処理できる（固定ではない）。
    const h = setupApp();
    await selectFile(h, 'master', set.master);
    await selectFile(h, 'previous', set.previous);
    await selectFile(h, 'orders', set.orders);
    await selectFile(h, 'unitMaster', set.unitMaster);
    await runImport(h);
    expect(badgeCounts().blocking).toBe(1);

    await setTargetYm(h, TARGET_YM);
    await runImport(h);

    expect(badgeCounts().blocking).toBe(0);
    expect(document.body.textContent).not.toContain('発注累計照会の集計期間が対象年月と一致しません');
  }, 60000);
});

describe('対象年月の指定場所（固定値ではないと分かること）', () => {
  it('STEP 1 に対象年月の入力欄があり、既定は今日の前月', () => {
    setupApp();
    const input = document.querySelector<HTMLInputElement>('input[type=month]');
    expect(input).not.toBeNull();
    const now = new Date();
    const expected = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    expect(input!.value).toBe(
      `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}`,
    );
  });

  it('既定値が今日から導かれていることを画面に書いてある', () => {
    setupApp();
    expect(document.body.textContent).toContain('初期値は今日');
    expect(document.body.textContent).toContain('過去の月をやり直すとき');
  });

  it('入力欄は STEP 1 だけ。他のステップではヘッダから STEP 1 へ戻す', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 5);

    expect(document.querySelector('input[type=month]')).toBeNull();
    const back = findButton('STEP 1 で変更');
    expect(back).not.toBeNull();
    await h.user.click(back!);
    expect(document.querySelector('input[type=month]')).not.toBeNull();
  }, 60000);
});
