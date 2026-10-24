// @vitest-environment happy-dom
/**
 * 画面テスト STEP 5 売上確定（要件§11.6・RS-04・RS-06・RS-07）。
 *
 * happy-dom では OCR（WASM・Canvas）は動かないので、写真なしで手入力する経路で確かめる。
 * これは OCR が読めなかったときの代替経路でもある。OCR そのものは
 * tests/integration/realJournalOcr.test.ts（実写真）と tests/ocr/（検算・補正）で検証している。
 * 値はすべて架空（料率・容器単価・売上）。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { cleanup, fireEvent, within } from '@testing-library/react';
import { buildNormalSet, TARGET_YM } from '../helpers/testdataSet';
import { buildProductSalesCsv, TEST_EXPECTED, TEST_JOURNAL } from '../helpers/realSalesData';
import { buildSimpleWorkbook } from '../helpers/buildXlsx';
import { XlsxWorkbook } from '@/xlsx/workbook';
import {
  setupApp,
  importNormalSet,
  goToStep,
  buttonByText,
  findButton,
  issuesOf,
  downloadWorkbook,
  waitFor,
  type Harness,
} from '../helpers/uiHarness';

let set: Awaited<ReturnType<typeof buildNormalSet>>;
let masterXlsx: Uint8Array;
beforeAll(async () => {
  set = await buildNormalSet();
  masterXlsx = await buildSimpleWorkbook('Sheet1', {
    A1: 'チャンネル', C1: '手数料率',
    A2: 'menu', C2: 0.2,
    A3: 'シェアデリ', C3: 0.275,
    A4: 'UE配達代行', C4: 0.33,
    A5: 'UE麵屋代行', C5: 0.33,
    A6: 'UEラ－メン代', C6: 0.33,
    A7: 'ロケットナウ', C7: 0.15,
    A10: 'チャンネル', C10: '控除額単価',
    A11: 'TO', C11: 40,
  });
});
afterEach(() => cleanup());

const text = (): string => document.body.textContent ?? '';

async function openStep5(h: Harness, approve = false): Promise<void> {
  await importNormalSet(h, set);
  await goToStep(h, 3);
  if (approve) await h.user.click(buttonByText('すべて承認する'));
  await h.user.click(buttonByText('自店購入入力へ'));
  await waitFor(() => expect(text()).toContain('STEP 4　自店購入入力'));
  await h.user.click(buttonByText('次へ：売上確定'));
  await waitFor(() => expect(text()).toContain('STEP 5　売上確定'));
}

async function chooseReal(h: Harness): Promise<void> {
  await h.user.click(document.querySelectorAll<HTMLInputElement>('input[name=sales-method]')[1]!);
  await waitFor(() => expect(text()).toContain('料率・容器単価マスタ'));
}

async function importMasters(h: Harness): Promise<void> {
  const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('既存のマスタExcelから取り込む'))!;
  const input = label.querySelector('input[type=file]') as HTMLInputElement;
  await h.user.upload(input, new File([masterXlsx.slice().buffer as ArrayBuffer], 'リアル売上算出（マスタ）.xlsx'));
  await waitFor(() => expect(text()).toContain('6 チャネルの料率と容器単価を取り込みました'));
}

async function uploadCsv(h: Harness): Promise<void> {
  const slot = [...document.querySelectorAll('.file-slot')].find((s) => s.textContent?.includes('商品別売上CSV'))!;
  await h.user.upload(slot.querySelector('input[type=file]') as HTMLInputElement, new File([buildProductSalesCsv().slice().buffer as ArrayBuffer], '商品別売上.csv'));
  await waitFor(() => expect(text()).toContain(`${TEST_EXPECTED.containerQty} 個`));
}

function typeInto(label: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`入力欄が見つかりません: ${label}`);
  fireEvent.change(input, { target: { value } });
}

/** 写真を見ながら手入力したことにする（架空のジャーナル） */
async function enterJournal(h: Harness): Promise<void> {
  typeInto('営業月', TARGET_YM);
  typeInto('総計1（税抜値割引前）', TEST_JOURNAL.grossTotal!);
  typeInto('値割引合計', TEST_JOURNAL.discountTotal!);
  typeInto('（値割引消費税）', TEST_JOURNAL.discountTax!);
  typeInto('売掛（合計）', TEST_JOURNAL.receivableTotal!);
  for (const [i, line] of TEST_JOURNAL.receivables.entries()) {
    await h.user.click(buttonByText('内訳の行を追加'));
    typeInto(`追加${i + 1}の表記`, line.label);
    typeInto(`追加${i + 1}の金額`, line.amount);
  }
}

