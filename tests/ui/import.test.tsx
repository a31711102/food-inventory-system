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

describe('M-04b STEP 2 で期中仕入が反映済みだと分かる', () => {
  it('反映済みの商品数と合計金額を示す', async () => {
    // プレビューの先頭3行がたまたま発注のない商品だと「期中仕入が0＝取り込めていない」
    // と誤解される。全体の件数と金額を出して、反映済みであることを示す。
    const h = setupApp();
    await importNormalSet(h, set);

    const text = document.body.textContent ?? '';
    expect(text).toContain('期中仕入は、発注累計照会からこの時点ですでに反映されています');
    expect(text).toContain('4 商品');
    expect(text).toContain('発注のなかった商品は 0 のままで、これは正常です');
  }, 60000);

  it('自店購入はSTEP4待ちであることを区別して書く', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    const text = document.body.textContent ?? '';
    expect(text).toContain('自店購入品 2 件');
    expect(text).toContain('STEP 4 で入力したあとに入ります');
  }, 60000);

  it('プレビューは期中仕入のある行を優先して出す', async () => {
    const h = setupApp();
    await importNormalSet(h, set);

    expect(document.body.textContent).toContain('取込プレビュー（期中仕入のある行を優先して3行）');
    // 先頭行の期中仕入が 0 でない（元の不具合では 000140 の 0 が最初に出ていた）
    const first = document.querySelectorAll('.grid tbody tr')[0]!;
    const cells = [...first.querySelectorAll('td')].map((c) => c.textContent ?? '');
    expect(cells[6]).not.toBe('0');
  }, 60000);

  it('発注累計を指定しなければ、反映済みとは書かない', async () => {
    const h = setupApp();
    await setTargetYm(h, TARGET_YM);
    await selectFile(h, 'master', set.master);
    await selectFile(h, 'previous', set.previous);
    await selectFile(h, 'unitMaster', set.unitMaster);
    await runImport(h);

    expect(document.body.textContent).toContain('取込プレビュー（先頭3行）');
  }, 60000);
});

describe('対象年月と発注累計の突合（E004）', () => {
  /**
   * テストデータの月（2026-09）と必ず食い違う月。
   * 既定値は「今日の前月」で月が替わるたびに動くため、既定のままに頼ると
   * 実行する月によってテストが通ったり落ちたりする（実際 2026-10 に落ちた）。
   * 食い違いは明示的に作る。
   */
  const WRONG_YM = '2026-06';

  async function importWithWrongYm(): Promise<ReturnType<typeof setupApp>> {
    const h = setupApp();
    await setTargetYm(h, WRONG_YM);
    await selectFile(h, 'master', set.master);
    await selectFile(h, 'previous', set.previous);
    await selectFile(h, 'orders', set.orders);
    await selectFile(h, 'unitMaster', set.unitMaster);
    await runImport(h);
    return h;
  }

  it('対象年月が発注累計の月と違うと E004 で止まる', async () => {
    await importWithWrongYm();
    expect(badgeCounts().blocking).toBe(1);
    expect(document.body.textContent).toContain('発注累計照会の集計期間が対象年月と一致しません');
  }, 60000);

  it('E004 のメッセージが、対象年月を直す道を示している', async () => {
    await importWithWrongYm();
    // 「ファイルが違う」だけでなく「対象年月を変える」も提示されていないと、
    // 過去の月をやり直そうとした人はここで詰まる。
    expect(document.body.textContent).toContain(`対象年月を ${TARGET_YM} に変更`);
  }, 60000);

  it('対象年月を合わせれば処理できる（過去の月もやり直せる）', async () => {
    // 報告された事象の再現と回復。対象年月は固定値ではない。
    const h = await importWithWrongYm();
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
