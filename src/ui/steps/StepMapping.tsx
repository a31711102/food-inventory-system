import { Panel, IssueList, IssueBadges, Note } from '../components';
import type { PipelineResult } from '../../app/pipeline';

export function StepMapping({
  result,
  onNext,
  canProceed,
}: {
  result: PipelineResult;
  onNext: () => void;
  canProceed: boolean;
}): JSX.Element {
  const blocking = result.issues.filter((i) => i.level === 'BLOCKING');
  // I001 は1件のメッセージにまとめてあるので、件数は count の合計で数える
  const codeTypeCount = result.issues
    .filter((i) => i.code === 'I001')
    .reduce((sum, i) => sum + i.count, 0);

  return (
    <>
      <Panel
        title="STEP 2　列設定と取込結果"
        hint="列の対応づけとサンプル値を確認します。同名の列があるだけで自動採用はしません。"
      >
        <IssueBadges issues={result.issues} />

        <div className="kpi-row">
          <div className="kpi">
            <div className="kpi-label">取り込んだ商品</div>
            <div className="kpi-value">{result.rows.length} 件</div>
            <div className="kpi-note">
              うち自店購入 {result.rows.filter((r) => r.isOwnPurchase).length} 件／
              備品（計算対象外） {result.rows.filter((r) => r.isSupply).length} 件
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-label">前月データ</div>
            <div className="kpi-value">{result.previousEntries.length} 件</div>
            <div className="kpi-note">{result.previousEntries.length === 0 ? '未指定（比較不可）' : '引継ぎ元として使用'}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">発注明細</div>
            <div className="kpi-value">{result.orderLines.length} 行</div>
            <div className="kpi-note">
              換算不能 {result.orderLines.filter((l) => l.convertedQty === null).length} 行
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-label">単位計算マスタ</div>
            <div className="kpi-value">{result.unitMaster.size} 件</div>
            <div className="kpi-note">換算係数の検証に使用</div>
          </div>
        </div>

        {codeTypeCount > 0 ? (
          <Note variant="warn">
            商品コードが数値型で格納されている行が {codeTypeCount} 件あります。先頭ゼロが失われている可能性があるため、
            元ファイルのセル書式を「文字列」に変更することを推奨します。システム側では6桁へ復元して突合しています。
          </Note>
        ) : null}

        <h3>取込プレビュー（先頭3行）</h3>
        <div className="scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>商品コード</th>
                <th>商品名</th>
                <th>分類</th>
                <th className="right">単価</th>
                <th className="right">仕入れ単位</th>
                <th className="right">期首在庫</th>
                <th className="right">期中仕入</th>
                <th className="right">期末在庫</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 3).map((r) => (
                <tr key={r.code}>
                  <td className="code">{r.code}</td>
                  <td>{r.name}</td>
                  <td>{r.category}</td>
                  <td className="num">{r.unitPrice}</td>
                  <td className="num">{r.conversionFactor}</td>
                  <td className="num">{r.openingQty}</td>
                  <td className="num">{r.purchaseQty}</td>
                  <td className="num">{r.closingQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>エラー（出力を止めるもの）</h3>
        <IssueList issues={result.issues} levels={['BLOCKING']} emptyText="エラーはありません。" />

        <h3>警告（確認のうえ出力できるもの）</h3>
        <IssueList issues={result.issues} levels={['WARNING']} limit={50} emptyText="警告はありません。" />

        <div className="actions">
          <button type="button" className="primary" onClick={onNext} disabled={!canProceed}>
            商品差分の確認へ
          </button>
          {blocking.length > 0 ? (
            <span className="muted">
              エラーが {blocking.length} 件あります。このまま進めますが、Excel出力はできません。
            </span>
          ) : null}
        </div>
      </Panel>

      <Panel title="情報ログ" hint="正規化や無視した列など、記録のみの項目です。">
        <IssueList issues={result.issues} levels={['INFO']} limit={30} emptyText="情報ログはありません。" />
      </Panel>
    </>
  );
}
