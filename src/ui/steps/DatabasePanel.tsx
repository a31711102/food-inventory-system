import { useEffect, useState } from 'react';
import { Panel, Note } from '../components';
import { InventoryDatabase } from '../../storage/db';
import {
  detectStorageMode,
  pickDatabaseForSave,
  pickDatabaseForOpen,
  restoreSavedHandle,
  forgetSavedHandle,
  readFromHandle,
  writeToHandle,
  downloadDatabase,
  backupFileName,
  DB_FILE_NAME,
  type StorageMode,
} from '../../storage/fileSystem';
import type { PipelineResult } from '../../app/pipeline';
import type { Role } from '../App';

type Handle = Awaited<ReturnType<typeof restoreSavedHandle>>;

/** sql.js の wasm は同じオリジンから配信する（GitHub Pages のサブパスにも追従させる） */
const locateFile = (file: string): string => `${import.meta.env.BASE_URL}${file}`;

export function DatabasePanel({
  result,
  targetYm,
  role,
}: {
  result: PipelineResult | null;
  targetYm: string;
  role: Role;
}): JSX.Element {
  const [mode] = useState<StorageMode>(() => detectStorageMode());
  const [handle, setHandle] = useState<Handle>(null);
  const [db, setDb] = useState<InventoryDatabase | null>(null);
  const [status, setStatus] = useState<string>('未接続');
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    void (async () => {
      const saved = await restoreSavedHandle();
      if (saved) {
        try {
          const bytes = await readFromHandle(saved);
          const opened = await InventoryDatabase.open(bytes, locateFile);
          setHandle(saved);
          setDb(opened);
          setRuns(opened.listRuns() as Array<Record<string, unknown>>);
          setStatus(`接続済み: ${saved.name}`);
        } catch (e) {
          setStatus(`前回のファイルを開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })();
  }, []);

  const connectNew = async (): Promise<void> => {
    setBusy(true);
    try {
      const h = await pickDatabaseForSave();
      const opened = await InventoryDatabase.open(null, locateFile);
      await writeToHandle(h, opened.export());
      setHandle(h);
      setDb(opened);
      setRuns([]);
      setStatus(`接続済み: ${h.name}（新規作成）`);
    } catch (e) {
      setStatus(`作成できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const connectExisting = async (): Promise<void> => {
    setBusy(true);
    try {
      const h = await pickDatabaseForOpen();
      const opened = await InventoryDatabase.open(await readFromHandle(h), locateFile);
      setHandle(h);
      setDb(opened);
      setRuns(opened.listRuns() as Array<Record<string, unknown>>);
      setStatus(`接続済み: ${h.name}`);
    } catch (e) {
      setStatus(`開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveRun = async (): Promise<void> => {
    if (!db || !result) return;
    setBusy(true);
    try {
      const runId = db.createRun(targetYm);
      db.saveProducts(runId, result.rows);
      db.saveReport(runId, result.report);
      db.saveIssues(runId, result.issues);
      db.saveImportFiles(runId, result.importedFiles);
      db.setRunState(runId, result.hasBlocking ? 'CALCULATED' : 'EXPORTED');
      db.audit('CALCULATE', {
        runId,
        actorRole: role,
        target: targetYm,
        detail: {
          rows: result.rows.length,
          issues: result.issues.length,
          usage: result.report.totalUsageAmount,
        },
      });
      for (const row of result.rows.filter((r) => r.isOwnPurchase && r.purchaseQty !== 0)) {
        db.recordOwnPurchase({
          code: row.code,
          name: row.name,
          category: row.category,
          unitPrice: row.unitPrice,
          targetYm,
        });
      }
      if (handle) await writeToHandle(handle, db.export());
      else downloadDatabase(db.export(), DB_FILE_NAME);
      setRuns(db.listRuns() as Array<Record<string, unknown>>);
      setStatus(`保存しました（処理ラン ${runId}）`);
    } catch (e) {
      setStatus(`保存できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const backup = (): void => {
    if (!db) return;
    downloadDatabase(db.export(), backupFileName());
  };

  const disconnect = async (): Promise<void> => {
    await forgetSavedHandle();
    setHandle(null);
    setDb(null);
    setRuns([]);
    setStatus('未接続');
  };

  return (
    <Panel
      title="履歴データベース"
      hint="対象年月ごとの処理履歴・自店購入の入力履歴を、店舗PC上の SQLite ファイルに保存します。"
    >
      {mode === 'download-fallback' ? (
        <Note variant="warn">
          このブラウザはローカルファイルへの直接書き込みに対応していません（Chrome または Edge を推奨）。
          保存時は <span className="mono">{DB_FILE_NAME}</span> がダウンロードされるので、同じ場所へ上書き保存し、
          次回は「既存のデータベースを開く」から読み込んでください。
        </Note>
      ) : (
        <Note>
          一度 <span className="mono">{DB_FILE_NAME}</span> を指定すれば、以後は同じファイルを直接読み書きします。
          データはこのPCの外へ出ません。バックアップはファイルをコピーするだけで完了します。
        </Note>
      )}

      <p>
        状態: <strong>{status}</strong>
      </p>

      <div className="actions" style={{ marginTop: 0 }}>
        <button type="button" onClick={() => void connectNew()} disabled={busy}>
          新規データベースを作成
        </button>
        <button type="button" onClick={() => void connectExisting()} disabled={busy}>
          既存のデータベースを開く
        </button>
        <button type="button" className="primary" onClick={() => void saveRun()} disabled={busy || !db || !result}>
          この処理結果を保存
        </button>
        <button type="button" onClick={backup} disabled={!db}>
          バックアップを書き出す
        </button>
        {handle ? (
          <button type="button" onClick={() => void disconnect()} disabled={busy}>
            接続を解除
          </button>
        ) : null}
      </div>

      {runs.length > 0 ? (
        <>
          <h3>保存済みの処理ラン</h3>
          <div className="scroll" style={{ maxHeight: 220 }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>対象年月</th>
                  <th className="right">版</th>
                  <th>状態</th>
                  <th>最終確定</th>
                  <th>更新日時</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={String(r['run_id'])}>
                    <td>{String(r['target_ym'])}</td>
                    <td className="num">{String(r['revision'])}</td>
                    <td>{String(r['state'])}</td>
                    <td>{Number(r['is_final']) === 1 ? '○' : ''}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {String(r['updated_at']).slice(0, 19).replace('T', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Panel>
  );
}
