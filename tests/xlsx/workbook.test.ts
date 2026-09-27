import { describe, it, expect, beforeAll } from 'vitest';
import JSZip from 'jszip';
import { XlsxWorkbook, FormulaCellWriteError } from '@/xlsx/workbook';
import { colLetterToIndex, colIndexToLetter, parseRef, makeRef } from '@/xlsx/columns';
import { buildSyntheticWorkbook, SAMPLE_ROWS } from '../helpers/buildXlsx';

describe('列記号の変換', () => {
  it.each([
    ['A', 1],
    ['G', 7],
    ['Z', 26],
    ['AA', 27],
    ['BL', 64],
  ])('%s は %d 列目', (letter, index) => {
    expect(colLetterToIndex(letter)).toBe(index);
    expect(colIndexToLetter(index)).toBe(letter);
  });

  it('セル参照を分解できる', () => {
    expect(parseRef('G3')).toEqual({ col: 7, row: 3 });
    expect(parseRef('AA268')).toEqual({ col: 27, row: 268 });
  });

  it('セル参照を組み立てられる', () => {
    expect(makeRef(7, 3)).toBe('G3');
  });
});

describe('XlsxWorkbook 読み取り', () => {
  let wb: XlsxWorkbook;

  beforeAll(async () => {
    const data = await buildSyntheticWorkbook({ rows: SAMPLE_ROWS, totalSales: 5_000_000 });
    wb = await XlsxWorkbook.load(data);
  });

  it('シート名を実帳票と同じ順で返す', () => {
    expect(wb.sheetNames).toEqual(['注意事項', '入力用', '分析用']);
  });

  it('存在しないシートを問い合わせても例外を投げない', () => {
    expect(wb.hasSheet('存在しない')).toBe(false);
  });

  it('見出し行(2行目)の文字列を読める', () => {
    expect(wb.cell('入力用', 'D2')?.value).toBe('商品コード');
    expect(wb.cell('入力用', 'G2')?.value).toBe('期末在庫');
    expect(wb.cell('入力用', 'P2')?.value).toBe('仕入れ単位');
  });

  describe('商品コードを文字列として読む（先頭ゼロ保持）', () => {
    it('000140 を文字列のまま返す', () => {
      const cell = wb.cell('入力用', 'D3');
      expect(cell?.value).toBe('000140');
      expect(typeof cell?.value).toBe('string');
    });

    it('Aコードも文字列で返す', () => {
      expect(wb.cell('入力用', 'D8')?.value).toBe('A00043');
    });

    it('数値型で格納されている場合は数値として返す（呼び出し側で I001 を出せるように）', async () => {
      const data = await buildSyntheticWorkbook({ rows: SAMPLE_ROWS, codesAsNumbers: true });
      const numeric = await XlsxWorkbook.load(data);
      expect(typeof numeric.cell('入力用', 'D3')?.value).toBe('number');
      expect(numeric.cell('入力用', 'D3')?.value).toBe(140);
    });
  });

  it('数値セルを number で返す', () => {
    expect(wb.cell('入力用', 'G4')?.value).toBe(7);
    expect(wb.cell('入力用', 'K4')?.value).toBe(1194);
  });

  it('空セルは value が null', () => {
    expect(wb.cell('入力用', 'G3')?.value).toBe(0);
    expect(wb.cell('入力用', 'O3')?.value ?? null).toBeNull();
  });

  describe('数式セルの識別', () => {
    it('J列は数式セルと分かる', () => {
      const cell = wb.cell('入力用', 'J4');
      expect(cell?.hasFormula).toBe(true);
      expect(cell?.formula).toBe('SUM(H4:I4)-G4');
    });

    it('L列とM列も数式セル', () => {
      expect(wb.cell('入力用', 'L4')?.hasFormula).toBe(true);
      expect(wb.cell('入力用', 'M4')?.hasFormula).toBe(true);
    });

    it('入力セル(G/H/I)は数式セルではない', () => {
      expect(wb.cell('入力用', 'G4')?.hasFormula).toBe(false);
      expect(wb.cell('入力用', 'H4')?.hasFormula).toBe(false);
      expect(wb.cell('入力用', 'I4')?.hasFormula).toBe(false);
    });

    it('キャッシュされた計算結果も読める', () => {
      // 000158: H=76, I=5, G=7 → J=74
      expect(wb.cell('入力用', 'J4')?.value).toBe(74);
      expect(wb.cell('入力用', 'L4')?.value).toBe(88356);
    });
  });

  describe('分析用シート', () => {
    it('当月売上高 C4 を読める', () => {
      expect(wb.cell('分析用', 'C4')?.value).toBe(5_000_000);
    });

    it('合計 C22 は SUM(C5:D19) の数式', () => {
      expect(wb.cell('分析用', 'C22')?.formula).toBe('SUM(C5:D19)');
    });

    it('ロス引き後原価率 L11 は数式', () => {
      expect(wb.cell('分析用', 'L11')?.formula).toBe('K9/C4*100');
    });

    it('ロス額 K7 は空欄でも存在する', () => {
      expect(wb.cell('分析用', 'K7')).toBeDefined();
      expect(wb.cell('分析用', 'K7')?.value ?? null).toBeNull();
    });
  });

  it('データ行の範囲を返せる', () => {
    expect(wb.maxRow('入力用')).toBeGreaterThanOrEqual(SAMPLE_ROWS.length + 2);
  });

  it('シート全体のセルを列挙できる', () => {
    const cells = wb.cells('入力用');
    expect(cells.size).toBeGreaterThan(50);
    expect(cells.get('D3')?.value).toBe('000140');
  });
});