/** 計算内訳が出るまで待つ（総計1・内訳・出数がそろったとき） */
async function waitBreakdown(): Promise<void> {
  await waitFor(() => expect(text()).toContain('食材費計算用リアル売上'));
}

describe('STEP 5 売上確定：手入力方式（従来）', () => {
  it('既定は手入力方式で、当月マスタの C4 の扱いを示し、そのまま分析へ進める', async () => {
    const h = setupApp();
    await openStep5(h);
    expect(document.querySelectorAll<HTMLInputElement>('input[name=sales-method]')[0]!.checked).toBe(true);
    expect(text()).toContain('当月本部マスタの当月売上高（分析用 C4）は');
    await h.user.click(buttonByText('計算して分析へ'));
    await waitFor(() => expect(text()).toContain('STEP 6　分析・出力'));
    expect(issuesOf('E017')).toEqual([]);
  }, 60000);
});

describe('STEP 5 売上確定：リアル売上方式', () => {
  it('料率が未登録なら案内が出て、計算内訳は出ない（料率はコードに持たない）', async () => {
    const h = setupApp();
    await openStep5(h);
    await chooseReal(h);
    expect(text()).toContain('有効な代行チャネルの料率がありません');
    expect(text()).toContain('既存のマスタExcelから取り込む');
  }, 60000);

  it('既存のマスタExcelを取り込むと、対象年月の料率が表示される', async () => {
    const h = setupApp();
    await openStep5(h);
    await chooseReal(h);
    await importMasters(h);
    expect(text()).toContain('27.5%（0.275）');
    expect(text()).toContain('40 円');
  }, 60000);

  it('店舗担当者のロールではマスタを編集できない', async () => {
    const h = setupApp();
    await openStep5(h);
    fireEvent.change(document.querySelector('select')!, { target: { value: 'STAFF' } });
    await chooseReal(h);
    expect(text()).toContain('管理者に登録を依頼してください');
    expect(findButton('料率を変更')).toBeNull();
  }, 60000);

  it('写真の値・CSV から計算内訳を出し、検算①②が一致する', async () => {
    const h = setupApp();
    await openStep5(h);
    await chooseReal(h);
    await importMasters(h);
    await uploadCsv(h);
    await enterJournal(h);
    await waitBreakdown();

    const t = text();
    expect(t).toContain('1,164,465.105'); // 架空の値での期待リアル売上
    expect(t).toContain('59,901.895');
    const cards = [...document.querySelectorAll('.kpi')].map((k) => k.textContent ?? '');
    expect(cards.find((c) => c.includes('検算① 売掛合計'))).toContain('一致');
    expect(cards.find((c) => c.includes('検算② 商品別売上CSV'))).toContain('一致');
  }, 60000);

  it('RS-04 「写真と見比べて確認しました」を付けるまで確定できない', async () => {
    const h = setupApp();
    await openStep5(h);
    await chooseReal(h);
    await importMasters(h);
    await uploadCsv(h);
    await enterJournal(h);
    await waitBreakdown();
    expect(buttonByText('この内容で確定').disabled).toBe(true);
    const check = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('写真と見比べて'))!.querySelector('input')!;
    await h.user.click(check);
    await waitFor(() => expect(buttonByText('この内容で確定').disabled).toBe(false));
  }, 60000);

  it('検算が合わない値（総計1 の先頭桁の誤読）は警告が出る', async () => {
    const h = setupApp();
    await openStep5(h);
    await chooseReal(h);
    await importMasters(h);
    await uploadCsv(h);
    await enterJournal(h);
    await waitBreakdown();
    typeInto('総計1（税抜値割引前）', '234567');
    await waitFor(() => expect(text()).toContain('検算②が合いません'));
  }, 60000);

  it('営業月が対象年月と違えば確定できない（E016）', async () => {
    const h = setupApp();
    await openStep5(h);
    await chooseReal(h);
    await importMasters(h);
    await uploadCsv(h);
    await enterJournal(h);
    await waitBreakdown();
    typeInto('営業月', '2026-01');
    await waitFor(() => expect(text()).toContain('ジャーナルの営業月が対象年月と違います'));
    const check = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('写真と見比べて'))!.querySelector('input')!;
    await h.user.click(check);
    expect(buttonByText('この内容で確定').disabled).toBe(true);
  }, 60000);

  it('RS-07 未確定のまま分析へ進むと E017 で出力できない', async () => {
    const h = setupApp();
    await openStep5(h, true);
    await chooseReal(h);
    await goToStep(h, 6);
    await h.user.click(buttonByText('再計算'));
    await waitFor(() => expect(issuesOf('E017')).toHaveLength(1));
    expect(findButton('完成Excelをダウンロード')?.disabled).toBe(true);
  }, 60000);

  it('RS-06 確定すると分析の売上がリアル売上になり、出力Excelの C4 に丸めずに入る', async () => {
    const h = setupApp();
    await openStep5(h, true);
    await chooseReal(h);
    await importMasters(h);
    await uploadCsv(h);
    await enterJournal(h);
    await waitBreakdown();
    const check = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('写真と見比べて'))!.querySelector('input')!;
    await h.user.click(check);
    await h.user.click(buttonByText('この内容で確定'));
    await waitFor(() => expect(text()).toContain('リアル売上を確定しました'));
    // 確定すると再計算が走る。終わるまでボタンは「再計算中…」
    await waitFor(() => expect(findButton('次へ：分析・出力')?.disabled).toBe(false));

    await h.user.click(buttonByText('次へ：分析・出力'));
    await waitFor(() => expect(text()).toContain('STEP 6　分析・出力'));
    expect(text()).toContain('当月売上高（リアル売上）');
    // 目安は総計1基準で比べる（店舗回答）
    expect(text()).toContain('ロス引き後原価率（総計1基準）');

    const out = await downloadWorkbook(h);
    const wb = await XlsxWorkbook.load(out.data);
    expect(wb.cell('分析用', 'C4')?.value).toBe(Number(TEST_EXPECTED.realSales));
  }, 90000);

  it('確定後に読み取り値を変えると、確定は取り消される', async () => {
    const h = setupApp();
    await openStep5(h);
    await chooseReal(h);
    await importMasters(h);
    await uploadCsv(h);
    await enterJournal(h);
    await waitBreakdown();
    const check = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('写真と見比べて'))!.querySelector('input')!;
    await h.user.click(check);
    await h.user.click(buttonByText('この内容で確定'));
    await waitFor(() => expect(text()).toContain('リアル売上を確定しました'));

    typeInto('値割引合計', '1001');
    await waitFor(() => expect(text()).not.toContain('リアル売上を確定しました'));
    expect(findButton('この内容で確定')).not.toBeNull();
  }, 60000);

  it('CSV が使えないときは理由つきで出数を手入力できる', async () => {
    const h = setupApp();
    await openStep5(h);
    await chooseReal(h);
    await importMasters(h);
    await enterJournal(h);
    const box = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('容器対象出数を手入力する'))!.querySelector('input')!;
    await h.user.click(box);
    const fields = within(document.body);
    fireEvent.change(fields.getByLabelText('容器対象出数（個）'), { target: { value: String(TEST_EXPECTED.containerQty) } });
    await waitFor(() => expect(text()).toContain('理由の入力が必要です'));
    fireEvent.change(fields.getByLabelText('理由（必須）'), { target: { value: 'CSVの出力に失敗したため' } });
    await waitFor(() => expect(text()).toContain('1,164,465.105'));
  }, 60000);
});
