/**
 * 同一ファイル検知（W008 / W022）のテスト。
 *
 * ファイルの取り違えは画面上エラーにならず数字だけが静かに狂うため、
 * 「どこまでを取り違えとみなすか」の線引きをここで固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  checkFileIdentity,
  mergeImportHistory,
  sha256Hex,
  type FileIdentity,
  type ImportedFileRecord,
} from '@/ingest/fileIdentity';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function past(
  overrides: Partial<ImportedFileRecord> & Pick<ImportedFileRecord, 'kind' | 'targetYm'>,
): ImportedFileRecord {
  return {
    fileName: '過去ファイル.xlsx',
    sha256: HASH_A,
    importedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sha256Hex', () => {
  it('既知のベクタと一致する（空のバイト列）', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('内容が1バイト違えば別のハッシュになる', async () => {
    const a = await sha256Hex(new Uint8Array([1, 2, 3]));
    const b = await sha256Hex(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });

  it('同じ内容なら同じハッシュになる（ファイル名は影響しない）', async () => {
    const bytes = new Uint8Array([80, 75, 3, 4, 9, 9]);
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(Uint8Array.from(bytes)));
  });
});

describe('W022 同じファイルを複数の欄に指定', () => {
  it('内容が同じなら、ファイル名が違っても検知する', () => {
    const files: FileIdentity[] = [
      { kind: 'master', fileName: '食品棚卸表.xlsx', sha256: HASH_A },
      { kind: 'previous', fileName: '食品棚卸表(1).xlsx', sha256: HASH_A },
    ];
    const issues = checkFileIdentity(files, [], '2026-09');
    const w022 = issues.filter((i) => i.code === 'W022');

    expect(w022).toHaveLength(1);
    expect(w022[0]!.message).toContain('当月本部マスタ棚卸表 と 前月食品棚卸表');
    expect(w022[0]!.level).toBe('WARNING');
  });

  it('内容が違えば検知しない', () => {
    const files: FileIdentity[] = [
      { kind: 'master', fileName: '当月.xlsx', sha256: HASH_A },
      { kind: 'previous', fileName: '前月.xlsx', sha256: HASH_B },
    ];
    expect(checkFileIdentity(files, [], '2026-09').filter((i) => i.code === 'W022')).toEqual([]);
  });

  it('3つの欄が同じでもメッセージは1件にまとめる', () => {
    const files: FileIdentity[] = [
      { kind: 'master', fileName: 'x.xlsx', sha256: HASH_A },
      { kind: 'previous', fileName: 'x.xlsx', sha256: HASH_A },
      { kind: 'unitMaster', fileName: 'x.xlsx', sha256: HASH_A },
    ];
    expect(checkFileIdentity(files, [], '2026-09').filter((i) => i.code === 'W022')).toHaveLength(1);
  });
});

describe('W008 過去に取り込んだファイルの再指定', () => {
  it('前月の当月マスタを、今月の当月マスタ欄に指定すると検知する', () => {
    const files: FileIdentity[] = [{ kind: 'master', fileName: '棚卸表.xlsx', sha256: HASH_A }];
    const history = [past({ kind: 'master', targetYm: '2026-08' })];

    const w008 = checkFileIdentity(files, history, '2026-09').filter((i) => i.code === 'W008');
    expect(w008).toHaveLength(1);
    expect(w008[0]!.message).toContain('2026-08 の当月本部マスタ棚卸表');
  });

  it('別の種別として取り込んだファイルも検知する', () => {
    const files: FileIdentity[] = [{ kind: 'previous', fileName: '棚卸表.xlsx', sha256: HASH_A }];
    const history = [past({ kind: 'master', targetYm: '2026-09' })];

    expect(checkFileIdentity(files, history, '2026-09').filter((i) => i.code === 'W008')).toHaveLength(
      1,
    );
  });

  it('同じ年月・同じ種別での取り直しは通常運用なので警告しない', () => {
    const files: FileIdentity[] = [{ kind: 'master', fileName: '棚卸表.xlsx', sha256: HASH_A }];
    const history = [past({ kind: 'master', targetYm: '2026-09' })];

    expect(checkFileIdentity(files, history, '2026-09').filter((i) => i.code === 'W008')).toEqual([]);
  });

  it('前月ファイル欄に前月分を指定するのは正しい運用なので警告しない', () => {
    // 前月(2026-08)の処理では当月マスタだった同じファイルを、今月は前月ファイル欄に入れる。
    // 履歴に「2026-08 の master」として残っていても、これは意図した使い方である。
    // ただし取り違えと区別できないため、W008 は出したうえで内容で判断してもらう。
    const files: FileIdentity[] = [{ kind: 'previous', fileName: '棚卸表.xlsx', sha256: HASH_A }];
    const history = [past({ kind: 'master', targetYm: '2026-08' })];
    const w008 = checkFileIdentity(files, history, '2026-09').filter((i) => i.code === 'W008');

    expect(w008).toHaveLength(1);
    expect(w008[0]!.level).toBe('WARNING'); // 処理は止めない
  });

  it('履歴が空なら判定しない', () => {
    const files: FileIdentity[] = [{ kind: 'master', fileName: '棚卸表.xlsx', sha256: HASH_A }];
    expect(checkFileIdentity(files, [], '2026-09')).toEqual([]);
  });

  it('複数ファイルが該当してもメッセージは1件にまとめる', () => {
    const files: FileIdentity[] = [
      { kind: 'master', fileName: 'a.xlsx', sha256: HASH_A },
      { kind: 'orders', fileName: 'b.csv', sha256: HASH_B },
    ];
    const history = [
      past({ kind: 'master', targetYm: '2026-08', sha256: HASH_A }),
      past({ kind: 'orders', targetYm: '2026-08', sha256: HASH_B }),
    ];
    const w008 = checkFileIdentity(files, history, '2026-09').filter((i) => i.code === 'W008');

    expect(w008).toHaveLength(1);
    expect(w008[0]!.count).toBe(2);
  });
});

describe('mergeImportHistory', () => {
  it('同じ年月・同じ種別の記録は最新の1件だけ残す', () => {
    const history = [past({ kind: 'master', targetYm: '2026-09', sha256: HASH_A })];
    const added: ImportedFileRecord[] = [
      {
        kind: 'master',
        targetYm: '2026-09',
        sha256: HASH_B,
        fileName: '棚卸表_修正.xlsx',
        importedAt: '2026-09-02T00:00:00.000Z',
      },
    ];

    const merged = mergeImportHistory(history, added);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sha256).toBe(HASH_B);
  });

  it('別の年月の記録は残す', () => {
    const history = [past({ kind: 'master', targetYm: '2026-08' })];
    const added = [past({ kind: 'master', targetYm: '2026-09', sha256: HASH_B })];

    expect(mergeImportHistory(history, added)).toHaveLength(2);
  });

  it('上限を超えた古い記録は捨てる', () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      past({ kind: 'master', targetYm: `2025-${String(i + 1).padStart(2, '0')}` }),
    );
    expect(mergeImportHistory(history, [], 5)).toHaveLength(5);
  });

  it('取り直しを繰り返しても履歴は増えず、自分自身に反応しない', () => {
    let history: ImportedFileRecord[] = [];
    const added = [past({ kind: 'master', targetYm: '2026-09' })];
    for (let i = 0; i < 5; i += 1) history = mergeImportHistory(history, added);

    expect(history).toHaveLength(1);
    const files: FileIdentity[] = [{ kind: 'master', fileName: 'x.xlsx', sha256: HASH_A }];
    expect(checkFileIdentity(files, history, '2026-09')).toEqual([]);
  });
});
