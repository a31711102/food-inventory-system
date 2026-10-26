import { useCallback, useEffect, useMemo, useState } from 'react';
import './styles.css';
import { runPipeline, previousYm, type ConfirmedRealSales, type PipelineResult, type UploadedFile } from '../app/pipeline';
import type { OwnPurchaseInput } from '../domain/models';
import { defaultTargetYm } from './format';
import { StepUpload } from './steps/StepUpload';
import { StepMapping } from './steps/StepMapping';
import { StepDiff } from './steps/StepDiff';
import { StepOwnPurchase } from './steps/StepOwnPurchase';
import { StepAnalyze } from './steps/StepAnalyze';
import { StepSales } from './steps/StepSales';
import type { RealSalesMasters } from '../domain/realSales/masters';
import { loadMasters, loadSalesHistory, recordSales, saveMasters, type SalesHistoryEntry } from '../storage/realSalesStore';
import { DatabasePanel } from './steps/DatabasePanel';
import type { FileKind, ImportedFileRecord } from '../ingest/fileIdentity';
import { appendImportHistory, loadImportHistory } from '../storage/importHistory';
import { clearUnitMaster, loadUnitMaster, saveUnitMaster, type SavedUnitMaster } from '../storage/unitMasterStore';

export type { FileKind };
export type Role = 'ADMIN' | 'STAFF';

export interface AppFiles {
  master: UploadedFile | null;
  previous: UploadedFile | null;
  orders: UploadedFile | null;
  unitMaster: UploadedFile | null;
}

const STEPS = [
  { id: 1, label: '月次処理開始', short: 'ファイル取込' },
  { id: 2, label: '列設定と取込結果', short: '列の対応確認' },
  { id: 3, label: '商品差分確認', short: '新規・削除' },
  { id: 4, label: '自店購入入力', short: '発注外の仕入' },
  { id: 5, label: '売上計算', short: '当月売上高の確定' },
  { id: 6, label: '分析・出力', short: '比較とダウンロード' },
] as const;

