import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importMastersFromWorkbook } from '@/domain/realSales/masterImport';
import { buildSimpleWorkbook } from '../../helpers/buildXlsx';
import { REAL_EXPECTED } from '../../helpers/realExpected';

describe('既存の「リアル売上算出（マスタ）」から料率と容器単価を取り込む', () => {
  // 既存Excelと同じ並び。料率・単価は架空
  const cells = {
    A1: 'チャンネル', B1: '売上', C1: '手数料率', D1: '手数料額',
    A2: 'menu', C2: 0.2,
    A3: 'シェアデリ', C3: 0.275,
    A4: 'UE配達代行', C4: 0.33,
    A5: 'UE麵屋代行', C5: 0.33, // 既存Excelは「麵」
    A6: 'UEラ－メン代', C6: 0.33, // 既存Excelは全角マイナス・末尾欠け
    A7: 'ロケットナウ', C7: 0.15,
    C8: '計',
    A10: 'チャンネル', B10: '出数', C10: '控除額単価', D10: '控除額計',
    A11: 'TO', C11: 40,
  };

  it('6チャネルの料率と容器単価を読み、表記ゆれも既知のチャネルに対応づける', async () => {
    const m = await importMastersFromWorkbook(await buildSimpleWorkbook('Sheet1', cells));
    expect(m.channels.map((c) => [c.id, c.rate])).toEqual([
      ['menu', '0.2'],
      ['sharedeli', '0.275'],
      ['ue-delivery', '0.33'],
      ['ue-menya', '0.33'],
      ['ue-ramen', '0.33'],
      ['rocketnow', '0.15'],
    ]);
    expect(m.containerPrice).toBe('40');
    expect(m.unknownLabels).toEqual([]);
  });

  it('既知でないチャネルは取り込まず、表記を返す（人が確認する）', async () => {
    const m = await importMastersFromWorkbook(await buildSimpleWorkbook('Sheet1', { ...cells, A8: '新デリバリー', C8: 0.1 }));
    expect(m.unknownLabels).toEqual(['新デリバリー']);
  });

  it('適用開始年月を指定できる', async () => {
    const m = await importMastersFromWorkbook(await buildSimpleWorkbook('Sheet1', cells), '2026-11');
    expect(m.channels.every((c) => c.validFrom === '2026-11')).toBe(true);
  });
});

const REAL = join(process.env['REAL_SALES'] ?? join('C:', 'Users', 'kimi4', 'Downloads', 'リアル売上計算', 'リアル売上計算'), 'リアル売上算出（マスタ）.xlsx');
const EXP = REAL_EXPECTED?.realSales?.august;

describe.skipIf(!existsSync(REAL) || !EXP)('実際のマスタExcel（手元のみ）', () => {
  it('料率と容器単価が受入の前提値と一致する', async () => {
    const m = await importMastersFromWorkbook(new Uint8Array(readFileSync(REAL)));
    expect(m.unknownLabels).toEqual([]);
    expect(m.channels.map((c) => ({ id: c.id, rate: c.rate }))).toEqual(EXP!.rates);
    expect(m.containerPrice).toBe(EXP!.containerPrice);
  });
});
