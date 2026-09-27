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

describe('M-07b 登録外の商品も入力できる（要件§10-4）', () => {
  /** STEP 4 を開いて候補一覧を出すところまで */
  async function openStep4(): Promise<ReturnType<typeof setupApp>> {
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 3);
    await h.user.click(buttonByText('自店購入入力へ'));
    await waitFor(() => expect(document.body.textContent).toContain('STEP 4　自店購入入力'));
    return h;
  }
  const candidates = (): HTMLButtonElement[] =>
    [...document.querySelectorAll<HTMLButtonElement>('.candidate')];

  it('登録済みの5品だけでなく、当月マスタの食材も候補に出る', async () => {
    await openStep4();
    const text = candidates()
      .map((b) => b.textContent ?? '')
      .join(' / ');
    expect(text).toContain('A00043'); // 登録済み
    expect(text).toContain('001250'); // 登録済み
    expect(text).toContain('000140'); // 登録外の食材
    expect(text).not.toContain('041303'); // 備品は候補に出さない
  }, 60000);

  it('登録済みの品が候補の先頭に「登録済」つきで並ぶ', async () => {
    await openStep4();
    const list = candidates();
    expect(list[0]!.textContent).toContain('登録済');
    expect(list[1]!.textContent).toContain('登録済');
    expect(list[2]!.textContent).not.toContain('登録済');
  }, 60000);

  it('登録外を選ぶと理由が必須になり、空のままでは登録できない', async () => {
    const h = await openStep4();
    const target = candidates().find((b) => (b.textContent ?? '').includes('000140'))!;
    await h.user.click(target);

    await waitFor(() => {
      expect(document.body.textContent).toContain('登録外');
    });
    expect(document.body.textContent).toContain('なぜ自店購入として計上するのか');
    expect(findButton('この内容で登録')?.disabled).toBe(true);
  }, 60000);

  it('理由を入れれば登録でき、I005 で記録される', async () => {
    const h = await openStep4();
    const target = candidates().find((b) => (b.textContent ?? '').includes('000140'))!;
    await h.user.click(target);

    const fields = [...document.querySelectorAll<HTMLInputElement>('.panel input')];
    const note = fields.find((f) => f.placeholder === '例: 近隣スーパーで購入')!;
    fireEvent.change(note, { target: { value: '近隣スーパーで購入' } });

    await waitFor(() => expect(findButton('この内容で登録')?.disabled).toBe(false));
    await h.user.click(findButton('この内容で登録')!);

    await waitFor(() => {
      expect(document.body.textContent).toContain('入力済みの自店購入（1 件）');
    });

    // 情報ログは STEP 2 に出る。
    // 再計算の完了（STEP 5 への遷移）を待たずにタブを押すと、あとから setStep(5) に上書きされる。
    await h.user.click(buttonByText('計算して分析へ'));
    await waitFor(() => expect(document.body.textContent).toContain('STEP 5　分析・出力'));
    await goToStep(h, 2);
    await waitFor(() => expect(issuesOf('I005')).toHaveLength(1));
    expect(issuesOf('I005')[0]!.message).toContain('000140');
    expect(issuesOf('I005')[0]!.message).toContain('近隣スーパーで購入');
  }, 60000);

  it('登録済みの品を選んでも理由は求められない', async () => {
    const h = await openStep4();
    const target = candidates().find((b) => (b.textContent ?? '').includes('A00043'))!;
    await h.user.click(target);

    await waitFor(() => expect(findButton('この内容で登録')).not.toBeNull());
    expect(findButton('この内容で登録')?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('なぜ自店購入として計上するのか');
  }, 60000);
});

describe('M-08 当月マスタに無い品目は追加できない（J-5）', () => {
  it('当月マスタに無い品名では候補が出ず、行を作る手段も無い', async () => {
    // 候補は「登録済みの自店購入品」から「当月マスタの全商品」へ広げたが、
    // マスタに無い商品の行を画面から作れないことは変えていない。
    // 帳票の行構成は本部が決めるものであり、店舗側で増やしてよいものではない。
    const h = setupApp();
    await importNormalSet(h, set);
    await goToStep(h, 3);
    await h.user.click(buttonByText('自店購入入力へ'));
    await waitFor(() => expect(document.body.textContent).toContain('STEP 4　自店購入入力'));

    const search = document.querySelector<HTMLInputElement>('input[placeholder^="例:"]')!;
    fireEvent.change(search, { target: { value: 'このマスタに無い品名' } });

    await waitFor(() => {
      expect(document.body.textContent).toContain('該当する品目がありません');
    });
    expect(findButton('新しい品目を追加')).toBeNull();
  }, 60000);
});
