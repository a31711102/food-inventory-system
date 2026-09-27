import { useMemo, useState } from 'react';
import { Panel, Note } from '../components';
import type { PipelineResult } from '../../app/pipeline';
import { searchOwnPurchaseCandidates } from '../../app/pipeline';
import type { OwnPurchaseInput, OwnPurchaseCandidate } from '../../domain/models';
import { formatAmount, formatQty } from '../format';

export function StepOwnPurchase({
  result,
  entries,
  onChange,
  onNext,
  running,
}: {
  result: PipelineResult;
  entries: OwnPurchaseInput[];
  onChange: (entries: OwnPurchaseInput[]) => void;
  onNext: () => void | Promise<void>;
  running: boolean;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<OwnPurchaseCandidate | null>(null);
  const [purchaseQty, setPurchaseQty] = useState('');
  const [closingQty, setClosingQty] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [note, setNote] = useState('');

  // 検索方法の選択欄は設けない（要件§7-4）。入力中に品名を部分一致検索する。
  const candidates = useMemo(
    () => searchOwnPurchaseCandidates(result.ownPurchaseCandidates, query, 50),
    [result.ownPurchaseCandidates, query],
  );

  const rowOf = (code: string) => result.rows.find((r) => r.code === code);

  const pick = (c: OwnPurchaseCandidate): void => {
    setSelected(c);
    setQuery(c.name);
    const existing = entries.find((e) => e.code === c.code);
    const row = rowOf(c.code);
    setPurchaseQty(String(existing?.purchaseQty ?? row?.purchaseQty ?? 0));
    setClosingQty(String(existing?.closingQty ?? row?.closingQty ?? 0));
    setUnitPrice(String(existing?.unitPrice ?? c.lastUnitPrice ?? row?.unitPrice ?? 0));
    setNote(existing?.note ?? '');
  };

  const reset = (): void => {
    setSelected(null);
    setQuery('');
    setPurchaseQty('');
    setClosingQty('');
    setUnitPrice('');
    setNote('');
  };

  const commit = (): void => {
    if (!selected) return;
    const entry: OwnPurchaseInput = {
      code: selected.code,
      purchaseQty: Number(purchaseQty) || 0,
      closingQty: Number(closingQty) || 0,
      unitPrice: Number(unitPrice) || 0,
      note: note || null,
    };
    const rest = entries.filter((e) => e.code !== entry.code);
    onChange([...rest, entry]);
    reset();
  };

  const remove = (code: string): void => {
    onChange(entries.filter((e) => e.code !== code));
  };

  const totalPurchase = entries.reduce((s, e) => s + e.purchaseQty * e.unitPrice, 0);
  const totalClosing = entries.reduce((s, e) => s + e.closingQty * e.unitPrice, 0);

  return (
    <>
      <Panel
        title="STEP 4　自店購入入力"
        hint="品名を入力すると、自店購入品として登録された商品を部分一致で検索します。候補から選んで数量と単価を入力してください。"
      >
        <Note>
          自店購入品は <strong>缶ビール・ミニトマト・キャベツ・コーラ160ml・レモンスライス</strong> の5品です（当月マスタに {result.ownPurchaseCandidates.length} 件）。 これらは本部発注ではないため発注累計照会に現れず、ここで入力しないと期中仕入が0のままになります。
          ここに出ない品目は自店購入品として登録されていません。品目が増えた場合は設定の追加が必要です。
        </Note>

        <label className="field">
          <span>品名（入力すると候補を検索します）</span>
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            placeholder="例: キャベツ"
          />
        </label>

        {!selected ? (
          <div className="candidate-list">
            {candidates.length === 0 ? (
              <div style={{ padding: '8px 10px' }} className="muted">
                該当する品目がありません。表記揺れは自動では吸収しないため、別の語で検索してください。
              </div>
            ) : (
              candidates.map((c) => (
                <button key={c.code} type="button" className="candidate" onClick={() => pick(c)}>
                  <span className="c-code">{c.code}</span>
                  {c.name}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    {c.category}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="panel" style={{ marginTop: 12, background: '#fcfdfe' }}>
            <h3 style={{ marginTop: 0 }}>
              <span className="mono">{selected.code}</span> {selected.name}
              <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
                集計先 {selected.category}
              </span>
            </h3>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label className="field">
                <span>期中仕入（数量）</span>
                <input type="number" step="any" value={purchaseQty} onChange={(e) => setPurchaseQty(e.target.value)} />
              </label>
              <label className="field">
                <span>期末在庫（数量）</span>
                <input type="number" step="any" value={closingQty} onChange={(e) => setClosingQty(e.target.value)} />
              </label>
              <label className="field">
                <span>単価（円）</span>
                <input type="number" step="any" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
              </label>
              <label className="field">
                <span>備考</span>
                <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
            </div>
            <div className="actions" style={{ marginTop: 0 }}>
              <button type="button" className="primary" onClick={commit}>
                この内容で登録
              </button>
              <button type="button" onClick={reset}>
                取り消す
              </button>
            </div>
          </div>
        )}

        <h3>入力済みの自店購入（{entries.length} 件）</h3>
        <div className="scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>商品コード</th>
                <th>商品名</th>
                <th>集計先</th>
                <th className="right">期中仕入</th>
                <th className="right">期末在庫</th>
                <th className="right">単価</th>
                <th className="right">仕入額</th>
                <th>備考</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={9} className="muted">
                    まだ入力がありません。入力しない場合は当月マスタの値がそのまま使われます。
                  </td>
                </tr>
              ) : (
                entries.map((e) => {
                  const row = rowOf(e.code);
                  return (
                    <tr key={e.code}>
                      <td className="code">{e.code}</td>
                      <td>{row?.name ?? '—'}</td>
                      <td>{row?.category ?? '—'}</td>
                      <td className="num">{formatQty(e.purchaseQty)}</td>
                      <td className="num">{formatQty(e.closingQty)}</td>
                      <td className="num">{formatAmount(e.unitPrice)}</td>
                      <td className="num">{formatAmount(e.purchaseQty * e.unitPrice)}</td>
                      <td>{e.note ?? ''}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`${e.code} の入力を削除します。よろしいですか？`)) remove(e.code);
                          }}
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {entries.length > 0 ? (
              <tfoot>
                <tr>
                  <th colSpan={6} className="right">
                    合計
                  </th>
                  <th className="right">{formatAmount(totalPurchase)}</th>
                  <th colSpan={2} className="right">
                    期末在庫高 {formatAmount(totalClosing)}
                  </th>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>

        <div className="actions">
          <button type="button" className="primary" onClick={() => void onNext()} disabled={running}>
            {running ? '再計算中…' : '計算して分析へ'}
          </button>
        </div>
      </Panel>
    </>
  );
}
