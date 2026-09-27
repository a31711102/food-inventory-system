// @vitest-environment happy-dom
/**
 * 画面テスト M-12〜M-15（STEP 5：分析・出力）。
 * 手順: docs/06_画面テスト手順書.md §8
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import {
  buildNormalSet,
  buildAbnormalSet,
  CURRENT_ROWS,
  TOTAL_SALES,
  type TestFile,
} from '../helpers/testdataSet';
import { XlsxWorkbook } from '@/xlsx/workbook';
import {
  setupApp,
  importNormalSet,
  advanceToAnalyze,
  buttonByText,
  clickAndSettle,
  downloadWorkbook,
  findButton,
  issuesOf,
  badgeCounts,
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

function panelTitles(): string[] {
  return [...document.querySelectorAll('.panel h2')].map((e) => e.textContent ?? '');
}

describe('M-12 異常判定と水準目安が分かれている（J-6）', () => {
  it('別々のセクションとして表示される', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);

    const titles = panelTitles();
    expect(titles).toContain('異常判定（前月比）');
    expect(titles).toContain('水準の目安（参考）');
    expect(titles).toContain('レポート比較（前月比）');
    expect(titles.indexOf('異常判定（前月比）')).toBeLessThan(titles.indexOf('水準の目安（参考）'));
  }, 60000);

  it('目安のセクションに「異常判定とは無関係」と明記されている', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);

    expect(document.body.textContent).toContain(
      '運用上の目安であり、前月比による異常判定とは無関係です',
    );
  }, 60000);

  it('前月比の差はpt表記で、閾値2.0ptが併記される', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);

    const text = document.body.textContent ?? '';
    expect(text).toContain('ロス引き後原価率');
    expect(text).toMatch(/-?\d+\.\d+pt/);
    expect(text).toContain('2.0pt');
  }, 60000);
});

describe('M-13 算出できない項目は理由つきで出る（J-8）', () => {
  it('売上高が無いと W005 が出て、次の操作が書かれている', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { master: abnormal('ng_W005_E011_売上高なし.xlsx') });

    const w005 = issuesOf('W005');
    expect(w005).toHaveLength(1);
    expect(w005[0]!.message).toContain('原価率を算出できません');
    expect(w005[0]!.message).toContain('分析用シートの当月売上高を確認するか、分析・出力画面で入力してください');
  }, 60000);

  it('原価率が「0%」ではなく算出不可として表示される', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { master: abnormal('ng_W005_E011_売上高なし.xlsx') });
    await advanceToAnalyze(h);

    const kpiTexts = [...document.querySelectorAll('.kpi')].map((e) => e.textContent ?? '');
    const costRate = kpiTexts.find((t) => t.includes('ロス引き後原価率'));
    expect(costRate).toBeDefined();
    expect(costRate).not.toContain('0.00%');
    expect(costRate).not.toMatch(/\d+\.\d+%/);
    expect(costRate).toContain('算出不可');
  }, 60000);

  it('画面で売上高を入力して再計算すると原価率が出る', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { master: abnormal('ng_W005_E011_売上高なし.xlsx') });
    await advanceToAnalyze(h);

    const salesInput = document.querySelector<HTMLInputElement>('input[type=number]')!;
    fireEvent.change(salesInput, { target: { value: String(TOTAL_SALES) } });
    await clickAndSettle(h, buttonByText('再計算'));

    await waitFor(
      () => {
        const kpi = [...document.querySelectorAll('.kpi')]
          .map((e) => e.textContent ?? '')
          .find((t) => t.includes('ロス引き後原価率'));
        expect(kpi).toMatch(/\d+\.\d+%/);
      },
      { timeout: 20000 },
    );
    expect(issuesOf('W005')).toEqual([]);
    expect(document.body.textContent).toContain(TOTAL_SALES.toLocaleString());
  }, 60000);
});

describe('M-14 ロール切替で表示が変わる（J-13）', () => {
  it('店舗担当者へ切り替えても画面が壊れない', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);

    const roleSelect = [...document.querySelectorAll('select')].find((s) =>
      s.textContent?.includes('管理者'),
    )!;
    fireEvent.change(roleSelect, { target: { value: 'STAFF' } });

    await waitFor(() => expect(roleSelect.value).toBe('STAFF'));
    expect(document.body.textContent).toContain('STEP 5　分析・出力');
    expect(document.querySelectorAll('.panel').length).toBeGreaterThan(0);
  }, 60000);

  it('管理者へ戻せる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);

    const roleSelect = [...document.querySelectorAll('select')].find((s) =>
      s.textContent?.includes('管理者'),
    )!;
    fireEvent.change(roleSelect, { target: { value: 'STAFF' } });
    await waitFor(() => expect(roleSelect.value).toBe('STAFF'));
    fireEvent.change(roleSelect, { target: { value: 'ADMIN' } });
    await waitFor(() => expect(roleSelect.value).toBe('ADMIN'));

    expect(document.body.textContent).toContain('STEP 5　分析・出力');
  }, 60000);
});

describe('M-15 エラーがあるとダウンロードできない（J-7）', () => {
  it('E005 があるとダウンロードボタンが押せず、理由が画面に出る', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { master: abnormal('ng_E005_換算係数なし.xlsx') });
    await advanceToAnalyze(h);

    expect(badgeCounts().blocking).toBe(1);
    expect(findButton('完成Excelをダウンロード')?.disabled).toBe(true);
    expect(panelTitles()).toContain('未解決のエラー');
    expect(document.body.textContent).toContain('エラーが 1 件あるため出力できません');
  }, 60000);

  it('E004（別の月の発注累計）でもダウンロードできない', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { orders: abnormal('ng_E004_発注累計_別の月.csv') });
    await advanceToAnalyze(h);

    expect(issuesOf('E004')).toHaveLength(1);
    expect(findButton('完成Excelをダウンロード')?.disabled).toBe(true);
  }, 60000);

  it('E012（単位計算マスタの矛盾）でもダウンロードできない', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { unitMaster: abnormal('ng_E012_単位計算マスタ_矛盾.csv') });
    await advanceToAnalyze(h);

    expect(issuesOf('E012')).toHaveLength(1);
    expect(findButton('完成Excelをダウンロード')?.disabled).toBe(true);
  }, 60000);

  it('E015（期末在庫が負）でもダウンロードできない', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { master: abnormal('ng_E015_期末在庫がマイナス.xlsx') });
    await advanceToAnalyze(h);

    const e015 = issuesOf('E015');
    expect(e015).toHaveLength(1);
    expect(e015[0]!.message).toContain('期末在庫 -2');
    expect(findButton('完成Excelをダウンロード')?.disabled).toBe(true);
  }, 60000);

  it('エラーが無ければダウンロードできる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);

    expect(badgeCounts().blocking).toBe(0);
    expect(findButton('完成Excelをダウンロード')?.disabled).toBe(false);
  }, 60000);
});

describe('返品行の扱い（要件§10-1）', () => {
  // 返品は本システムの管理対象外だが、式どおり計算すると期中仕入から引かれる。
  // 年数回しか起きないため、黙って引かずに知らせる（2026-09-27 確定）。
  it('STEP 2 の警告一覧に W023 が出る', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { orders: abnormal('ng_W023_発注累計_返品行あり.csv') });

    const w023 = issuesOf('W023');
    expect(w023).toHaveLength(1);
    expect(w023[0]!.level).toBe('警告');
    expect(w023[0]!.message).toContain('発注数 -3');
    expect(w023[0]!.message).toContain('期中仕入から差し引いて計算します');
  }, 60000);

  it('警告なので処理は止まらず、出力もできる', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { orders: abnormal('ng_W023_発注累計_返品行あり.csv') });
    expect(badgeCounts().blocking).toBe(0);

    await advanceToAnalyze(h);
    expect(findButton('完成Excelをダウンロード')?.disabled).toBe(false);
  }, 60000);

  it('返品分が期中仕入から引かれる', async () => {
    const h = setupApp();
    await importNormalSet(h, set, { orders: abnormal('ng_W023_発注累計_返品行あり.csv') });
    await advanceToAnalyze(h);
    const out = await downloadWorkbook(h);
    const wb = await XlsxWorkbook.load(out.data);

    // 000158 は発注 -3 × 計算単位1 = -3。入力用の行は見出し2・データ3〜で2番目
    const row = 3 + CURRENT_ROWS.findIndex((r) => r.code === '000158');
    expect(wb.cell('入力用', `H${row}`)?.value).toBe(-3);
  }, 60000);
});
