/**
 * ジャーナルの読み取り結果ファイルの取込（写真を使わない道）。
 * 値はすべて架空。前工程（店舗オーナー）が作るファイルなので、表記や書き方の揺れを受けられることを確かめる。
 */
import { describe, it, expect } from 'vitest';
import { readJournalFile, readJournalUpload } from '@/domain/realSales/journalFile';
import { buildSimpleWorkbook } from '../../helpers/buildXlsx';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('CSV', () => {
  it('項目と金額の2列を読む（見出し行・円記号・カンマ・全角数字があってもよい）', () => {
    const r = readJournalFile(
      bytes(
        [
          '項目,金額',
          '営業月,2026/9',
          '店舗名,テスト店',
          '総計1（税抜値割引前）,"¥1,234,567"',
          '値割引合計,1000円',
          '値割引消費税,８０',
          '売掛合計,245694',
          'menu,2345',
          'シェアデリ,"30,003"',
        ].join('\n'),
      ),
      'journal.csv',
    );
    expect(r.issues).toEqual([]);
    expect(r.businessYm).toBe('2026-09');
    expect(r.storeName).toBe('テスト店');
    expect([r.grossTotal, r.discountTotal, r.discountTax, r.receivableTotal]).toEqual(['1234567', '1000', '80', '245694']);
    expect(r.receivables).toEqual([
      { label: 'menu', amount: '2345' },
      { label: 'シェアデリ', amount: '30003' },
    ]);
  });

  it('タブ区切りでも読み、3列目以降（回数など）は無視する', () => {
    const r = readJournalFile(bytes('総計1\t1234567\t備考\nmenu\t2345\t3回'), 'journal.tsv');
    expect(r.grossTotal).toBe('1234567');
    expect(r.receivables).toEqual([{ label: 'menu', amount: '2345' }]);
  });

  it('CP932 で保存されていても読める（Excel から出したファイル）', () => {
    // 「総計1,1234567」を CP932 で表したもの
    const cp932 = new Uint8Array([0x91, 0x8d, 0x8c, 0x76, 0x31, 0x2c, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37]);
    expect(readJournalFile(cp932, 'journal.csv').grossTotal).toBe('1234567');
  });
});

describe('JSON', () => {
  it('項目をそのままの名前で並べた JSON を読む', () => {
    const r = readJournalFile(
      bytes(
        JSON.stringify({
          営業月: '2026-09',
          店舗名: 'テスト店',
          総計1: 1234567,
          値割引合計: 1000,
          値割引消費税: 80,
          売掛合計: 245694,
          売掛内訳: [
            { 項目: 'menu', 金額: 2345 },
            { 項目: 'ナカペイ', 金額: 11111 },
          ],
        }),
      ),
      'journal.json',
    );
    expect(r.issues).toEqual([]);
    expect([r.businessYm, r.grossTotal, r.receivableTotal]).toEqual(['2026-09', '1234567', '245694']);
    expect(r.receivables).toEqual([
      { label: 'menu', amount: '2345' },
      { label: 'ナカペイ', amount: '11111' },
    ]);
  });

  it('英語のキーの内訳も読む', () => {
    const r = readJournalFile(bytes(JSON.stringify({ 総計1: 100, receivables: [{ label: 'menu', amount: '2,345' }] })), 'j.json');
    expect(r.receivables).toEqual([{ label: 'menu', amount: '2345' }]);
  });
});

