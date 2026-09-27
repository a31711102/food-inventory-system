/**
 * sql.js（SQLite の WebAssembly ビルド）による永続化。
 *
 * ブラウザ内で本物の SQLite を動かし、バイト列として書き出す。
 * 書き出したバイト列は File System Access API でローカルの .db ファイルへ保存する
 * （src/storage/fileSystem.ts）。GitHub Pages から配信しても、データは
 * 店舗PCの外へ一切出ない。
 */
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { SCHEMA_SQL, SCHEMA_VERSION, type AuditAction, type RunState } from './schema';
import type { ProductRow, ReportValues, OwnPurchaseCandidate } from '../domain/models';
import type { ValidationIssue } from '../domain/issues';
import type { ImportedFileRecord } from '../ingest/fileIdentity';

export type SqlValue = string | number | Uint8Array | null;

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/** sql.js を初期化する。wasm の場所は呼び出し側から差し替えられる。 */
export function initSqlJsOnce(locateFile?: (file: string) => string): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = locateFile ? initSqlJs({ locateFile }) : initSqlJs();
  }
  return sqlJsPromise;
}

export class InventoryDatabase {
  private constructor(private readonly db: Database) {}

  /** 新規作成、または既存の .db バイト列から開く。 */
  static async open(
    bytes?: Uint8Array | null,
    locateFile?: (file: string) => string,
  ): Promise<InventoryDatabase> {
    const SQL = await initSqlJsOnce(locateFile);
    const db = bytes && bytes.length > 0 ? new SQL.Database(bytes) : new SQL.Database();
    const instance = new InventoryDatabase(db);
    instance.migrate();
    return instance;
  }

