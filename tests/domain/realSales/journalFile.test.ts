/**
 * ジャーナルの読み取り結果ファイルの取込（写真を使わない道）。
 * 値はすべて架空。前工程（店舗オーナー）が作るファイルなので、表記や書き方の揺れを受けられることを確かめる。
 */
import { describe, it, expect } from 'vitest';
import { readJournalFile } from '@/domain/realSales/journalFile';

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
