import { describe, it, expect } from 'vitest';
import { computeRealSales, expectedGrossFromCsv, type JournalEntry, type RealSalesInput } from '@/domain/realSales/compute';
import { toDecimalString } from '@/domain/realSales/fixed';
import { DEFAULT_MASTERS, type RealSalesMasters } from '@/domain/realSales/masters';
import { extractContainerQty, readProductSalesCsv } from '@/domain/realSales/productSalesCsv';
import { buildProductSalesCsv, TEST_EXPECTED, TEST_JOURNAL, TEST_SALES_ROWS, testMasters } from '../../helpers/realSalesData';

function input(over: Partial<RealSalesInput> = {}, journal: Partial<JournalEntry> = {}): RealSalesInput {
  const masters = over.masters ?? testMasters();
  const file = readProductSalesCsv(buildProductSalesCsv(), 'sales.csv');
  return {
    targetYm: '2026-08',
    journal: { ...TEST_JOURNAL, ...journal },
    container: {
      source: 'csv',
      extraction: extractContainerQty(file, masters.extractRules[0]!),
      csvAmountTotal: file.amountTotal,
      fileName: 'sales.csv',
    },
    masters,
    ...over,
  };
}
const codes = (r: ReturnType<typeof computeRealSales>): string[] => r.issues.map((i) => i.code).sort();

describe('リアル売上の各段階（要件§11.13-3 の照合方式。値は架空）', () => {
  const r = computeRealSales(input());
  const b = r.breakdown!;

  it('容器対象出数と容器代', () => {
    expect(b.containerQty).toBe(TEST_EXPECTED.containerQty);
    expect(toDecimalString(b.containerCost)).toBe(TEST_EXPECTED.containerCost);
  });

  it('手数料合計とリアル売上を丸めずに出す', () => {
    expect(toDecimalString(b.feeTotal)).toBe(TEST_EXPECTED.feeTotal);
    expect(toDecimalString(b.realSales)).toBe(TEST_EXPECTED.realSales);
  });

  it('チャネル別の手数料も丸めない', () => {
    expect(Object.fromEntries(b.channels.map((c) => [c.name, toDecimalString(c.fee)]))).toEqual(TEST_EXPECTED.fees);
  });

  it('写真の表記「UEらーめん代」が UEラーメン代行 に対応する', () => {
    expect(b.channels.find((c) => c.channelId === 'ue-ramen')!.label).toBe('UEらーめん代');
  });

  it('ナカペイ・モバイル・C は手数料の対象外（既存Excelに入っていない）', () => {
    expect(b.ignoredLabels).toEqual(['ナカペイ', 'モバイル・C']);
  });

  it('検算①（売掛合計）と②（CSV）がどちらも成立し、指摘は出ない', () => {
    expect(b.checks.receivables.status).toBe('ok');
    expect(b.checks.csv.status).toBe('ok');
    expect(r.issues).toEqual([]);
  });
});

describe('検算で読み取りの誤りを見つける（要件§11.3）', () => {
  it('総計1 の先頭桁の誤読は検算②で W028', () => {
    const r = computeRealSales(input({}, { grossTotal: '234567' }));
    expect(codes(r)).toEqual(['W028']);
    expect(r.breakdown!.checks.csv.status).toBe('ng');
  });

  it('売掛欄の1項目の誤読は検算①で W028', () => {
    const receivables = TEST_JOURNAL.receivables.map((l) => (l.label === 'ナカペイ' ? { ...l, amount: '91111' } : l));
    const r = computeRealSales(input({}, { receivables }));
    expect(codes(r)).toEqual(['W028']);
    expect(r.breakdown!.checks.receivables.status).toBe('ng');
  });

  it('CSV から総計1 のあるべき値を逆算できる（OCR の補正候補）', () => {
    expect(expectedGrossFromCsv(TEST_EXPECTED.csvAmountTotal, '1000', '80')).toBe('1234567');
  });

  it('値割引が未入力なら厳密な検算②はせず、1%以内なら止めない', () => {
    const r = computeRealSales(input({}, { discountTotal: null, discountTax: null }));
    expect(r.breakdown!.checks.csv.status).toBe('skipped');
    expect(codes(r)).toEqual([]);
  });
});

