// @vitest-environment happy-dom
/**
 * 画面テスト M-23・M-24（完成Excelの出力）。
 * 手順: docs/06_画面テスト手順書.md §8
 *
 * 手順書では「ダウンロードしたファイルを Excel で開いて確かめる」としているが、
 * ここでは画面が実際に出力したバイト列をそのまま読み直して検証する。
 * Excel で開けるかどうかは ZIP 構造と数式の残存で判定できるため、
 * 手で開くより確実で、毎回同じ観点を漏れなく見られる。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import JSZip from 'jszip';
import { XlsxWorkbook } from '@/xlsx/workbook';
import { PRODUCT_SHEET_NAME, REPORT_SHEET_NAME } from '@/export/comparisonSheets';
import { buildNormalSet, PREV_ROWS, CURRENT_ROWS, TOTAL_SALES } from '../helpers/testdataSet';
import {
  setupApp,
  importNormalSet,
  advanceToAnalyze,
  downloadWorkbook,
  buttonByText,
} from '../helpers/uiHarness';

let set: Awaited<ReturnType<typeof buildNormalSet>>;
beforeAll(async () => {
  set = await buildNormalSet();
});
afterEach(() => cleanup());

/** 入力用シートの行番号（見出し行2、データ行3〜） */
const rowOf = (code: string): number => 3 + CURRENT_ROWS.findIndex((r) => r.code === code);
const prevClosing = (code: string): number =>
  PREV_ROWS.find((r) => r.code === code)?.closingQty ?? 0;

async function exportAndOpen(): Promise<{ fileName: string; wb: XlsxWorkbook; bytes: Uint8Array }> {
  const h = setupApp();
  await importNormalSet(h, set);
  await advanceToAnalyze(h);
  const out = await downloadWorkbook(h);
  return { fileName: out.fileName, wb: await XlsxWorkbook.load(out.data), bytes: out.data };
}

describe('M-23 出力した完成Excelが開ける（J-15）', () => {
  it('ダウンロードが発生し、対象年月入りのファイル名になる', async () => {
    const { fileName } = await exportAndOpen();
    expect(fileName).toContain('2026');
    expect(fileName.endsWith('.xlsx')).toBe(true);
  }, 60000);

  it('ZIPとして壊れておらず、必要なパーツが揃っている（Excelが修復を求めない）', async () => {
    const { bytes } = await exportAndOpen();
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);

    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('xl/workbook.xml');
    expect(names.some((n) => n.startsWith('xl/worksheets/'))).toBe(true);
  }, 60000);

  it('元のシートが残り、比較シートが追加されている', async () => {
    const { wb } = await exportAndOpen();
    expect(wb.sheetNames).toContain('注意事項');
    expect(wb.sheetNames).toContain('入力用');
    expect(wb.sheetNames).toContain('分析用');
    expect(wb.sheetNames).toContain(PRODUCT_SHEET_NAME);
    expect(wb.sheetNames).toContain(REPORT_SHEET_NAME);
  }, 60000);

  it('入力用の J・L・M 列が数式のまま残る', async () => {
    const { wb } = await exportAndOpen();
    const row = rowOf('000158');

    expect(wb.cell('入力用', `J${row}`)?.formula).toBe(`SUM(H${row}:I${row})-G${row}`);
    expect(wb.cell('入力用', `L${row}`)?.formula).toBe(`K${row}*J${row}`);
    expect(wb.cell('入力用', `M${row}`)?.formula).toBe(`G${row}*K${row}`);
  }, 60000);

  it('分析用の集計セルも数式のまま残る', async () => {
    const { wb } = await exportAndOpen();
    expect(wb.cell('分析用', 'C22')?.formula).toBe('SUM(C5:D19)');
    expect(wb.cell('分析用', 'L11')?.formula).toBe('K9/C4*100');
    expect(wb.cell('分析用', 'L14')?.formula).toBe('C13');
  }, 60000);

  it('開いた瞬間に再計算されるよう fullCalcOnLoad が立つ', async () => {
    const { bytes } = await exportAndOpen();
    const zip = await JSZip.loadAsync(bytes);
    const workbookXml = await zip.file('xl/workbook.xml')!.async('string');

    expect(workbookXml).toContain('fullCalcOnLoad="1"');
  }, 60000);

  it('触っていないシートの内容が残っている', async () => {
    const { wb } = await exportAndOpen();
    expect(wb.cells('注意事項').size).toBeGreaterThan(0);
  }, 60000);
});