describe('XlsxWorkbook 書き戻し（ZIP直接パッチ）', () => {
  async function loadFresh(): Promise<XlsxWorkbook> {
    const data = await buildSyntheticWorkbook({ rows: SAMPLE_ROWS, totalSales: 5_000_000 });
    return XlsxWorkbook.load(data);
  }

  it('数値を書き込み、再読込で取得できる', async () => {
    const wb = await loadFresh();
    wb.setNumber('入力用', 'I3', 42);

    const out = await XlsxWorkbook.load(await wb.toUint8Array());
    expect(out.cell('入力用', 'I3')?.value).toBe(42);
  });

  it('既存の空セルにも書き込める', async () => {
    const wb = await loadFresh();
    wb.setNumber('入力用', 'G3', 5);

    const out = await XlsxWorkbook.load(await wb.toUint8Array());
    expect(out.cell('入力用', 'G3')?.value).toBe(5);
  });

  it('XMLに存在しないセルは新規に挿入する', async () => {
    const wb = await loadFresh();
    wb.setNumber('入力用', 'R3', 9);

    const out = await XlsxWorkbook.load(await wb.toUint8Array());
    expect(out.cell('入力用', 'R3')?.value).toBe(9);
  });

  it('挿入したセルは列順を保つ（Excelが読める並び）', async () => {
    const wb = await loadFresh();
    wb.setNumber('入力用', 'R3', 9);
    const zip = await JSZip.loadAsync(await wb.toUint8Array());
    const xml = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
    const row3 = /<row r="3"[^>]*>([\s\S]*?)<\/row>/.exec(xml)![1]!;
    const refs = [...row3.matchAll(/<c r="([A-Z]+)3"/g)].map((m) => m[1]!);
    const cols = refs.map(colLetterToIndex);

    expect(cols).toEqual([...cols].sort((a, b) => a - b));
  });

  it('小数をそのままの精度で書き込む', async () => {
    const wb = await loadFresh();
    wb.setNumber('入力用', 'K3', 253.56666667);

    const out = await XlsxWorkbook.load(await wb.toUint8Array());
    expect(out.cell('入力用', 'K3')?.value).toBe(253.56666667);
  });

  it('null を書くとセルを空にする', async () => {
    const wb = await loadFresh();
    wb.setNumber('入力用', 'G4', null);

    const out = await XlsxWorkbook.load(await wb.toUint8Array());
    expect(out.cell('入力用', 'G4')?.value ?? null).toBeNull();
  });

  describe('数式・書式の保持（受入条件8）', () => {
    it('書き戻し後も J/L/M 列の数式が残る', async () => {
      const wb = await loadFresh();
      wb.setNumber('入力用', 'I3', 42);
      wb.setNumber('入力用', 'H3', 10);

      const out = await XlsxWorkbook.load(await wb.toUint8Array());
      expect(out.cell('入力用', 'J3')?.formula).toBe('SUM(H3:I3)-G3');
      expect(out.cell('入力用', 'L3')?.formula).toBe('K3*J3');
      expect(out.cell('入力用', 'M3')?.formula).toBe('G3*K3');
    });

    it('分析用シートの数式も残る', async () => {
      const wb = await loadFresh();
      wb.setNumber('入力用', 'I3', 42);

      const out = await XlsxWorkbook.load(await wb.toUint8Array());
      expect(out.cell('分析用', 'C22')?.formula).toBe('SUM(C5:D19)');
      expect(out.cell('分析用', 'L11')?.formula).toBe('K9/C4*100');
    });

    it('触っていないシートはバイト単位で不変', async () => {
      const original = await buildSyntheticWorkbook({ rows: SAMPLE_ROWS, totalSales: 5_000_000 });
      const wb = await XlsxWorkbook.load(original);
      wb.setNumber('入力用', 'I3', 42);

      const before = await (await JSZip.loadAsync(original)).file('xl/worksheets/sheet1.xml')!.async('string');
      const after = await (await JSZip.loadAsync(await wb.toUint8Array())).file('xl/worksheets/sheet1.xml')!.async('string');

      expect(after).toBe(before);
    });

    it('セルのスタイル属性(s)を保持する', async () => {
      const wb = await loadFresh();
      wb.setNumber('入力用', 'G4', 99);

      const zip = await JSZip.loadAsync(await wb.toUint8Array());
      const xml = await zip.file('xl/worksheets/sheet2.xml')!.async('string');

      expect(xml).toMatch(/<c r="G4" s="0"><v>99<\/v><\/c>/);
    });
  });

  describe('数式セルの保護（E010）', () => {
    // メッセージ本文にコード（E010:）は入れない。画面ではカタログのコードを別に表示するため、
    // 埋め込むと二重表示になる。呼び出し側は例外の型で E010 と判別する。
    it('数式セルへの書き込みは FormulaCellWriteError を投げる', async () => {
      const wb = await loadFresh();
      expect(() => wb.setNumber('入力用', 'J4', 1)).toThrow(FormulaCellWriteError);
      expect(() => wb.setNumber('入力用', 'J4', 1)).toThrow(/数式セル/);
      expect(() => wb.setNumber('入力用', 'J4', 1)).not.toThrow(/E010/);
    });

    it('例外はシート名・セル・数式を持つ', async () => {
      const wb = await loadFresh();
      try {
        wb.setNumber('入力用', 'J4', 1);
        throw new Error('例外が投げられなかった');
      } catch (e) {
        expect(e).toBeInstanceOf(FormulaCellWriteError);
        const err = e as FormulaCellWriteError;
        expect(err.sheetName).toBe('入力用');
        expect(err.ref).toBe('J4');
        expect(err.formula).toBe('SUM(H4:I4)-G4');
      }
    });

    it('分析用の数式セルも保護する', async () => {
      const wb = await loadFresh();
      expect(() => wb.setNumber('分析用', 'C22', 1)).toThrow(FormulaCellWriteError);
    });

    it('再計算のために calcId を 0 にして fullCalcOnLoad を立てる', async () => {
      // calcId に Excel 自身のバージョン以上の値が残っていると
      // 「キャッシュ値は正しい」と判断され再計算が省略されることがある
      const wb = await loadFresh();
      wb.enableFullCalcOnLoad();
      const zip = await JSZip.loadAsync(await wb.toUint8Array());
      const workbookXml = await zip.file('xl/workbook.xml')!.async('string');

      expect(workbookXml).toContain('fullCalcOnLoad="1"');
      expect(workbookXml).toContain('calcId="0"');
      expect(workbookXml).not.toMatch(/calcId="[1-9]/);
    });

    it('数式のキャッシュ値を消し、依存関係キャッシュも捨てる', async () => {
      // キャッシュが残っていると、再計算しない環境で古い値がそのまま表示される
      // （分析用シートが 0 と #DIV/0! のまま出た事象）
      const wb = await loadFresh();
      wb.enableFullCalcOnLoad();
      const bytes = await wb.toUint8Array();
      const zip = await JSZip.loadAsync(bytes);

      expect(zip.file('xl/calcChain.xml')).toBeNull();
      for (const path of Object.keys(zip.files).filter((p) => /worksheets\/sheet\d+\.xml$/.test(p))) {
        const xml = await zip.file(path)!.async('string');
        // 数式のすぐ後にキャッシュ値が続くセルが残っていないこと
        expect(xml).not.toMatch(/<\/f><v>/);
        expect(xml).not.toMatch(/<f[^>]*\/><v>/);
      }
    });

    it('キャッシュ値を消しても数式と実データは残る', async () => {
      const wb = await loadFresh();
      wb.setNumber('入力用', 'G4', 9);
      wb.enableFullCalcOnLoad();
      const out = await XlsxWorkbook.load(await wb.toUint8Array());

      expect(out.cell('入力用', 'J4')?.formula).toBe('SUM(H4:I4)-G4');
      expect(out.cell('入力用', 'J4')?.value).toBeNull(); // 計算するまで値は無い
      expect(out.cell('入力用', 'G4')?.value).toBe(9); // 書き込んだ実データは残る
      expect(out.cell('入力用', 'D4')?.value).toBe('000158'); // 元の実データも残る
    });

    it('再計算させないときはキャッシュ値をそのまま残す', async () => {
      const wb = await loadFresh();
      const out = await XlsxWorkbook.load(await wb.toUint8Array());

      expect(out.cell('入力用', 'J4')?.formula).toBe('SUM(H4:I4)-G4');
      expect(out.cell('入力用', 'J4')?.value).not.toBeNull();
    });

    it('入力セルへの書き込みは通る', async () => {
      const wb = await loadFresh();
      expect(() => wb.setNumber('分析用', 'C4', 7000000)).not.toThrow();
      expect(() => wb.setNumber('分析用', 'K7', 5000)).not.toThrow();
    });
  });

  describe('開いたときの再計算（fullCalcOnLoad）', () => {
    it('有効化すると workbook.xml に calcPr が入る', async () => {
      const wb = await loadFresh();
      wb.enableFullCalcOnLoad();

      const zip = await JSZip.loadAsync(await wb.toUint8Array());
      const xml = await zip.file('xl/workbook.xml')!.async('string');

      expect(xml).toMatch(/fullCalcOnLoad="1"/);
    });

    it('二重適用しても属性は1つだけ', async () => {
      const wb = await loadFresh();
      wb.enableFullCalcOnLoad();
      wb.enableFullCalcOnLoad();

      const zip = await JSZip.loadAsync(await wb.toUint8Array());
      const xml = await zip.file('xl/workbook.xml')!.async('string');

      expect(xml.match(/fullCalcOnLoad/g)).toHaveLength(1);
    });
  });

  describe('シート追加（前月比較シート）', () => {
    it('同じ名前で2回追加すると内容を差し替える（ダウンロードを2回押せる）', async () => {
      // 画面の「完成Excelをダウンロード」は同じブックに対して何度でも押せる。
      // 2回目で「既に存在します」と失敗していた不具合の回帰テスト。
      const wb = await loadFresh();
      wb.addSheet('前月比較_レポート', [['1回目']]);
      expect(() => wb.addSheet('前月比較_レポート', [['2回目']])).not.toThrow();

      const out = await XlsxWorkbook.load(await wb.toUint8Array());
      expect(out.sheetNames.filter((n) => n === '前月比較_レポート')).toHaveLength(1);
      expect([...out.cells('前月比較_レポート').values()].map((c) => c.value)).toEqual(['2回目']);
    });

    it('元ファイルにあるシート名では追加できない', async () => {
      const wb = await loadFresh();
      expect(() => wb.addSheet('入力用', [['x']])).toThrow(/元ファイルに同じ名前のシート/);
    });

    it('新しいシートを末尾に追加できる', async () => {
      const wb = await loadFresh();
      wb.addSheet('前月比較_レポート', [['区分', '指標', '前月', '当月', '差', '単位']]);

      const out = await XlsxWorkbook.load(await wb.toUint8Array());
      expect(out.sheetNames).toEqual(['注意事項', '入力用', '分析用', '前月比較_レポート']);
    });

    it('追加したシートの値を読み戻せる', async () => {
      const wb = await loadFresh();
      wb.addSheet('前月比較_レポート', [
        ['区分', '指標', '前月', '当月'],
        ['全体', 'ロス引き後原価率', 41.0, 42.31],
      ]);

      const out = await XlsxWorkbook.load(await wb.toUint8Array());
      expect(out.cell('前月比較_レポート', 'A1')?.value).toBe('区分');
      expect(out.cell('前月比較_レポート', 'D2')?.value).toBe(42.31);
    });

    it('既存シートは影響を受けない', async () => {
      const wb = await loadFresh();
      wb.addSheet('前月比較_レポート', [['x']]);

      const out = await XlsxWorkbook.load(await wb.toUint8Array());
      expect(out.cell('入力用', 'D3')?.value).toBe('000140');
      expect(out.cell('分析用', 'C22')?.formula).toBe('SUM(C5:D19)');
    });

    it('複数シートを追加できる', async () => {
      const wb = await loadFresh();
      wb.addSheet('前月比較_商品別', [['商品コード']]);
      wb.addSheet('前月比較_レポート', [['区分']]);

      const out = await XlsxWorkbook.load(await wb.toUint8Array());
      expect(out.sheetNames).toContain('前月比較_商品別');
      expect(out.sheetNames).toContain('前月比較_レポート');
    });

    it('商品コードは文字列として書き込まれ先頭ゼロが保たれる', async () => {
      const wb = await loadFresh();
      wb.addSheet('前月比較_商品別', [['商品コード'], ['000140']]);

      const out = await XlsxWorkbook.load(await wb.toUint8Array());
      expect(out.cell('前月比較_商品別', 'A2')?.value).toBe('000140');
    });

    it('null セルは空欄として書かれる', async () => {
      const wb = await loadFresh();
      wb.addSheet('前月比較_商品別', [['a', null, 'c']]);

      const out = await XlsxWorkbook.load(await wb.toUint8Array());
      expect(out.cell('前月比較_商品別', 'B1')?.value ?? null).toBeNull();
      expect(out.cell('前月比較_商品別', 'C1')?.value).toBe('c');
    });

    it('XMLエスケープが必要な文字を含む値を壊さない', async () => {
      const wb = await loadFresh();
      wb.addSheet('前月比較_商品別', [['ＴＯ(レジ前) & <差> "pt"']]);

      const out = await XlsxWorkbook.load(await wb.toUint8Array());
      expect(out.cell('前月比較_商品別', 'A1')?.value).toBe('ＴＯ(レジ前) & <差> "pt"');
    });
  });

  it('生成したファイルは有効なZIPである', async () => {
    const wb = await loadFresh();
    wb.setNumber('入力用', 'I3', 1);
    const bytes = await wb.toUint8Array();

    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
    await expect(JSZip.loadAsync(bytes)).resolves.toBeDefined();
  });
});
