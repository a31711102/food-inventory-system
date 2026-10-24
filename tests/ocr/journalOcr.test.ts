/**
 * ジャーナル読み取りの、OCR を使わない部分（照合・多数決後の検算・補正）。
 * 値はすべて架空。実写真での検証は tests/integration/realJournalOcr.test.ts。
 */
import { describe, it, expect } from 'vitest';
import {
  closeDigits,
  labelScore,
  mapFields,
  normalizeAmount,
  solveGross,
  solveReceivables,
  type Candidate,
  type FieldReading,
  type LabelGroup,
  type OcrRow,
} from '@/ocr/journalOcr';

const field = (...cands: [string, number][]): FieldReading => ({
  value: cands[0]?.[0] ?? null,
  candidates: cands.map(([value, votes]) => ({ value, votes })),
  row: null,
  source: 'ocr',
});

describe('金額の読みの正規化', () => {
  it('円記号・カンマ・閉じ括弧を外す', () => {
    expect(normalizeAmount('¥12,345)')).toBe('12345');
    expect(normalizeAmount('¥0')).toBe('0');
  });

  it('回数の欄が混じっても、最後の金額だけを取る', () => {
    expect(normalizeAmount('12 ¥1,234,567')).toBe('1234567');
    expect(normalizeAmount('12¥1,234,567')).toBe('1234567');
  });

  it('先頭の0（円記号の直後の6を0と読む誤読）も捨てずに残す（検算②の手がかり）', () => {
    expect(normalizeAmount('¥0,234,567')).toBe('0234567');
  });

  it('数字が無ければ null', () => {
    expect(normalizeAmount('ー ー')).toBeNull();
  });
});

describe('1〜2桁の違いの判定', () => {
  it('1桁・2桁の違いは近い、3桁は遠い', () => {
    expect(closeDigits('21111', '51111')).toBe(true);
    expect(closeDigits('1234500', '1234567')).toBe(true);
    expect(closeDigits('11111', '99911')).toBe(false);
  });

  it('先頭に1桁増えた・減っただけも近い', () => {
    expect(closeDigits('41234', '1234')).toBe(true); // 円記号を4と読んで1桁増えた
    expect(closeDigits('234567', '1234567')).toBe(true); // 先頭の1桁を読み落とした
    expect(closeDigits('234568', '1234567')).toBe(false); // 読み落としに加えて別の桁も違う
  });
});

describe('表記の照合', () => {
  it('OCR の余計な記号・空白があっても照合できる', () => {
    expect(labelScore('(UE 配達 代行', 'UE配達代行')).toBe(1);
    expect(labelScore('(UE らーめん 代', 'UEらーめん代')).toBe(1);
  });

  it('半角カナは全角に直してから比べる', () => {
    expect(labelScore('(ﾓﾊﾞｲﾙ・C', 'モバイル・C')).toBe(1);
  });
});

describe('検算①（売掛合計）で内訳の誤読を正す', () => {
  it('上位候補の組み合わせで合計が合えば、その組み合わせを採る', () => {
    const items = [field(['1000', 4], ['1007', 2]), field(['2000', 6])];
    const total = field(['3000', 6]);
    solveReceivables(items, total);
    expect(items.map((i) => [i.value, i.source])).toEqual([['1000', 'checked'], ['2000', 'checked']]);
    expect(total.source).toBe('checked');
  });

  it('1項目だけの誤読は、合計から逆算し、読みが割れていた項目を直す', () => {
    // 差は 30,000。どの5桁の項目でも1桁変えれば合うが、読みが割れていたのは先頭の項目だけ
    const items = [field(['21111', 3], ['21171', 2], ['1111', 1]), field(['12345', 6]), field(['45678', 6])];
    const total = field(['109134', 6]);
    solveReceivables(items, total);
    expect(items[0]!.value).toBe('51111');
    expect(items[0]!.source).toBe('corrected');
    expect(items[0]!.note).toContain('21,111 を 51,111');
    expect(items[1]!.source).toBe('checked');
  });

  it('どの項目を直すべきか決められなければ、何も変えない（人に委ねる）', () => {
    const items = [field(['21111', 6]), field(['12345', 6])];
    const total = field(['63456', 6]);
    solveReceivables(items, total);
    expect(items.map((i) => i.source)).toEqual(['ocr', 'ocr']);
  });
});

describe('検算②（商品別売上CSV）で総計1 の誤読を正す', () => {
  it('円記号の直後の数字を0と読んだ総計1 を、CSV から逆算した値に補正する', () => {
    const gross = field(['0234567', 4], ['234567', 1]);
    const disc = field(['1000', 5], ['1007', 1]);
    const tax = field(['80', 6]);
    solveGross(gross, disc, tax, 1233647);
    expect(gross.value).toBe('1234567');
    expect(gross.source).toBe('corrected');
    expect(gross.candidates.find((c: Candidate) => c.value === '1234567')!.derived).toBe(true);
    expect(disc.source).toBe('checked');
  });

  it('CSV が無ければ何もしない', () => {
    const gross = field(['0234567', 4]);
    solveGross(gross, field(['1000', 5]), field(['80', 6]), null);
    expect(gross.source).toBe('ocr');
  });

  it('近い値が無ければ補正しない（別の月の CSV など）', () => {
    const gross = field(['1234567', 6]);
    solveGross(gross, field(['1000', 5]), field(['80', 6]), 9999999);
    expect(gross.source).toBe('ocr');
  });
});

describe('行から項目への割り当て', () => {
  const row = (index: number, labelJpn: string, value: string, labelEng = ''): OcrRow => ({
    index,
    rect: { left: 0, top: index * 10, width: 100, height: 10 },
    labelJpn,
    labelEng,
    candidates: [{ value, votes: 6 }],
  });
  const groups: LabelGroup[] = [
    { id: 'menu', labels: ['menu'] },
    { id: 'sharedeli', labels: ['シェアデリ'] },
    { id: 'rocketnow', labels: ['ロケットナウ'] },
    { id: 'ignored:mobile', labels: ['モバイル・C'] },
  ];

  it('表記が崩れていても、サービス料の行から上段の位置を決め、内訳は括弧つきの行のかたまりから決める', () => {
    const rows = [
      row(0, '半 ] ( 紀 抜 値', '1234567'), // 総計1（表記は崩れている）
      row(1, '仁 制 員 合', '1000'), // 値割引合計
      row(2, '/ 寺 |', '80'), // (値割引消費税)
      row(3, '過半 税', '99999'), // 消費税
      row(4, 'サー ビス 料', '0'),
      row(5, '売 持', '20000'), // 売掛（崩れている）
      row(6, '(8rU', '2000', '(menu'),
      row(7, '(シェ アデ リ', '3000'),
      row(8, '( 郡 人 カ ・C', '4000'), // モバイル・C（崩れている）
      row(9, '(ロケ ッ ト ナ ウ', '11000'),
      row(10, '合計', '99999999'),
    ];
    const f = mapFields(rows, { receivableGroups: groups });
    expect([f.grossTotal.value, f.discountTotal.value, f.discountTax.value, f.receivableTotal.value]).toEqual(['1234567', '1000', '80', '20000']);
    expect(f.receivables.map((r) => [r.label, r.value, r.labelBy])).toEqual([
      ['menu', '2000', 'exact'],
      ['シェアデリ', '3000', 'exact'],
      ['モバイル・C', '4000', 'elimination'],
      ['ロケットナウ', '11000', 'exact'],
    ]);
    expect(f.receivables[2]!.note).toContain('消去法');
  });
});