describe('M-24 書き戻した値が正しい（J-15）', () => {
  it('I列（期首在庫）が前月の期末在庫と一致する', async () => {
    const { wb } = await exportAndOpen();

    for (const code of ['000140', '000158', '000155', '006747', '001868', 'A00043']) {
      const row = rowOf(code);
      expect(wb.cell('入力用', `I${row}`)?.value).toBe(prevClosing(code));
    }
  }, 60000);

  it('新規商品の期首在庫は0になる', async () => {
    const { wb } = await exportAndOpen();
    expect(wb.cell('入力用', `I${rowOf('002100')}`)?.value).toBe(0);
    expect(wb.cell('入力用', `I${rowOf('002101')}`)?.value).toBe(0);
  }, 60000);

  it('H列（期中仕入）が 発注数 × 計算単位 と一致する', async () => {
    const { wb } = await exportAndOpen();

    // 000140: 発注4 × 計算単位1 = 4
    expect(wb.cell('入力用', `H${rowOf('000140')}`)?.value).toBe(4);
    // 000158: 発注60 × 計算単位1 = 60
    expect(wb.cell('入力用', `H${rowOf('000158')}`)?.value).toBe(60);
    // 001868: 発注6 × 計算単位40 = 240
    expect(wb.cell('入力用', `H${rowOf('001868')}`)?.value).toBe(240);
    // 002100: 単位計算マスタに無く、当月マスタの係数3で換算 → 発注3 × 3 = 9
    expect(wb.cell('入力用', `H${rowOf('002100')}`)?.value).toBe(9);
  }, 60000);

  it('発注が無い商品の期中仕入は0のまま', async () => {
    const { wb } = await exportAndOpen();
    expect(wb.cell('入力用', `H${rowOf('000155')}`)?.value).toBe(0);
    expect(wb.cell('入力用', `H${rowOf('006747')}`)?.value).toBe(0);
  }, 60000);

  it('G列（期末在庫）は当月マスタの入力値のまま', async () => {
    const { wb } = await exportAndOpen();

    for (const row of CURRENT_ROWS) {
      expect(wb.cell('入力用', `G${rowOf(row.code)}`)?.value).toBe(row.closingQty);
    }
  }, 60000);

  it('分析用の当月売上高が書き戻される', async () => {
    const { wb } = await exportAndOpen();
    expect(wb.cell('分析用', 'C4')?.value).toBe(TOTAL_SALES);
  }, 60000);

  it('比較シートの商品コードが文字列として書かれる（先頭ゼロが消えない）', async () => {
    const { wb } = await exportAndOpen();
    const cells = [...wb.cells(PRODUCT_SHEET_NAME).values()];
    const codeCell = cells.find((c) => c.value === '000140');

    expect(codeCell).toBeDefined();
    expect(typeof codeCell!.value).toBe('string');
  }, 60000);
});

describe('出力後の画面', () => {
  it('ダウンロードしたファイル名が画面に表示される', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);
    const out = await downloadWorkbook(h);

    expect(document.body.textContent).toContain(out.fileName);
  }, 60000);

  it('続けてもう一度ダウンロードできる', async () => {
    // 出力用のブックは画面上で使い回すため、2回目で比較シートの追加が衝突して
    // 失敗していた（2026-09-27 修正）。同じ操作を繰り返せることを担保する。
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);

    const first = await downloadWorkbook(h);
    const second = await downloadWorkbook(h);

    // ファイル名は出力時刻を含むため一致するとは限らない。中身が作れていることを見る
    expect(second.fileName).toMatch(/^食品棚卸表_202609_r1_\d{14}\.xlsx$/);
    expect(second.data.length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('出力できませんでした');
    expect(buttonByText('完成Excelをダウンロード').disabled).toBe(false);

    // 2回目も同じ内容（比較シートが重複していない）
    const wb = await XlsxWorkbook.load(second.data);
    expect(wb.sheetNames.filter((n) => n === PRODUCT_SHEET_NAME)).toHaveLength(1);
    expect(wb.sheetNames).toHaveLength(
      (await XlsxWorkbook.load(first.data)).sheetNames.length,
    );
  }, 60000);
});