describe('Excel（店舗オーナーの「リアル売上算出」シート）', () => {
  /** オーナーのシートと同じ作り。値はすべて架空 */
  const sheet = (overrides: Record<string, string | number> = {}): Promise<Uint8Array> =>
    buildSimpleWorkbook('Sheet1', {
      A1: 'リアル売上計算シート',
      A2: '営業年月', B2: 2026.09,
      A4: '総計１', B4: 1234567,
      A6: 'チャンネル', B6: '売上', C6: '手数料率', D6: '手数料額',
      A7: 'menu', B7: 2345, C7: 0.2,
      A8: 'シェアデリ', B8: 30003, C8: 0.275,
      A9: 'UEラ－メン代', B9: 1001, C9: 0.33,
      C10: '計', D10: 9999,
      A12: '弁当容器個数計算',
      A13: '営業年月', B13: 2026.09,
      A15: 'チャンネル', B15: '出数', C15: '控除額単価', D15: '控除額計',
      A16: 'TO', B16: 255, C16: 40, D16: 10200,
      C18: '差引金額', D18: 99999,
      C20: 'リアル売上', D20: 1164465, E20: '←分析表売上',
      ...overrides,
    });

  it('営業年月・総計1・チャネル別売上を読む（位置ではなく文字列で照合する）', async () => {
    const r = await readJournalUpload(await sheet(), 'リアル売上算出.xlsx');
    expect(r.issues).toEqual([]);
    expect(r.businessYm).toBe('2026-09');
    expect(r.grossTotal).toBe('1234567');
    expect(r.receivables).toEqual([
      { label: 'menu', amount: '2345' },
      { label: 'シェアデリ', amount: '30003' },
      { label: 'UEラ－メン代', amount: '1001' },
    ]);
  });

  it('弁当容器の表（出数）と、計・差引金額・リアル売上の行は読まない', async () => {
    const r = await readJournalUpload(await sheet(), 'リアル売上算出.xlsx');
    const labels = r.receivables.map((x) => x.label);
    expect(labels).not.toContain('TO');
    expect(labels).not.toContain('計');
    expect(labels).not.toContain('差引金額');
    expect(labels).not.toContain('リアル売上');
  });

  it('表が別の位置・別の列順でも読める（列は見出しの文字で決める）', async () => {
    const moved = await buildSimpleWorkbook('Sheet1', {
      D3: '総計１', E3: 1234567,
      D5: '営業年月', E5: '2026/9',
      C8: 'チャンネル', D8: '手数料率', E8: '売上',
      C9: 'menu', D9: 0.2, E9: 2345,
      C10: 'シェアデリ', D10: 0.275, E10: 30003,
    });
    const r = await readJournalUpload(moved, 'ずれたシート.xlsx');
    expect(r.grossTotal).toBe('1234567');
    expect(r.businessYm).toBe('2026-09');
    expect(r.receivables).toEqual([
      { label: 'menu', amount: '2345' },
      { label: 'シェアデリ', amount: '30003' },
    ]);
  });

  it('売掛合計・値割引がシートにあれば読む', async () => {
    const r = await readJournalUpload(await sheet({ A22: '値割引合計', B22: 1000, A23: '値割引消費税', B23: 80, A24: '売掛合計', B24: 245694 }), 's.xlsx');
    expect([r.discountTotal, r.discountTax, r.receivableTotal]).toEqual(['1000', '80', '245694']);
  });

  it('項目が1つも取れない Excel はエラー', async () => {
    const other = await buildSimpleWorkbook('Sheet1', { A1: '商品別売上', A2: '大分類', B2: '中分類' });
    const r = await readJournalUpload(other, 'ちがう.xlsx');
    expect(r.issues.map((i) => i.code)).toEqual(['E022']);
  });
});

describe('読めないファイル', () => {
  it('空ならエラー', () => {
    expect(readJournalFile(bytes('   '), 'j.csv').issues.map((i) => i.code)).toEqual(['E022']);
  });

  it('壊れた JSON はエラー', () => {
    expect(readJournalFile(bytes('{"総計1": '), 'j.json').issues.map((i) => i.code)).toEqual(['E022']);
  });

  it('項目が1つも取れなければエラー（別のCSVを入れたときなど）', () => {
    const r = readJournalFile(bytes('大分類,中分類\nカレー,テイクアウト_カレー'), 'wrong.csv');
    expect(r.issues.map((i) => i.code)).toEqual(['E022']);
    expect(r.issues[0]!.message).toContain('項目,金額');
  });
});
