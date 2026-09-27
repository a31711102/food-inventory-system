import { useMemo, useState } from 'react';
import { Panel, Note, IssueList, IssueBadges, Kpi } from '../components';
import type { PipelineResult } from '../../app/pipeline';
import { describeLevel, LEVEL_TARGET_PERCENT } from '../../domain/anomaly';
import { exportWorkbook, ExportBlockedError } from '../../export/exporter';
import { HQ_MASTER_PROFILE } from '../../ingest/profiles';
import { downloadWorkbook } from '../../storage/fileSystem';
import type { Role } from '../App';
import { formatAmount, formatAmountPrecise, formatDiff, formatPercent, formatQty, formatRate } from '../format';

type ProductFilter = 'ALL' | 'CONTINUED' | 'NEW' | 'DELETED';

export function StepAnalyze({
  result,
  role,
  targetYm,
  previousYm,
  totalSalesOverride,
  lossAmountOverride,
  onSetTotalSales,
  onSetLossAmount,
  onRecalc,
  running,
  stale,
}: {
  result: PipelineResult;
  role: Role;
  targetYm: string;
  previousYm: string | null;
  totalSalesOverride: number | null;
  lossAmountOverride: number | null;
  onSetTotalSales: (v: number | null) => void;
  onSetLossAmount: (v: number | null) => void;
  onRecalc: () => void | Promise<void>;
  running: boolean;
  stale: boolean;
}): JSX.Element {
  const [filter, setFilter] = useState<ProductFilter>('ALL');
  const [query, setQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedName, setExportedName] = useState<string | null>(null);

  const { report, anomalies } = result;
  const blocking = result.issues.filter((i) => i.level === 'BLOCKING');
  const level = describeLevel(report.costRateAfterLossPercent);
  const overallAnomaly = anomalies.some((a) => a.scope === 'OVERALL');

  const productRows = useMemo(() => {
    const key = query.trim().toLowerCase();
    return result.productDiffs
      .filter((d) => (filter === 'ALL' ? true : d.status === filter))
      .filter(
        (d) =>
          key === '' ||
          d.code.toLowerCase().includes(key) ||
          (d.currentName ?? d.previousName ?? '').toLowerCase().includes(key),
      )
      .sort((a, b) => Math.abs(b.metrics.usageAmount.diff ?? 0) - Math.abs(a.metrics.usageAmount.diff ?? 0))
      .slice(0, 400);
  }, [result.productDiffs, filter, query]);

  const doExport = async (): Promise<void> => {
    setExporting(true);
    setExportError(null);
    try {
      const out = await exportWorkbook({
        workbook: result.masterWorkbook,
        profile: HQ_MASTER_PROFILE,
        targetYm,
        previousYm,
        rows: result.rows,
        report: result.report,
        productDiffs: result.productDiffs,
        reportDiffs: result.reportDiffs,
        anomalies: result.anomalies,
        issues: result.issues,
      });
      downloadWorkbook(out.bytes, out.fileName);
      setExportedName(out.fileName);
    } catch (e) {
      setExportError(
        e instanceof ExportBlockedError ? e.message : e instanceof Error ? e.message : String(e),
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Panel title="STEP 5　分析・出力" hint="計算結果と前月比較を確認し、完成Excelをダウンロードします。">
        <IssueBadges issues={result.issues} />

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <label className="field">
            <span>当月売上高（未入力ならファイルの値を使用）</span>
            <input
              type="number"
              step="any"
              value={totalSalesOverride ?? ''}
              placeholder={result.analysis.totalSales === null ? '未設定' : String(result.analysis.totalSales)}
              onChange={(e) => onSetTotalSales(e.target.value === '' ? null : Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>ロス額（通常は空欄）</span>
            <input
              type="number"
              step="any"
              value={lossAmountOverride ?? ''}
              placeholder="0"
              onChange={(e) => onSetLossAmount(e.target.value === '' ? null : Number(e.target.value))}
            />
          </label>
          <div style={{ alignSelf: 'end', marginBottom: 12 }}>
            <button type="button" onClick={() => void onRecalc()} disabled={running}>
              {running ? '再計算中…' : '再計算'}
            </button>
          </div>
        </div>

        <div className="kpi-row">
          <Kpi label="当月売上高" value={report.totalSales === null ? '未設定' : `${formatAmount(report.totalSales)} 円`} />
          <Kpi
            label="使用高合計"
            value={`${formatAmount(report.totalUsageAmount)} 円`}
            note="ガチャ玉・靴他を除く15分類"
          />
          <Kpi label="ロス引き後原価" value={`${formatAmount(report.costAfterLoss)} 円`} note={`ロス額 ${formatAmount(report.lossAmount)} 円`} />
          <Kpi
            label="ロス引き後原価率"
            value={formatPercent(report.costRateAfterLossPercent)}
            note={overallAnomaly ? '▲ 前月比で異常あり' : previousYm ? '前月比は閾値内' : '前月データなし'}
            alert={overallAnomaly}
          />
          <Kpi label="食材期末在庫計" value={`${formatAmount(report.totalClosingAmount)} 円`} />
          <Kpi label="サラダ野菜使用高" value={`${formatAmount(report.saladVegetableUsage)} 円`} note="野菜分類の使用高" />
        </div>

        {Object.keys(report.unavailableReasons).length > 0 ? (
          <Note variant="warn">
            {Object.entries(report.unavailableReasons).map(([k, v]) => (
              <div key={k}>{v}</div>
            ))}
          </Note>
        ) : null}
      </Panel>

      <Panel
        title="異常判定（前月比）"
        hint="前月からのパーセントポイント差が閾値を超えた指標を表示します。Release 1 では原因推定は行いません。"
      >
        {!previousYm ? (
          <p className="muted">前月データがないため比較できません。当月値のみ表示しています。</p>
        ) : anomalies.length === 0 ? (
          <p className="muted">閾値（2.0pt）を超える変動はありません。</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>区分</th>
                <th>指標</th>
                <th className="right">前月</th>
                <th className="right">当月</th>
                <th className="right">差</th>
                <th className="right">閾値</th>
              </tr>
            </thead>
            <tbody>
              {anomalies.map((a, i) => (
                <tr key={`${a.scope}-${a.category ?? 'all'}-${i}`} className="anomaly">
                  <td>{a.scope === 'OVERALL' ? '全体' : a.displayName}</td>
                  <td>{a.metric === 'COST_RATE_AFTER_LOSS' ? 'ロス引き後原価率' : '原価率'}</td>
                  <td className="num">{formatPercent(a.previousPercent)}</td>
                  <td className="num">{formatPercent(a.currentPercent)}</td>
                  <td className="num">{formatDiff(a.diffPt, 'pt')}</td>
                  <td className="num">{a.thresholdPt.toFixed(1)}pt</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {/* 水準の目安は異常判定と別セクションに分けて表示する（要件§6） */}
      <Panel
        title="水準の目安（参考）"
        hint="運用上の目安であり、前月比による異常判定とは無関係です。ここでの乖離は異常ではありません。"
      >
        <p>
          ロス引き後原価率 <strong>{formatPercent(report.costRateAfterLossPercent)}</strong>／目安 {LEVEL_TARGET_PERCENT}%
          　判定: <strong>{level.label}</strong>
          {level.deltaFromTargetPt !== null ? `（目安との差 ${formatDiff(level.deltaFromTargetPt, 'pt')}）` : ''}
        </p>
      </Panel>

      <Panel title="レポート比較（前月比）" hint="金額の差は円、率の差はパーセントポイント（pt）で表示します。">
        <div className="scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>区分</th>
                <th>指標</th>
                <th className="right">前月</th>
                <th className="right">当月</th>
                <th className="right">差</th>
                <th>単位</th>
                <th>合計対象</th>
                <th>判定</th>
              </tr>
            </thead>
            <tbody>
              {result.reportDiffs.map((d, i) => (
                <tr key={`${d.scope}-${d.category ?? ''}-${d.metric}-${i}`} className={d.isAnomaly ? 'anomaly' : undefined}>
                  <td>{d.scope === 'OVERALL' ? '全体' : d.displayName}</td>
                  <td>{d.metricLabel}</td>
                  <td className="num">
                    {d.unit === 'pt' ? formatPercent(d.previous) : d.previous === null ? '—' : formatAmount(d.previous)}
                  </td>
                  <td className="num">
                    {d.unit === 'pt' ? formatPercent(d.current) : d.current === null ? '—' : formatAmount(d.current)}
                  </td>
                  <td className="num">{formatDiff(d.diff, d.unit)}</td>
                  <td>{d.unit}</td>
                  <td>{d.includedInTotal ? '○' : '×'}</td>
                  <td>{d.isAnomaly ? '▲異常' : d.comparable ? '' : '比較不可'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="商品別比較（前月比）" hint="差額の大きい順に表示します。新規・削除はゼロと同一視せず状態として示します。">
        <div className="filters">
          <label className="field">
            <span>状態</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as ProductFilter)}>
              <option value="ALL">すべて</option>
              <option value="CONTINUED">継続</option>
              <option value="NEW">新規</option>
              <option value="DELETED">削除</option>
            </select>
          </label>
          <label className="field">
            <span>商品コード・商品名</span>
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="部分一致" />
          </label>
        </div>

        <div className="scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>状態</th>
                <th>商品コード</th>
                <th>商品名</th>
                <th className="right">期末(前)</th>
                <th className="right">期末(当)</th>
                <th className="right">使用高(前)</th>
                <th className="right">使用高(当)</th>
                <th className="right">差額</th>
                <th className="right">差率</th>
              </tr>
            </thead>
            <tbody>
              {productRows.map((d) => (
                <tr key={d.code}>
                  <td className="nowrap">
                    {d.status === 'CONTINUED' ? '継続' : d.status === 'NEW' ? '新規' : '削除'}
                  </td>
                  <td className="code">{d.code}</td>
                  <td>{d.currentName ?? d.previousName}</td>
                  <td className="num">{d.metrics.closingQty.previous === null ? '—' : formatQty(d.metrics.closingQty.previous)}</td>
                  <td className="num">{d.metrics.closingQty.current === null ? '—' : formatQty(d.metrics.closingQty.current)}</td>
                  <td className="num">{d.metrics.usageAmount.previous === null ? '—' : formatAmountPrecise(d.metrics.usageAmount.previous)}</td>
                  <td className="num">{d.metrics.usageAmount.current === null ? '—' : formatAmountPrecise(d.metrics.usageAmount.current)}</td>
                  <td className="num">{formatDiff(d.metrics.usageAmount.diff, '円')}</td>
                  <td className="num">{d.metrics.usageAmount.diffRatePercent === null ? '算出不可' : formatRate(d.metrics.usageAmount.diffRatePercent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {result.productDiffs.length > productRows.length ? (
          <p className="muted">表示は上位 {productRows.length} 件です（全 {result.productDiffs.length} 件）。</p>
        ) : null}
      </Panel>

      <Panel title="未解決のエラー" hint="1件でも残っていると、誤った完成Excelを配布しないため出力できません。">
        <IssueList issues={result.issues} levels={['BLOCKING']} emptyText="未解決のエラーはありません。" />
      </Panel>

      <Panel title="完成Excelの出力" hint="当月本部マスタをテンプレートとし、入力セルだけを書き戻します。数式・書式・印刷範囲はそのまま保たれます。">
        {blocking.length > 0 ? (
          <Note variant="warn">
            エラーが {blocking.length} 件あるため出力できません。上の「未解決のエラー」を解消してください。
          </Note>
        ) : stale ? (
          <Note variant="warn">入力が変更されています。再計算してから出力してください。</Note>
        ) : (
          <Note>
            書き戻すのは 期末在庫・期中仕入・期首在庫・単価（自店購入品のみ）・当月売上高・ロス額 だけです。
            期中使用量や原価率はExcelの数式が計算するため、ファイルを開いた時点で自動的に再計算されます。
          </Note>
        )}

        {exportError ? (
          <div className="issue BLOCKING">
            <div className="issue-head">出力できませんでした</div>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{exportError}</pre>
          </div>
        ) : null}

        {exportedName ? (
          <p className="muted">
            出力しました: <span className="mono">{exportedName}</span>
          </p>
        ) : null}

        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => void doExport()}
            disabled={blocking.length > 0 || stale || exporting}
          >
            {exporting ? '出力中…' : '完成Excelをダウンロード'}
          </button>
          {role !== 'ADMIN' ? (
            <span className="muted">最終確定版として記録する操作は管理者ロールでのみ行えます。</span>
          ) : null}
        </div>
      </Panel>
    </>
  );
}
