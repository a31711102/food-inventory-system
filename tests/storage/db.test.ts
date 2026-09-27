import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { InventoryDatabase } from '@/storage/db';
import { buildReport } from '@/domain/report';
import { computeAllDerived } from '@/domain/calculation';
import { createIssue } from '@/domain/issues';
import { makeRow, code } from '../helpers/factories';

// Node 環境では sql.js の wasm をローカルの node_modules から読む
const require = createRequire(import.meta.url);
const sqlJsDir = dirname(require.resolve('sql.js'));
const locateFile = (file: string): string => join(sqlJsDir, file);

async function open(bytes?: Uint8Array): Promise<InventoryDatabase> {
  return InventoryDatabase.open(bytes ?? null, locateFile);
}

describe('InventoryDatabase', () => {
  let db: InventoryDatabase;

  beforeEach(async () => {
    db = await open();
  });

  it('スキーマを作成しバージョンを記録する', () => {
    expect(db.getMeta('schema_version')).toBe('2');
  });

  describe('永続化（本物のSQLiteファイル）', () => {
    it('書き出したバイト列を読み直せる', async () => {
      const runId = db.createRun('2026-09');
      db.setRunState(runId, 'CALCULATED');
      const bytes = db.export();

      const reopened = await open(bytes);
      expect(reopened.listRuns('2026-09')[0]?.state).toBe('CALCULATED');
    });

    it('書き出しはSQLiteのファイル形式である', () => {
      db.createRun('2026-09');
      const bytes = db.export();
      const header = new TextDecoder().decode(bytes.subarray(0, 15));
      expect(header).toBe('SQLite format 3');
    });
  });

  describe('処理ラン', () => {
    it('同一年月で版番号を1から採番する', () => {
      db.createRun('2026-09');
      db.createRun('2026-09');
      expect(db.listRuns('2026-09').map((r) => r.revision)).toEqual([2, 1]);
    });

    it('年月が違えば版番号は別系列になる', () => {
      db.createRun('2026-08');
      const id = db.createRun('2026-09');
      expect(db.listRuns('2026-09').find((r) => r.run_id === id)?.revision).toBe(1);
    });

    it('最終確定版は対象年月ごとに1つだけ', () => {
      const a = db.createRun('2026-09');
      const b = db.createRun('2026-09');
      db.markFinal(a);
      db.markFinal(b);

      const finals = db.listRuns('2026-09').filter((r) => r.is_final === 1);
      expect(finals.map((r) => r.run_id)).toEqual([b]);
    });

    it('最終確定版を検索できる', () => {
      const a = db.createRun('2026-09');
      db.markFinal(a);
      expect(db.findFinalRun('2026-09')).toBe(a);
    });

    it('最終確定版がなければ null', () => {
      db.createRun('2026-09');
      expect(db.findFinalRun('2026-09')).toBeNull();
    });
  });

  describe('明細の保存', () => {
    it('商品コードを文字列のまま保存し先頭ゼロを失わない', () => {
      const runId = db.createRun('2026-09');
      const rows = computeAllDerived([makeRow({ code: code('000140'), lineNo: 3 })]);
      db.saveProducts(runId, rows);

      const saved = db.select<{ product_code: string }>(
        'SELECT product_code FROM monthly_product WHERE run_id = ?',
        [runId],
      );
      expect(saved[0]?.product_code).toBe('000140');
    });

    it('小数の精度を保ったまま往復できる', () => {
      const runId = db.createRun('2026-09');
      const rows = computeAllDerived([
        makeRow({ code: code('006017'), unitPrice: 175.42553191, purchaseQty: 3 }),
      ]);
      db.saveProducts(runId, rows);

      const saved = db.select<{ usage_amount: string }>(
        'SELECT usage_amount FROM monthly_product WHERE run_id = ?',
        [runId],
      );
      expect(Number(saved[0]!.usage_amount)).toBe(175.42553191 * 3);
    });

    it('再保存すると前回の明細を置き換える', () => {
      const runId = db.createRun('2026-09');
      db.saveProducts(runId, computeAllDerived([makeRow({ lineNo: 3 }), makeRow({ lineNo: 4 })]));
      db.saveProducts(runId, computeAllDerived([makeRow({ lineNo: 3 })]));

      const count = db.select<{ n: number }>(
        'SELECT COUNT(*) AS n FROM monthly_product WHERE run_id = ?',
        [runId],
      );
      expect(Number(count[0]!.n)).toBe(1);
    });

    it('分類を月次スナップショットとして保持する', () => {
      const runId = db.createRun('2026-09');
      db.saveProducts(runId, computeAllDerived([makeRow({ category: '09.野菜' })]));

      const saved = db.select<{ category: string }>(
        'SELECT category FROM monthly_product WHERE run_id = ?',
        [runId],
      );
      expect(saved[0]?.category).toBe('09.野菜');
    });
  });

  describe('レポート値（縦持ち）', () => {
    it('全体とカテゴリ別を保存する', () => {
      const runId = db.createRun('2026-09');
      const rows = computeAllDerived([
        makeRow({ category: '01.ソース', unitPrice: 1, purchaseQty: 1000 }),
      ]);
      db.saveReport(runId, buildReport(rows, { targetYm: '2026-09', totalSales: 10000 }));

      const overall = db.select<{ value: string }>(
        "SELECT value FROM report_value WHERE run_id = ? AND scope = 'OVERALL' AND metric = 'USAGE_AMOUNT'",
        [runId],
      );
      expect(Number(overall[0]!.value)).toBe(1000);

      const cats = db.select<{ n: number }>(
        "SELECT COUNT(*) AS n FROM report_value WHERE run_id = ? AND scope = 'CATEGORY'",
        [runId],
      );
      expect(Number(cats[0]!.n)).toBe(17 * 3);
    });

    it('算出不可の指標は理由を保存する', () => {
      const runId = db.createRun('2026-09');
      const report = buildReport([], { targetYm: '2026-09', totalSales: 0 });
      db.saveReport(runId, report);

      const row = db.select<{ value: string | null; unavailable_reason: string | null }>(
        "SELECT value, unavailable_reason FROM report_value WHERE run_id = ? AND scope='OVERALL' AND metric='COST_RATE'",
        [runId],
      );
      expect(row[0]!.value).toBeNull();
      expect(row[0]!.unavailable_reason).toContain('売上高が0');
    });
  });

  describe('検証結果', () => {
    it('位置情報つきで保存する', () => {
      const runId = db.createRun('2026-09');
      db.saveIssues(runId, [
        createIssue('E002', 'コード重複', {
          fileName: 'master.xlsx',
          sheetName: '入力用',
          rowNo: 42,
          productCode: '000140',
        }),
      ]);

      const saved = db.select<Record<string, string | number | null>>(
        'SELECT * FROM validation_issue WHERE run_id = ?',
        [runId],
      );
      expect(saved[0]).toMatchObject({
        code: 'E002',
        level: 'BLOCKING',
        file_name: 'master.xlsx',
        sheet_name: '入力用',
        row_no: 42,
        product_code: '000140',
      });
    });
  });

  describe('自店購入の履歴検索（要件§4）', () => {
    beforeEach(() => {
      db.recordOwnPurchase({ code: 'A00043', name: 'キャベツ(自店購入）', category: '09.野菜', unitPrice: 273, targetYm: '2026-07' });
      db.recordOwnPurchase({ code: 'A00043', name: 'キャベツ(自店購入）', category: '09.野菜', unitPrice: 280, targetYm: '2026-08' });
      db.recordOwnPurchase({ code: 'A00049', name: '牛乳(自店購入)', category: '11.ドリンク', unitPrice: 210, targetYm: '2026-08' });
    });

    it('品名の部分一致で検索できる', () => {
      expect(db.searchOwnPurchaseHistory('キャベツ').map((c) => c.code)).toEqual(['A00043']);
    });

    it('部分文字列でも一致する', () => {
      expect(db.searchOwnPurchaseHistory('自店購入').map((c) => c.code).sort()).toEqual([
        'A00043',
        'A00049',
      ]);
    });

    it('同一コードは1件にまとめ最終使用年月を返す', () => {
      const hit = db.searchOwnPurchaseHistory('キャベツ')[0]!;
      expect(hit.lastUsedYm).toBe('2026-08');
    });

    it('最終使用年月の降順で並ぶ', () => {
      db.recordOwnPurchase({ code: 'A00050', name: 'マンゴーソース', category: '14.限定', unitPrice: 500, targetYm: '2026-09' });
      expect(db.searchOwnPurchaseHistory('')[0]?.code).toBe('A00050');
    });

    it('表記揺れを推測で同一視しない（全角/半角を統合しない）', () => {
      db.recordOwnPurchase({ code: 'A99999', name: 'ＡＢＣ牛乳', category: '11.ドリンク', unitPrice: 100, targetYm: '2026-08' });
      // 半角 "ABC" では全角の品名にヒットしない
      expect(db.searchOwnPurchaseHistory('ABC')).toHaveLength(0);
      expect(db.searchOwnPurchaseHistory('ＡＢＣ').map((c) => c.code)).toEqual(['A99999']);
    });

    it('英字の大文字小文字は区別しない', () => {
      db.recordOwnPurchase({ code: 'A88888', name: 'Cabbage', category: '09.野菜', unitPrice: 100, targetYm: '2026-08' });
      expect(db.searchOwnPurchaseHistory('cabbage').map((c) => c.code)).toEqual(['A88888']);
    });

    it('該当なしなら空配列', () => {
      expect(db.searchOwnPurchaseHistory('存在しない品名')).toEqual([]);
    });
  });

  describe('操作履歴（要件§7「差分の確認操作は記録する」）', () => {
    it('操作を記録できる', () => {
      const runId = db.createRun('2026-09');
      db.audit('OPENING_APPROVE', { runId, actorRole: 'ADMIN', target: '000140', detail: { opening: 0 } });

      const logs = db.listAudit(runId);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ action: 'OPENING_APPROVE', actor_role: 'ADMIN', target: '000140' });
    });

    it('詳細をJSONで保存する', () => {
      const runId = db.createRun('2026-09');
      db.audit('DIFF_REVIEW', { runId, detail: { newProducts: 3, deleted: 1 } });

      const logs = db.listAudit(runId) as Array<{ detail_json: string }>;
      expect(JSON.parse(logs[0]!.detail_json)).toEqual({ newProducts: 3, deleted: 1 });
    });

    it('新しい順に返す', () => {
      const runId = db.createRun('2026-09');
      db.audit('UPLOAD', { runId });
      db.audit('CALCULATE', { runId });
      expect((db.listAudit(runId) as Array<{ action: string }>)[0]?.action).toBe('CALCULATE');
    });
  });

  describe('トランザクション', () => {
    it('例外が起きたら巻き戻す', () => {
      const runId = db.createRun('2026-09');
      expect(() =>
        db.transaction(() => {
          db.run("INSERT INTO audit_log (run_id, action, at) VALUES (?, 'UPLOAD', '2026-09-23')", [runId]);
          throw new Error('boom');
        }),
      ).toThrow('boom');

      expect(db.listAudit(runId)).toHaveLength(0);
    });
  });
});
