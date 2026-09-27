// @vitest-environment happy-dom
/**
 * 画面テスト M-20〜M-22（履歴データベース）。
 * 手順: docs/06_画面テスト手順書.md §10
 *
 * 保存先（File System Access API / IndexedDB）だけをテスト用に差し替え、
 * SQLite の作成・保存・読み直しは本物の sql.js がそのまま動く。
 * 本番の inventory.db には一切触れない。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resolve } from 'node:path';
import { initSqlJsOnce, InventoryDatabase } from '@/storage/db';
import { buildNormalSet } from '../helpers/testdataSet';
import { installFileSystemStub, clearHandleStore, type FileSystemStub } from '../helpers/fileSystemStub';
import {
  setupApp,
  importNormalSet,
  advanceToAnalyze,
  clickAndSettle,
  buttonByText,
  findButton,
  waitFor,
  type Harness,
} from '../helpers/uiHarness';

let set: Awaited<ReturnType<typeof buildNormalSet>>;
let stub: FileSystemStub;

beforeAll(async () => {
  set = await buildNormalSet();
  // sql.js の wasm はローカルのファイルから読ませる（画面側の locateFile は使えないため、
  // 先に初期化してキャッシュさせる）。DBの中身の処理は本物がそのまま動く。
  await initSqlJsOnce(() => resolve('public/sql-wasm.wasm'));
});

beforeEach(async () => {
  await clearHandleStore();
  stub = installFileSystemStub();
});

afterEach(() => {
  stub.restore();
  cleanup();
});

async function connectNewDatabase(h: Harness): Promise<void> {
  await clickAndSettle(h, buttonByText('新規データベースを作成'));
  await waitFor(() => expect(document.body.textContent).toContain('接続済み'), { timeout: 20000 });
}

describe('M-20 新規作成と保存（J-14）', () => {
  it('新規データベースを作成すると接続状態になる', async () => {
    const h = setupApp();
    expect(document.body.textContent).toContain('状態: 未接続');

    await connectNewDatabase(h);

    expect(document.body.textContent).toContain('接続済み: inventory.db（新規作成）');
    expect(stub.saveCalls).toBe(1);
    expect(stub.files.get('inventory.db')?.bytes.length).toBeGreaterThan(0);
  }, 60000);

  it('作成された .db が本物の SQLite で、スキーマ版が入っている', async () => {
    const h = setupApp();
    await connectNewDatabase(h);

    const bytes = stub.files.get('inventory.db')!.bytes;
    // SQLite ファイルのマジックヘッダ
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe('SQLite format 3');

    const db = await InventoryDatabase.open(bytes);
    expect(db.getMeta('schema_version')).toBe('2');
    db.close();
  }, 60000);

  it('処理結果を保存すると処理ランが1件増える', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);
    await connectNewDatabase(h);

    await clickAndSettle(h, buttonByText('この処理結果を保存'));
    await waitFor(() => expect(document.body.textContent).toContain('保存しました（処理ラン'), {
      timeout: 20000,
    });

    const db = await InventoryDatabase.open(stub.files.get('inventory.db')!.bytes);
    const runs = db.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.target_ym).toBe('2026-09');
    db.close();
  }, 60000);

  it('保存した内容に明細・レポート・指摘・取込ファイルが含まれる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);
    await connectNewDatabase(h);
    await clickAndSettle(h, buttonByText('この処理結果を保存'));
    await waitFor(() => expect(document.body.textContent).toContain('保存しました（処理ラン'));

    const db = await InventoryDatabase.open(stub.files.get('inventory.db')!.bytes);
    const count = (table: string): number =>
      Number(db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n);

    expect(count('monthly_product')).toBe(10);
    expect(count('report_value')).toBeGreaterThan(0);
    expect(count('validation_issue')).toBeGreaterThan(0);
    expect(count('import_file')).toBe(4); // 4ファイル分のハッシュ
    expect(count('audit_log')).toBeGreaterThan(0);
    db.close();
  }, 60000);

  it('まとめた指摘は件数と内訳が残る（スキーマ v2）', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);
    await connectNewDatabase(h);
    await clickAndSettle(h, buttonByText('この処理結果を保存'));
    await waitFor(() => expect(document.body.textContent).toContain('保存しました（処理ラン'));

    const db = await InventoryDatabase.open(stub.files.get('inventory.db')!.bytes);
    const rows = db.select<{ code: string; detail_count: number; details_json: string | null }>(
      'SELECT code, detail_count, details_json FROM validation_issue WHERE detail_count > 1',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const details = JSON.parse(row.details_json!) as unknown[];
      expect(details).toHaveLength(Number(row.detail_count));
    }
    db.close();
  }, 60000);

  it('商品コードが文字列のまま保存される（先頭ゼロが消えない）', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);
    await connectNewDatabase(h);
    await clickAndSettle(h, buttonByText('この処理結果を保存'));
    await waitFor(() => expect(document.body.textContent).toContain('保存しました（処理ラン'));

    const db = await InventoryDatabase.open(stub.files.get('inventory.db')!.bytes);
    const codes = db
      .select<{ product_code: string }>('SELECT product_code FROM monthly_product ORDER BY line_no')
      .map((r) => r.product_code);

    expect(codes).toContain('000140');
    expect(codes).not.toContain(140);
    db.close();
  }, 60000);
});

describe('M-21 既存データベースを開く（J-14）', () => {
  it('保存済みの .db を開くと処理ランの一覧が出る', async () => {
    // 1回目: 作成して保存する
    const first = setupApp();
    await importNormalSet(first, set);
    await advanceToAnalyze(first);
    await connectNewDatabase(first);
    await clickAndSettle(first, buttonByText('この処理結果を保存'));
    await waitFor(() => expect(document.body.textContent).toContain('保存しました（処理ラン'));
    first.rendered.unmount();

    // 2回目: 同じファイルを「既存のデータベースを開く」から開く
    const second = setupApp({ keepHistory: true });
    await clickAndSettle(second, buttonByText('既存のデータベースを開く'));
    await waitFor(() => expect(document.body.textContent).toContain('接続済み: inventory.db'), {
      timeout: 20000,
    });

    expect(stub.openCalls).toBe(1);
    expect(document.body.textContent).toContain('2026-09');
  }, 60000);

  it('2か月分を保存すると処理ランが2件になる', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);
    await connectNewDatabase(h);

    await clickAndSettle(h, buttonByText('この処理結果を保存'));
    await waitFor(() => expect(document.body.textContent).toContain('保存しました（処理ラン'));
    // 同じ対象年月でもう一度保存すると版（revision）が増える
    await clickAndSettle(h, buttonByText('この処理結果を保存'));
    await waitFor(() => expect(document.body.textContent).toContain('保存しました（処理ラン 2'));

    const db = await InventoryDatabase.open(stub.files.get('inventory.db')!.bytes);
    const runs = db.listRuns('2026-09');
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.revision).sort()).toEqual([1, 2]);
    db.close();
  }, 60000);
});

describe('M-22 バックアップの書き出し（J-14）', () => {
  it('日付入りのファイル名で .db がダウンロードされる', async () => {
    const h = setupApp();
    await connectNewDatabase(h);

    const before = h.downloads.length;
    await clickAndSettle(h, buttonByText('バックアップを書き出す'));
    await waitFor(() => expect(h.downloads.length).toBe(before + 1));

    const backup = h.downloads[h.downloads.length - 1]!;
    expect(backup.fileName).toMatch(/inventory_\d{8}_\d{6}\.db/);

    const bytes = await backup.bytes;
    expect(bytes.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe('SQLite format 3');
  }, 60000);

  it('バックアップの中身が保存済みの処理ランを含む', async () => {
    const h = setupApp();
    await importNormalSet(h, set);
    await advanceToAnalyze(h);
    await connectNewDatabase(h);
    await clickAndSettle(h, buttonByText('この処理結果を保存'));
    await waitFor(() => expect(document.body.textContent).toContain('保存しました（処理ラン'));

    await clickAndSettle(h, buttonByText('バックアップを書き出す'));
    await waitFor(() => expect(h.downloads.length).toBeGreaterThan(0));

    const bytes = await h.downloads[h.downloads.length - 1]!.bytes;
    const db = await InventoryDatabase.open(bytes);
    expect(db.listRuns()).toHaveLength(1);
    db.close();
  }, 60000);

  it('未接続ならバックアップのボタンは押せない', async () => {
    setupApp();
    const button = findButton('バックアップを書き出す');
    expect(button?.disabled).toBe(true);
  }, 60000);
});
