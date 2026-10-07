import { Panel, IssueList, IssueBadges, Note } from '../components';
import type { PipelineResult } from '../../app/pipeline';
import { formatAmount } from '../format';

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

  // 期中仕入は発注累計照会からこの時点で反映済み。自店購入だけが STEP 4 待ちになる。
  // プレビューの先頭3行がたまたま発注のない商品だと「反映されていない」と誤解されるため、
  // 全体の件数・金額を示し、プレビューも仕入のある行を優先して並べる。
  const purchasedRows = result.rows.filter((r) => r.purchaseQty > 0);
  const purchaseAmount = purchasedRows.reduce((sum, r) => sum + r.purchaseQty * r.unitPrice, 0);
  const ownPurchasePending = result.rows.filter((r) => r.isOwnPurchase && r.purchaseQty === 0).length;
  const previewRows = [
    ...purchasedRows.slice(0, 3),
    ...result.rows.filter((r) => r.purchaseQty <= 0).slice(0, Math.max(0, 3 - purchasedRows.length)),
  ];

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
              換算不能 {result.orderLines.filter((l) => l.convertedQty === null).length} 行／
              期中仕入に反映 {purchasedRows.length} 商品
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

        <Note>
          <strong>期中仕入は、発注累計照会からこの時点ですでに反映されています</strong>
          （{purchasedRows.length} 商品・合計 {formatAmount(purchaseAmount)} 円）。
          発注のなかった商品は 0 のままで、これは正常です。
          {ownPurchasePending > 0 ? (
            <>
              {' '}
              ただし<strong>自店購入品 {ownPurchasePending} 件</strong>は発注累計に現れないため、
              まだ 0 です。これらは STEP 4 で入力したあとに入ります。
            </>
          ) : null}
        </Note>

        <h3>
          取込プレビュー（
          {purchasedRows.length > 0 ? '期中仕入のある行を優先して3行' : '先頭3行'}）
        </h3>
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
              {previewRows.map((r) => (
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