  private migrate(): void {
    this.db.run(SCHEMA_SQL);
    const current = this.getMeta('schema_version');
    if (current === null) {
      this.setMeta('schema_version', String(SCHEMA_VERSION));
      return;
    }
    // v1 で作られた .db には validation_issue の内訳列がないので追加する。
    // CREATE TABLE IF NOT EXISTS では既存テーブルに列が増えないため、明示的に足す。
    if (Number(current) < 2) {
      this.addColumnIfMissing('validation_issue', 'detail_count', 'INTEGER NOT NULL DEFAULT 1');
      this.addColumnIfMissing('validation_issue', 'details_json', 'TEXT');
      this.setMeta('schema_version', '2');
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const cols = this.select<{ name: string }>(`PRAGMA table_info(${table})`);
    if (cols.some((c) => c.name === column)) return;
    this.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  getMeta(key: string): string | null {
    const rows = this.select<{ value: string }>('SELECT value FROM schema_meta WHERE key = ?', [key]);
    return rows[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params);
  }

  select<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const out: T[] = [];
    while (stmt.step()) out.push(stmt.getAsObject() as T);
    stmt.free();
    return out;
  }

  lastInsertId(): number {
    const rows = this.select<{ id: number }>('SELECT last_insert_rowid() AS id');
    return Number(rows[0]?.id ?? 0);
  }

  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      return result;
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  /** .db ファイルとして書き出す。 */
  export(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // 処理ラン
  // -------------------------------------------------------------------------

  createRun(targetYm: string, note?: string): number {
    const now = new Date().toISOString();
    const rows = this.select<{ next: number }>(
      'SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM processing_run WHERE store_id = 1 AND target_ym = ?',
      [targetYm],
    );
    const revision = Number(rows[0]?.next ?? 1);
    this.run(
      `INSERT INTO processing_run (store_id, target_ym, revision, state, is_final, created_at, updated_at, note)
       VALUES (1, ?, ?, 'DRAFT', 0, ?, ?, ?)`,
      [targetYm, revision, now, now, note ?? null],
    );
    return this.lastInsertId();
  }

  setRunState(runId: number, state: RunState): void {
    this.run('UPDATE processing_run SET state = ?, updated_at = ? WHERE run_id = ?', [
      state,
      new Date().toISOString(),
      runId,
    ]);
  }

  /** 最終確定版を切り替える。同一年月で1つだけになるよう先に解除する。 */
  markFinal(runId: number): void {
    const rows = this.select<{ target_ym: string }>(
      'SELECT target_ym FROM processing_run WHERE run_id = ?',
      [runId],
    );
    const ym = rows[0]?.target_ym;
    if (!ym) throw new Error(`処理ラン ${runId} が見つかりません。`);
    this.transaction(() => {
      this.run('UPDATE processing_run SET is_final = 0 WHERE store_id = 1 AND target_ym = ?', [ym]);
      this.run('UPDATE processing_run SET is_final = 1, updated_at = ? WHERE run_id = ?', [
        new Date().toISOString(),
        runId,
      ]);
    });
  }

  listRuns(targetYm?: string): Array<{
    run_id: number;
    target_ym: string;
    revision: number;
    state: string;
    is_final: number;
    created_at: string;
    updated_at: string;
    note: string | null;
  }> {
    return targetYm
      ? this.select('SELECT * FROM processing_run WHERE target_ym = ? ORDER BY revision DESC', [targetYm])
      : this.select('SELECT * FROM processing_run ORDER BY target_ym DESC, revision DESC');
  }

  findFinalRun(targetYm: string): number | null {
    const rows = this.select<{ run_id: number }>(
      'SELECT run_id FROM processing_run WHERE target_ym = ? AND is_final = 1',
      [targetYm],
    );
    return rows[0]?.run_id ?? null;
  }

  // -------------------------------------------------------------------------
  // 明細・レポート・検証結果
  // -------------------------------------------------------------------------

  saveProducts(runId: number, rows: readonly ProductRow[]): void {
    this.transaction(() => {
      this.run('DELETE FROM monthly_product WHERE run_id = ?', [runId]);
      for (const r of rows) {
        this.run(
          `INSERT INTO monthly_product
             (run_id, line_no, product_code, product_name, category, inventory_unit, unit_price,
              conversion_factor, opening_qty, purchase_qty, closing_qty, usage_qty, usage_amount,
              closing_amount, status, is_own_purchase, opening_approved, source_row_ref)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            runId,
            r.lineNo,
            r.code,
            r.name,
            r.category,
            r.inventoryUnit,
            String(r.unitPrice),
            String(r.conversionFactor),
            String(r.openingQty),
            String(r.purchaseQty),
            String(r.closingQty),
            r.usageQty === null ? null : String(r.usageQty),
            r.usageAmount === null ? null : String(r.usageAmount),
            r.closingAmount === null ? null : String(r.closingAmount),
            r.status,
            r.isOwnPurchase ? 1 : 0,
            r.openingApproved ? 1 : 0,
            null,
          ],
        );
      }
    });
  }

  saveReport(runId: number, report: ReportValues): void {
    const put = (scope: string, category: string, metric: string, value: number | null, reason?: string | null): void => {
      this.run(
        `INSERT INTO report_value (run_id, scope, category, metric, value, unavailable_reason)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(run_id, scope, category, metric)
         DO UPDATE SET value = excluded.value, unavailable_reason = excluded.unavailable_reason`,
        [runId, scope, category, metric, value === null ? null : String(value), reason ?? null],
      );
    };

    this.transaction(() => {
      this.run('DELETE FROM report_value WHERE run_id = ?', [runId]);
      put('OVERALL', '', 'SALES', report.totalSales);
      put('OVERALL', '', 'USAGE_AMOUNT', report.totalUsageAmount);
      put('OVERALL', '', 'CLOSING_AMOUNT', report.totalClosingAmount);
      put('OVERALL', '', 'COST_RATE', report.overallCostRatePercent, report.unavailableReasons['COST_RATE']);
      put('OVERALL', '', 'LOSS', report.lossAmount);
      put('OVERALL', '', 'COST_AFTER_LOSS', report.costAfterLoss);
      put('OVERALL', '', 'COST_RATE_AFTER_LOSS', report.costRateAfterLossPercent, report.unavailableReasons['COST_RATE_AFTER_LOSS']);
      put('OVERALL', '', 'SALAD_VEGETABLE_USAGE', report.saladVegetableUsage);
      for (const c of report.categories) {
        put('CATEGORY', c.category, 'USAGE_AMOUNT', c.usageAmount);
        put('CATEGORY', c.category, 'CLOSING_AMOUNT', c.closingAmount);
        put('CATEGORY', c.category, 'COST_RATE', c.costRatePercent, c.unavailableReason);
      }
    });
  }

  saveIssues(runId: number, issues: readonly ValidationIssue[]): void {
    this.transaction(() => {
      this.run('DELETE FROM validation_issue WHERE run_id = ?', [runId]);
      for (const i of issues) {
        this.run(
          `INSERT INTO validation_issue
             (run_id, level, code, title, message, file_name, sheet_name, row_no, product_code,
              detail_count, details_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            runId,
            i.level,
            i.code,
            i.title,
            i.message,
            i.ref.fileName ?? null,
            i.ref.sheetName ?? null,
            i.ref.rowNo ?? null,
            i.ref.productCode ?? null,
            i.count,
            i.details.length > 0 ? JSON.stringify(i.details) : null,
          ],
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // 取込ファイルの識別情報（同一ファイル再取込の検知 W008）
  // -------------------------------------------------------------------------

  saveImportFiles(runId: number, files: readonly ImportedFileRecord[]): void {
    this.transaction(() => {
      this.run('DELETE FROM import_file WHERE run_id = ?', [runId]);
      for (const f of files) {
        this.run(
          `INSERT INTO import_file (run_id, file_kind, original_filename, sha256, imported_at)
           VALUES (?,?,?,?,?)`,
          [runId, f.kind, f.fileName, f.sha256, f.importedAt],
        );
      }
    });
  }

  /** 過去の取込記録を新しい順に返す。W008 の判定に渡す。 */
  listImportedFiles(limit = 200): ImportedFileRecord[] {
    const rows = this.select<{
      file_kind: string;
      original_filename: string;
      sha256: string;
      target_ym: string;
      imported_at: string;
    }>(
      `SELECT f.file_kind, f.original_filename, f.sha256, r.target_ym, f.imported_at
         FROM import_file f
         JOIN processing_run r ON r.run_id = f.run_id
        ORDER BY f.import_id DESC
        LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      kind: r.file_kind as ImportedFileRecord['kind'],
      fileName: r.original_filename,
      sha256: r.sha256,
      targetYm: r.target_ym,
      importedAt: r.imported_at,
    }));
  }

  // -------------------------------------------------------------------------
  // 自店購入の履歴（品名の部分一致検索）
  // -------------------------------------------------------------------------

  recordOwnPurchase(entry: {
    code: string;
    name: string;
    category: string;
    unitPrice: number;
    targetYm: string;
  }): void {
    this.run(
      `INSERT INTO own_purchase_history
         (product_code, product_name, search_key, category, unit_price, target_ym, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [
        entry.code,
        entry.name,
        entry.name.trim().toLowerCase(),
        entry.category,
        String(entry.unitPrice),
        entry.targetYm,
        new Date().toISOString(),
      ],
    );
  }

  /**
   * 品名の部分一致検索。
   * 正規化は前後空白除去と英字小文字化のみ。全角/半角・カタカナ/ひらがなの統合はしない
   * （要件§4「表記揺れを推測で同一視しない」）。
   */
  searchOwnPurchaseHistory(query: string, limit = 50): OwnPurchaseCandidate[] {
    const key = query.trim().toLowerCase();
    const rows = this.select<{
      product_code: string;
      product_name: string;
      category: string | null;
      unit_price: string | null;
      last_ym: string;
    }>(
      `SELECT product_code, product_name, category, unit_price, MAX(target_ym) AS last_ym
         FROM own_purchase_history
        WHERE search_key LIKE ?
        GROUP BY product_code
        ORDER BY last_ym DESC, product_code ASC
        LIMIT ?`,
      [`%${key}%`, limit],
    );
    return rows.map((r) => ({
      code: r.product_code as OwnPurchaseCandidate['code'],
      name: r.product_name,
      category: r.category ?? '',
      // 履歴に残っている＝過去に自店購入として入力した実績がある品
      registered: true,
      lastUsedYm: r.last_ym,
      lastUnitPrice: r.unit_price === null ? null : Number(r.unit_price),
    }));
  }

  // -------------------------------------------------------------------------
  // 操作履歴
  // -------------------------------------------------------------------------

  audit(
    action: AuditAction,
    options: { runId?: number | null; actorRole?: string; target?: string; detail?: unknown } = {},
  ): void {
    this.run(
      'INSERT INTO audit_log (run_id, actor_role, action, target, detail_json, at) VALUES (?,?,?,?,?,?)',
      [
        options.runId ?? null,
        options.actorRole ?? null,
        action,
        options.target ?? null,
        options.detail === undefined ? null : JSON.stringify(options.detail),
        new Date().toISOString(),
      ],
    );
  }

  listAudit(runId?: number, limit = 200): Array<Record<string, SqlValue>> {
    return runId === undefined
      ? this.select('SELECT * FROM audit_log ORDER BY log_id DESC LIMIT ?', [limit])
      : this.select('SELECT * FROM audit_log WHERE run_id = ? ORDER BY log_id DESC LIMIT ?', [runId, limit]);
  }
}