export default function App(): JSX.Element {
  const [step, setStep] = useState(1);
  const [role, setRole] = useState<Role>('ADMIN');
  const [targetYm, setTargetYm] = useState(defaultTargetYm());
  const [files, setFiles] = useState<AppFiles>({
    master: null,
    previous: null,
    orders: null,
    unitMaster: null,
  });
  const [ownPurchases, setOwnPurchases] = useState<OwnPurchaseInput[]>([]);
  const [approvedCodes, setApprovedCodes] = useState<Set<string>>(new Set());
  const [lossAmountOverride, setLossAmountOverride] = useState<number | null>(null);
  /** 確定した売上の履歴（前月比の変動判定 W031 に使う。要件§11） */
  const [salesHistory, setSalesHistory] = useState<Record<string, SalesHistoryEntry>>(() => loadSalesHistory());
  const [realSalesConfirmed, setRealSalesConfirmed] = useState<ConfirmedRealSales | null>(null);
  /** 登録済みの単位計算マスタ。指定が無い月はこれを使う（2026-10-26 運用変更） */
  const [savedUnitMaster, setSavedUnitMaster] = useState<SavedUnitMaster | null>(() => loadUnitMaster());
  const [masters, setMastersState] = useState<RealSalesMasters>(() => loadMasters());
  const setMasters = useCallback((m: RealSalesMasters) => {
    setMastersState(m);
    saveMasters(m);
  }, []);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 再アップロード後は古い計算結果を無効にする（要件§7） */
  const [stale, setStale] = useState(false);
  /** 取込履歴。同じファイルを別の年月・別の欄で使い回していないか（W008）の判定に使う */
  const [importHistory, setImportHistory] = useState<ImportedFileRecord[]>(() =>
    loadImportHistory(),
  );

  /**
   * 再計算。
   *
   * `overrides` は「状態を更新した直後に、その値で計算し直したい」ときに使う。
   * setState は非同期なので、直後に recalc() を呼ぶと古い値で計算してしまう
   * （換算係数を登録しても画面が変わらない、という形で現れていた）。
   */
  const recalc = useCallback(async (overrides?: { realSales?: ConfirmedRealSales | null }) => {
    if (!files.master) return;
    setRunning(true);
    setError(null);
    try {
      const next = await runPipeline({
        targetYm,
        master: files.master,
        previous: files.previous,
        orders: files.orders,
        unitMaster: files.unitMaster ?? savedUnitMaster,
        ownPurchases,
        approvedOpeningCodes: approvedCodes,
        importHistory,
        lossAmountOverride,
        sales: {
          confirmed: overrides?.realSales !== undefined ? overrides.realSales : realSalesConfirmed,
        },
        approveNewOpening: false,
      });
      setResult(next);
      setStale(false);
      // 履歴は判定に使ったあとで更新する（同じ実行で自分自身に反応させない）
      setImportHistory(appendImportHistory(next.importedFiles));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
    // importHistory は判定に使うだけで、更新をトリガに再計算しない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, targetYm, ownPurchases, lossAmountOverride, approvedCodes, realSalesConfirmed, savedUnitMaster]);

  // 入力が変わったら結果を無効化する
  useEffect(() => {
    if (result) setStale(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.master, files.previous, files.orders, files.unitMaster, targetYm]);

  // 対象年月・マスタが変わったら、確定した売上は取り消す（再確定を求める。要件§11.6-8）
  useEffect(() => {
    setRealSalesConfirmed(null);
  }, [targetYm, masters]);

  /** 前月のリアル売上（大幅変動の警告 W031 に使う） */
  const previousReal = (() => {
    const p = salesHistory[previousYm(targetYm)];
    return p?.realSales && p.feeTotal && p.containerQty !== undefined
      ? { targetYm: previousYm(targetYm), realSales: p.realSales, feeTotal: p.feeTotal, containerQty: p.containerQty }
      : null;
  })();

  // STEP を移ったら画面の先頭へ戻す。下の方に表示されたまま次へ進むと、
  // その STEP の最初の操作を見落とすため（2026-10-26）
  useEffect(() => {
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      // scrollTo を持たない環境（画面テストなど）では何もしない
    }
  }, [step]);

  const canProceed = useMemo(() => Boolean(result) && !stale, [result, stale]);

  const setFile = (kind: FileKind, file: UploadedFile | null): void => {
    setFiles((prev) => ({ ...prev, [kind]: file }));
    // 単位計算マスタは登録しておき、翌月以降は指定しなくても使えるようにする
    if (kind === 'unitMaster' && file) setSavedUnitMaster(saveUnitMaster(file));
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>食品棚卸月次処理システム</h1>
        <div className="header-meta">
          <span className="header-ym">
            対象年月 <strong>{targetYm}</strong>
            <button type="button" className="linklike" onClick={() => setStep(1)}>
              STEP 1 で変更
            </button>
          </span>
          <label>
            ロール{' '}
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ width: 130 }}>
              <option value="ADMIN">管理者</option>
              <option value="STAFF">店舗担当者</option>
            </select>
          </label>
        </div>
      </header>

      <nav className="steps">
        {STEPS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={step === s.id ? 'step-tab active' : 'step-tab'}
            disabled={s.id > 1 && !result}
            onClick={() => setStep(s.id)}
          >
            <span className="num">STEP {s.id}</span>
            {s.label}
            <span className="num">{s.short}</span>
          </button>
        ))}
      </nav>

      {error ? (
        <div className="panel" style={{ borderColor: 'var(--blocking)' }}>
          <h2 style={{ color: 'var(--blocking)' }}>処理中にエラーが発生しました</h2>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{error}</pre>
        </div>
      ) : null}

      {stale && result ? (
        <div className="panel" style={{ borderColor: 'var(--warning)', background: 'var(--warning-weak)' }}>
          入力ファイルまたは対象年月が変更されました。前回の計算結果は無効です。
          <button type="button" className="primary" style={{ marginLeft: 12 }} onClick={() => void recalc()} disabled={running}>
            再計算する
          </button>
        </div>
      ) : null}

      {step === 1 ? (
        <StepUpload
          targetYm={targetYm}
          onSetTargetYm={setTargetYm}
          files={files}
          onSetFile={setFile}
          savedUnitMaster={savedUnitMaster}
          onClearSavedUnitMaster={() => {
            clearUnitMaster();
            setSavedUnitMaster(null);
          }}
          onRun={async () => {
            await recalc();
            setStep(2);
          }}
          running={running}
        />
      ) : null}

      {step === 2 && result ? (
        <StepMapping result={result} onNext={() => setStep(3)} canProceed={canProceed} />
      ) : null}

      {step === 3 && result ? (
        <StepDiff
          result={result}
          approvedCodes={approvedCodes}
          onApprove={(codes) => setApprovedCodes(codes)}
          onNext={() => setStep(4)}
        />
      ) : null}

      {step === 4 && result ? (
        <StepOwnPurchase
          result={result}
          entries={ownPurchases}
          onChange={setOwnPurchases}
          onNext={async () => {
            await recalc();
            setStep(5);
          }}
          running={running}
        />
      ) : null}

      {step === 5 && result ? (
        <StepSales
          targetYm={targetYm}
          role={role}
          masters={masters}
          onSetMasters={setMasters}
          confirmed={realSalesConfirmed}
          onConfirm={async (c) => {
            setRealSalesConfirmed(c);
            setSalesHistory(recordSales(targetYm, { realSales: c.realSales, feeTotal: c.feeTotal, containerQty: c.containerQty, confirmedAt: c.confirmedAt }));
            await recalc({ realSales: c });
          }}
          onUnconfirm={() => setRealSalesConfirmed(null)}
          previous={previousReal}
          masterC4={result.analysis.totalSales}
          onNext={async () => {
            await recalc();
            setStep(6);
          }}
          running={running}
        />
      ) : null}

      {step === 6 && result ? (
        <StepAnalyze
          result={result}
          role={role}
          targetYm={targetYm}
          previousYm={result.previousReport ? previousYm(targetYm) : null}
          lossAmountOverride={lossAmountOverride}
          onSetLossAmount={setLossAmountOverride}
          onRecalc={() => void recalc()}
          running={running}
          stale={stale}
        />
      ) : null}

      <DatabasePanel
        result={result}
        targetYm={targetYm}
        role={role}
        realSales={realSalesConfirmed}
        masters={masters}
        onOpened={({ masters: saved }) => {
          // 別のPCで .db を開いたときにも、料率・容器単価を引き継ぐ
          if (saved && saved.channels.length > 0 && masters.channels.length === 0) setMasters(saved);
        }}
      />

      <footer className="muted" style={{ fontSize: 12, padding: '8px 4px 24px' }}>
        すべての処理はこのブラウザ内で完結します。取り込んだファイルや原価データが外部へ送信されることはありません。
      </footer>
    </div>
  );
}
