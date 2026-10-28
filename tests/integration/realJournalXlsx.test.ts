/**
 * 店舗オーナーの「リアル売上算出」Excel をそのまま取り込めること（L4・実ファイル）。
 *
 * 実ファイルはリポジトリに含めない。無ければスキップする。
 * 期待値は tests/fixtures/real/expected.json の realSales.september（gitignore 対象）。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournalUpload } from '@/domain/realSales/journalFile';
import { REAL_EXPECTED } from '../helpers/realExpected';

const XLSX = process.env['REAL_JOURNAL_XLSX'] ?? join('C:', 'Users', 'kimi4', 'Downloads', 'リアル売上算出_TO出数反映済.xlsx');
const EXP = REAL_EXPECTED?.realSales?.september;

describe.skipIf(!existsSync(XLSX) || !EXP)('オーナーのリアル売上算出Excel（実ファイル）', () => {
  it('営業年月・総計1・チャネル別売上を、文字列の照合だけで読む', async () => {
    const r = await readJournalUpload(new Uint8Array(readFileSync(XLSX)), 'リアル売上算出.xlsx');
    expect(r.issues).toEqual([]);
    expect(r.businessYm).toBe(EXP!.journal.businessYm);
    expect(r.grossTotal).toBe(EXP!.journal.grossTotal);
    expect(r.receivables).toEqual(EXP!.sheetChannels);
  });

  it('弁当容器の表（出数）と計算結果の行は読まない', async () => {
    const r = await readJournalUpload(new Uint8Array(readFileSync(XLSX)), 'リアル売上算出.xlsx');
    const labels = r.receivables.map((x) => x.label);
    expect(labels).not.toContain('TO');
    for (const w of ['計', '差引金額', 'リアル売上']) expect(labels).not.toContain(w);
  });
});