describe('RS-07 誤った値で確定させない', () => {
  it('営業月が対象年月と違えば E016', () => {
    expect(codes(computeRealSales(input({}, { businessYm: '2026-07' })))).toContain('E016');
  });

  it('総計1 が無ければ E020 で、計算結果を出さない', () => {
    const r = computeRealSales(input({}, { grossTotal: null }));
    expect(codes(r)).toContain('E020');
    expect(r.breakdown).toBeNull();
  });

  it('同じチャネルが2行あれば E021（手数料の二重計上）', () => {
    const receivables = [...TEST_JOURNAL.receivables, { label: 'UE麵屋代行', amount: '1000' }];
    expect(codes(computeRealSales(input({}, { receivables })))).toContain('E021');
  });

  it('料率も容器単価も未登録の初期状態では E019（コードに料率を持たない）', () => {
    const r = computeRealSales(input({ masters: DEFAULT_MASTERS }));
    expect(codes(r).filter((c) => c === 'E019')).toHaveLength(2);
    expect(r.breakdown).toBeNull();
  });

  it('対象年月に有効な容器単価が無ければ E019', () => {
    const m = testMasters();
    m.containerPrices = [{ price: '40', validFrom: '2026-09', validTo: null }];
    expect(codes(computeRealSales(input({ masters: m })))).toContain('E019');
  });

  it('CSV の必須列が無ければ E018', () => {
    const file = readProductSalesCsv(buildProductSalesCsv(TEST_SALES_ROWS, '大分類,中分類,小分類,商品コード,商品名,価格'), 'bad.csv');
    expect(file.issues.map((i) => i.code)).toEqual(['E018']);
  });
});

describe('売掛欄の項目の扱い（要件§11.5）', () => {
  it('どこにも登録の無い項目は W026。手数料には含めない', () => {
    const receivables = [...TEST_JOURNAL.receivables, { label: '新デリバリー', amount: '5000' }];
    const r = computeRealSales(input({}, { receivables, receivableTotal: '250694' }));
    expect(codes(r)).toEqual(['W026']);
    expect(toDecimalString(r.breakdown!.feeTotal)).toBe(TEST_EXPECTED.feeTotal);
  });

  it('登録済みのチャネルが写真に無ければ W027（0円扱いを人が確認する）', () => {
    const receivables = TEST_JOURNAL.receivables.filter((l) => l.label !== 'menu');
    const r = computeRealSales(input({}, { receivables, receivableTotal: '243349' }));
    expect(codes(r)).toEqual(['W027']);
    expect(r.issues[0]!.message).toContain('menu');
  });
});

describe('RS-05 料率・容器単価の変更は指定月以降だけに効く', () => {
  const withChange = (): RealSalesMasters => {
    const m = testMasters();
    m.channels.push({ ...m.channels.find((c) => c.id === 'rocketnow')!, rate: '0.5', validFrom: '2026-09' });
    m.containerPrices.push({ price: '60', validFrom: '2026-09', validTo: null });
    return m;
  };

  it('8月は旧料率・旧単価のまま（確定版が変わらない）', () => {
    const b = computeRealSales(input({ masters: withChange() })).breakdown!;
    expect(toDecimalString(b.realSales)).toBe(TEST_EXPECTED.realSales);
  });

  it('9月は新料率・新単価で計算する', () => {
    const b = computeRealSales(input({ masters: withChange(), targetYm: '2026-09' }, { businessYm: '2026-09' })).breakdown!;
    expect(b.channels.find((c) => c.channelId === 'rocketnow')!.rateText).toBe('0.5');
    expect(toDecimalString(b.containerPrice)).toBe('60');
  });
});

describe('出数の手入力（確定-06）', () => {
  it('理由があれば採用し I007 で記録する', () => {
    const r = computeRealSales(input({ container: { source: 'manual', qty: 255, reason: 'CSVの出力に失敗したため' } }));
    expect(codes(r)).toContain('I007');
    expect(toDecimalString(r.breakdown!.realSales)).toBe(TEST_EXPECTED.realSales);
  });

  it('理由が空なら採用しない（E018）', () => {
    const r = computeRealSales(input({ container: { source: 'manual', qty: 255, reason: ' ' } }));
    expect(codes(r)).toContain('E018');
    expect(r.breakdown).toBeNull();
  });
});

describe('前月からの大幅変動（W031）', () => {
  it('リアル売上が前月から20%以上動けば警告', () => {
    const r = computeRealSales(input({ previous: { targetYm: '2026-07', realSales: '800000', feeTotal: '59901', containerQty: 255 } }));
    expect(codes(r)).toEqual(['W031']);
  });
});
