import { useMemo, useState } from 'react';
import { Panel, Note } from '../components';
import type { PipelineResult } from '../../app/pipeline';
import { searchOwnPurchaseCandidates } from '../../app/pipeline';
import type { OwnPurchaseInput, OwnPurchaseCandidate } from '../../domain/models';
import { formatAmount } from '../format';

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
  const [usageAmount, setUsageAmount] = useState('');
  const [note, setNote] = useState('');

  const registeredCount = result.ownPurchaseCandidates.filter((c) => c.registered).length;
  /** 登録外の品目には理由を残してもらう。翌月「なぜ入れたのか」を追えるようにするため */
  const needsNote = selected !== null && !selected.registered;
  const canCommit = selected !== null && Number(usageAmount) > 0 && (!needsNote || note.trim() !== '');

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
    setUsageAmount(existing === undefined ? '' : String(existing.usageAmount));
    setNote(existing?.note ?? '');
  };

  const reset = (): void => {
    setSelected(null);
    setQuery('');
    setUsageAmount('');
    setNote('');
  };

  const commit = (): void => {
    if (!selected || !canCommit) return;
    const entry: OwnPurchaseInput = {
      code: selected.code,
      usageAmount: Number(usageAmount) || 0,
      note: note || null,
    };
    const rest = entries.filter((e) => e.code !== entry.code);
    onChange([...rest, entry]);
    reset();
  };

  const remove = (code: string): void => {
    onChange(entries.filter((e) => e.code !== code));
  };

  const totalAmount = entries.reduce((s, e) => s + e.usageAmount, 0);
  /** 本部発注から求まっている当月使用高。金額を入れるとこの行は置き換わる */
  const currentUsage = (code: string): number | null => rowOf(code)?.usageAmount ?? null;

  return (
    <>
      <Panel
        title="STEP 4　自店購入入力"
        hint="品名を入力すると当月マスタの全商品を部分一致で検索します。候補から選んで、その商品に使った合計金額を入れてください。"
      >
        <Note>
          <strong>入力するのは「その商品に使った合計金額」だけです。</strong>
          数量と単価は聞きません（2026-10-30 変更）。レシートの合計をそのまま入れてください。
          入れた金額がその商品の<strong>当月使用高</strong>になり、期末在庫は0（使い切り）として扱います。
        </Note>
        <Note>
          自店購入品として登録されているのは
          <strong>缶ビール・ミニトマト・キャベツ・レモンスライス</strong> の4品です。
          このうち当月マスタにあるのは <strong>{registeredCount} 件</strong>で、
          候補の先頭に <span className="tag-reg">登録済</span> つきで出ます。
          これらは本部発注ではないため発注累計照会に現れず、ここで入力しないと使用高が0のままになります。
        </Note>
        <Note>
          <strong>登録外の商品も入力できます。</strong>
          発注累計にも登録リストにも無いのに店舗が購入した品（炭酸水・ガムシロップなど）や、
          本部発注でも通常と違う方法で納品され発注累計に載らなかった品がこれにあたります。
          入力するときは<strong>理由を備考に残してください</strong>。指摘一覧に情報として記録され、
          翌月以降に登録すべき品かどうかを判断できます。
          備品（コードの数字が5桁）は「この棚卸表で計算しない」取り決めのため候補に出ません。
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
                  {c.registered ? <span className="tag-reg">登録済</span> : null}
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
              <span className="mono">{selected.code}</span>{' '}
              {selected.registered ? <span className="tag-reg">登録済</span> : <span className="tag-unreg">登録外</span>}{' '}
              {selected.name}
              <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
                集計先 {selected.category}
              </span>
            </h3>
            {needsNote ? (
              <Note variant="warn">
                自店購入品として登録されていない商品です。入力できますが、
                <strong>なぜ自店購入として計上するのか</strong>を備考に残してください（必須）。
              </Note>
            ) : null}
            {currentUsage(selected.code) ? (
              <Note variant="warn">
                この商品は発注累計から当月使用高 <strong>{formatAmount(currentUsage(selected.code))} 円</strong> が求まっています。
                金額を入れると<strong>その金額に置き換わります</strong>。本部発注の分も含めた合計を入れてください。
              </Note>
            ) : null}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label className="field">
                <span>使った合計金額（円）</span>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={usageAmount}
                  onChange={(e) => setUsageAmount(e.target.value)}
                  placeholder="例: 6006"
                />
              </label>
              <label className="field">
                <span>備考{needsNote ? '（必須）' : ''}</span>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={needsNote ? '例: 近隣スーパーで購入' : ''}
                />
              </label>
            </div>
            <div className="actions" style={{ marginTop: 0 }}>
              <button type="button" className="primary" onClick={commit} disabled={!canCommit}>
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
                <th>登録</th>
                <th>集計先</th>
                <th className="right">使った合計金額</th>
                <th>備考</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
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
                      <td>
                        {row?.isOwnPurchase ? (
                          <span className="tag-reg">登録済</span>
                        ) : (
                          <span className="tag-unreg">登録外</span>
                        )}
                      </td>
                      <td>{row?.category ?? '—'}</td>
                      <td className="num">{formatAmount(e.usageAmount)}</td>
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
                  <th colSpan={4} className="right">
                    合計
                  </th>
                  <th className="right">{formatAmount(totalAmount)}</th>
                  <th colSpan={2} />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>

        <div className="actions">
          <button type="button" className="primary" onClick={() => void onNext()} disabled={running}>
            {running ? '再計算中…' : '次へ：売上計算'}
          </button>
        </div>
      </Panel>
    </>
  );
}
