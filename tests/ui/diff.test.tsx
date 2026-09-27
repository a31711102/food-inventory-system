// @vitest-environment happy-dom
/**
 * 画面テスト M-05〜M-08（STEP 3：商品差分／STEP 4：自店購入）。
 * 手順: docs/06_画面テスト手順書.md §5・§6
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { buildNormalSet } from '../helpers/testdataSet';
import {
  setupApp,
  importNormalSet,
  advanceToAnalyze,
  goToStep,
  buttonByText,
  findButton,
  issuesOf,
  badgeCounts,
  waitFor,
} from '../helpers/uiHarness';

let set: Awaited<ReturnType<typeof buildNormalSet>>;
beforeAll(async () => {
  set = await buildNormalSet();
});
afterEach(() => cleanup());

function badges(): string[] {
  return [...document.querySelectorAll('.badge')].map((e) => e.textContent ?? '');
}

describe('M-05 新規・削除・変更の件数（J-4）', () => {
  it('継続6・新規2・削除1・商品名変更1・分類変更1', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 3);

    expect(badges()).toEqual([
      '継続 8 件',
      '新規 2 件',
      '削除 1 件',
      '商品名変更 1 件',
      '分類変更 1 件',
    ]);
  }, 60000);

  it('削除商品の残在庫が W001 として示される', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 3);

    const w001 = issuesOf('W001');
    expect(w001).toHaveLength(1);
    expect(w001[0]!.message).toContain('000999');
    expect(w001[0]!.message).toContain('前月期末 3');
  }, 60000);

  it('分類変更は集計先が変わることまで伝える', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 3);

    const w003 = issuesOf('W003');
    expect(w003).toHaveLength(1);
    expect(w003[0]!.message).toContain('000155');
    expect(w003[0]!.message).toContain('新しい分類へ集計されます');
  }, 60000);
});

describe('M-06 承認するとW004が消える（J-4）', () => {
  it('承認前は W004 が出ている', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 3);

    const w004 = issuesOf('W004');
    expect(w004).toHaveLength(1);
    expect(w004[0]!.message).toContain('新規商品 2 件');
  }, 60000);

  it('すべて承認して再計算すると W004 が消え、警告が1件減る', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    const before = badgeCounts().warning;

    await goToStep(h, 3);
    await h.user.click(buttonByText('すべて承認する'));
    await advanceToAnalyze(h);

    expect(issuesOf('W004')).toEqual([]);
    expect(badgeCounts().warning).toBe(before - 1);
  }, 60000);
});

describe('M-07 品名の入力中に候補が絞り込まれる（J-5）', () => {
  it('入力前は自店購入2件が候補に出る', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 3);
    await h.user.click(buttonByText('自店購入入力へ'));
    await waitFor(() => expect(document.body.textContent).toContain('STEP 4　自店購入入力'));

    // 自店購入はAコードかどうかでは決まらない（2026-09-27 確認）。
    // キャベツはAコード、ミニトマトは4桁の本部コード。
    const text = document.body.textContent ?? '';
    expect(text).toContain('A00043');
    expect(text).toContain('001250');
  }, 60000);

  it('「トマト」と入力すると候補が1件に絞られる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 3);
    await h.user.click(buttonByText('自店購入入力へ'));
    await waitFor(() => expect(document.body.textContent).toContain('STEP 4　自店購入入力'));

    const search = document.querySelector<HTMLInputElement>('input[placeholder^="例:"]')!;
    fireEvent.change(search, { target: { value: 'トマト' } });

    await waitFor(() => {
      const text = document.body.textContent ?? '';
      expect(text).toContain('001250');
      expect(text).not.toContain('A00043');
    });
  }, 60000);

  it('検索方法（前方一致・部分一致など）を選ぶ欄が存在しない', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 3);
    await h.user.click(buttonByText('自店購入入力へ'));
    await waitFor(() => expect(document.body.textContent).toContain('STEP 4　自店購入入力'));

    // 要件§7-4「検索方法を利用者に選ばせない」
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('前方一致');
    expect(text).not.toContain('完全一致');
    // ロール以外の <select> が無いこと
    const selects = [...document.querySelectorAll('select')];
    expect(selects.filter((s) => !s.textContent?.includes('管理者'))).toHaveLength(0);
  }, 60000);
});

describe('M-08 マスタに無い品目は追加できない（J-5）', () => {
  it('マスタに無い品名では候補が出ず、追加手段も無い', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 3);
    await h.user.click(buttonByText('自店購入入力へ'));
    await waitFor(() => expect(document.body.textContent).toContain('STEP 4　自店購入入力'));

    const search = document.querySelector<HTMLInputElement>('input[placeholder^="例:"]')!;
    fireEvent.change(search, { target: { value: 'にんじん' } });

    await waitFor(() => {
      const text = document.body.textContent ?? '';
      expect(text).not.toContain('A00043');
      expect(text).not.toContain('001250');
    });
    expect(document.body.textContent).toContain(
      'ここに出ない品目は自店購入品として登録されていません',
    );
    expect(findButton('新しい品目を追加')).toBeNull();
  }, 60000);
});
