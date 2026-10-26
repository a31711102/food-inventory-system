import { useMemo, useState } from 'react';
import { Panel, Note, IssueList } from '../components';
import type { PipelineResult } from '../../app/pipeline';
import { formatQty } from '../format';

type Filter = 'ALL' | 'NEW' | 'DELETED' | 'NAME_CHANGED' | 'CATEGORY_CHANGED';

export function StepDiff({
  result,
  approvedCodes,
  onApprove,
  onNext,
}: {
  result: PipelineResult;
  approvedCodes: Set<string>;
  onApprove: (codes: Set<string>) => void;
  onNext: () => void;
}): JSX.Element {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [query, setQuery] = useState('');

  const pending = result.factorConfirmations;
  const pendingWithOrder = pending.filter((f) => f.hasOrder);

  const nameChanged = result.productDiffs.filter((d) => d.nameChanged);
  const categoryChanged = result.productDiffs.filter((d) => d.categoryChanged);
  const continued = result.rows.length - result.newProducts.length;

  const visible = useMemo(() => {
    const key = query.trim().toLowerCase();
    const matches = (code: string, name: string): boolean =>
      key === '' || code.toLowerCase().includes(key) || name.toLowerCase().includes(key);

    switch (filter) {
      case 'NEW':
        return result.newProducts.filter((r) => matches(r.code, r.name)).map((r) => ({
          kind: '新規' as const,
          code: r.code as string,
          name: r.name,
          category: r.category,
          prevClosing: null as number | null,
        }));
      case 'DELETED':
        return result.deletedProducts.filter((r) => matches(r.code, r.name)).map((r) => ({
          kind: '削除' as const,
          code: r.code as string,
          name: r.name,
          category: r.category,
          prevClosing: r.closingQty,
        }));
      case 'NAME_CHANGED':
        return nameChanged.filter((d) => matches(d.code, d.currentName ?? '')).map((d) => ({
          kind: '商品名変更' as const,
          code: d.code as string,
          name: `${d.previousName} → ${d.currentName}`,
          category: d.currentCategory ?? '',
          prevClosing: null,
        }));
      case 'CATEGORY_CHANGED':
        return categoryChanged.filter((d) => matches(d.code, d.currentName ?? '')).map((d) => ({
          kind: '分類変更' as const,
          code: d.code as string,
          name: d.currentName ?? '',
          category: `${d.previousCategory} → ${d.currentCategory}`,
          prevClosing: null,
        }));
      default:
        return [
          ...result.newProducts.map((r) => ({
            kind: '新規' as const,
            code: r.code as string,
            name: r.name,
            category: r.category,
            prevClosing: null as number | null,
          })),
          ...result.deletedProducts.map((r) => ({
            kind: '削除' as const,
            code: r.code as string,
            name: r.name,
            category: r.category,
            prevClosing: r.closingQty,
          })),
        ].filter((r) => matches(r.code, r.name));
    }
  }, [filter, query, result, nameChanged, categoryChanged]);

  const toggle = (code: string): void => {
    const next = new Set(approvedCodes);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onApprove(next);
  };

  const approveAll = (): void => {
    onApprove(new Set(result.newProducts.map((r) => r.code as string)));
  };

  const unapprovedCount = result.newProducts.filter((r) => !approvedCodes.has(r.code)).length;

  return (
    <>
      <Panel
        title="STEP 3　商品差分確認"
        hint="前月と当月の商品構成の違いを確認します。新規商品の期首在庫0は、承認するまで確定しません。"
      >
        <div className="badges">
          <span className="badge ok">継続 {continued} 件</span>
          <span className="badge">新規 {result.newProducts.length} 件</span>
          <span className="badge">削除 {result.deletedProducts.length} 件</span>
          <span className="badge">商品名変更 {nameChanged.length} 件</span>
          <span className="badge">分類変更 {categoryChanged.length} 件</span>
        </div>

        {result.previousEntries.length === 0 ? (
          <Note variant="warn">
            前月食品棚卸表が指定されていないため、全商品が新規として扱われています。期首在庫はすべて0です。
          </Note>
        ) : null}

        {result.newProducts.length > 0 ? (
          <Note variant={unapprovedCount > 0 ? 'warn' : 'info'}>
            新規商品 {result.newProducts.length} 件の期首在庫を <strong>0</strong> として提示しています。
            {unapprovedCount > 0 ? (
              <>
                {' '}
                未承認が {unapprovedCount} 件あります。承認するまで Excel 出力はできません。
                <button type="button" style={{ marginLeft: 12 }} onClick={approveAll}>
                  すべて承認する
                </button>
              </>
            ) : (
              ' すべて承認済みです。'
            )}
          </Note>
        ) : null}

        <div className="filters">
          <label className="field">
            <span>絞り込み</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="ALL">新規・削除</option>
              <option value="NEW">新規のみ</option>
              <option value="DELETED">削除のみ</option>
              <option value="NAME_CHANGED">商品名変更</option>
              <option value="CATEGORY_CHANGED">分類変更</option>
            </select>
          </label>
          <label className="field">
            <span>商品コード・商品名で検索</span>
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
                <th>分類</th>
                <th className="right">前月期末残</th>
                <th>期首0の承認</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    該当する商品はありません。
                  </td>
                </tr>
              ) : (
                visible.map((r) => (
                  <tr key={`${r.kind}-${r.code}`} className={r.kind === '削除' && r.prevClosing ? 'anomaly' : undefined}>
                    <td className="nowrap">{r.kind}</td>
                    <td className="code">{r.code}</td>
                    <td>{r.name}</td>
                    <td>{r.category}</td>
                    <td className="num">{r.prevClosing === null ? '—' : formatQty(r.prevClosing)}</td>
                    <td>
                      {r.kind === '新規' ? (
                        <label>
                          <input
                            type="checkbox"
                            checked={approvedCodes.has(r.code)}
                            onChange={() => toggle(r.code)}
                          />{' '}
                          承認
                        </label>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="actions">
          <button type="button" className="primary" onClick={onNext}>
            自店購入入力へ
          </button>
        </div>
      </Panel>

      {pending.length > 0 ? (
        <Panel
          title="換算係数が足りない商品"
          hint="単位計算マスタに計算単位が無い商品です。発注数を棚卸単位へ換算できないため、期中仕入に反映できません。"
        >
          <Note variant={pendingWithOrder.length > 0 ? 'warn' : 'info'}>
            {pendingWithOrder.length > 0 ? (
              <>
                <strong>{pendingWithOrder.length} 件は当月に発注があり</strong>、期中仕入に直接影響します。
                単位計算マスタにこれらの商品を追加し、STEP 1 の④で入れ直してください。
              </>
            ) : (
              <>当月に発注のある商品はありません。次月以降に備えて、単位計算マスタへの追加を本部に依頼してください。</>
            )}
          </Note>

          <div className="scroll" style={{ maxHeight: 320 }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>発注</th>
                  <th>商品コード</th>
                  <th>商品名</th>
                  <th>分類</th>
                  <th>棚卸単位</th>
                  <th className="right">発注数</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((f) => (
                  <tr key={f.code} className={f.hasOrder ? 'anomaly' : undefined}>
                    <td className="nowrap">{f.hasOrder ? '▲あり' : '—'}</td>
                    <td className="code">{f.code}</td>
                    <td>{f.name}</td>
                    <td>{f.category}</td>
                    <td>{f.inventoryUnit ?? '—'}</td>
                    <td className="num">{f.orderQty === null ? '—' : formatQty(f.orderQty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel title="差分に関する警告" hint="削除商品の残在庫や属性変更など、確認が必要な項目です。">
        <IssueList
          issues={result.issues.filter((i) =>
            ['W001', 'W002', 'W003', 'W004', 'W016', 'W018', 'W019'].includes(i.code),
          )}
          levels={['WARNING']}
          limit={100}
          emptyText="差分に関する警告はありません。"
        />
      </Panel>
    </>
  );
}
