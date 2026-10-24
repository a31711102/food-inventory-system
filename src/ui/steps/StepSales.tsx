/**
 * STEP 5 売上確定（要件§11.6）。
 *
 * 手入力方式（従来どおり分析用 C4 ＝ 総計1）か、リアル売上方式かを選ぶ。
 * リアル売上方式では、ジャーナル写真を端末内で読み取り、商品別売上CSVから容器対象出数を数え、
 * 料率・容器単価を当てて「食材費計算用リアル売上」を出す。
 *
 * 読み取り値は候補であり、写真の該当行と並べて照合し、人が確定する。
 * 検算（①売掛合計・②CSV）が合わない・補正した・消去法で決めた項目は目立たせる。
 * 写真・CSV・読取値・マスタのどれかが変われば確定を取り消す（§11.6-8）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, Note, IssueList, FileSlot } from '../components';
import type { Role } from '../App';
import type { ConfirmedRealSales, SalesMethod, UploadedFile } from '../../app/pipeline';
import { computeRealSales, type JournalEntry, type PreviousRealSales, type ReceivableLine } from '../../domain/realSales/compute';
import { toDecimalString, type Fixed } from '../../domain/realSales/fixed';
import { channelRow, EPOCH_YM, KNOWN_CHANNELS, resolveMasters, type RealSalesMasters } from '../../domain/realSales/masters';
import { importMastersFromWorkbook } from '../../domain/realSales/masterImport';
import { extractContainerQty, readProductSalesCsv } from '../../domain/realSales/productSalesCsv';
import { mapFields, type FieldReading, type JournalOcrResult, type LabelGroup, type ReceivableReading } from '../../ocr/journalOcr';

const yen = (f: Fixed | string | null | undefined): string => {
  if (f === null || f === undefined || f === '') return '—';
  const s = typeof f === 'string' ? f : toDecimalString(f);
  const [i, d] = s.split('.');
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${d ? `.${d}` : ''}`;
};

type FieldKey = 'businessYm' | 'grossTotal' | 'discountTotal' | 'discountTax' | 'receivableTotal';
const FIELD_LABELS: Record<FieldKey, string> = {
  businessYm: '営業月',
  grossTotal: '総計1（税抜値割引前）',
  discountTotal: '値割引合計',
  discountTax: '（値割引消費税）',
  receivableTotal: '売掛（合計）',
};

const SOURCE_TEXT: Record<FieldReading['source'], { text: string; cls: string }> = {
  checked: { text: '検算で確認', cls: 'tag-reg' },
  corrected: { text: '検算で補正・要確認', cls: 'tag-unreg' },
  ocr: { text: '読取', cls: 'tag-plain' },
  none: { text: '読めず・要入力', cls: 'tag-unreg' },
};

export function StepSales({
  targetYm,
  role,
  method,
  onSetMethod,
  masters,
  onSetMasters,
  confirmed,
  onConfirm,
  onUnconfirm,
  previous,
  masterC4,
  onNext,
  running,
}: {
  targetYm: string;
  role: Role;
  method: SalesMethod;
  onSetMethod: (m: SalesMethod) => void;
  masters: RealSalesMasters;
  onSetMasters: (m: RealSalesMasters) => void;
  confirmed: ConfirmedRealSales | null;
  onConfirm: (c: ConfirmedRealSales) => void | Promise<void>;
  onUnconfirm: () => void;
  previous: PreviousRealSales | null;
  masterC4: number | null;
  onNext: () => void | Promise<void>;
  running: boolean;
}): JSX.Element {
  return (
    <>
      <Panel title="STEP 5　売上確定" hint="原価率の分母にする当月売上高を決めます。">
        <div className="method-choice">
          <label className={method === 'manual' ? 'method active' : 'method'}>
            <input type="radio" name="sales-method" checked={method === 'manual'} onChange={() => onSetMethod('manual')} />
            <span>
              <strong>手入力方式</strong>（これまでどおり）
              <br />
              <span className="muted">当月本部マスタの分析用 C4（総計1）を使います。空なら次の画面で入力します。</span>
            </span>
          </label>
          <label className={method === 'real' ? 'method active' : 'method'}>
            <input type="radio" name="sales-method" checked={method === 'real'} onChange={() => onSetMethod('real')} />
            <span>
              <strong>リアル売上方式</strong>
              <br />
              <span className="muted">総計1 − 代行手数料 − 弁当容器代。ジャーナル写真と商品別売上CSVから計算します。</span>
            </span>
          </label>
        </div>

        {method === 'manual' ? (
          <>
            <Note>
              当月本部マスタの当月売上高（分析用 C4）は <strong>{masterC4 === null ? '未入力' : `${masterC4.toLocaleString('ja-JP')} 円`}</strong> です。
              {masterC4 === null ? ' 次の画面（分析・出力）で入力してください。' : ''}
            </Note>
            <div className="actions">
              <button type="button" className="primary" onClick={() => void onNext()} disabled={running}>
                {running ? '再計算中…' : '計算して分析へ'}
              </button>
            </div>
          </>
        ) : null}
      </Panel>

      {method === 'real' ? (
        <RealSalesForm
          targetYm={targetYm}
          role={role}
          masters={masters}
          onSetMasters={onSetMasters}
          confirmed={confirmed}
          onConfirm={onConfirm}
          onUnconfirm={onUnconfirm}
          previous={previous}
          masterC4={masterC4}
          onNext={onNext}
          running={running}
        />
      ) : null}
    </>
  );
}

function RealSalesForm({
  targetYm,
  role,
  masters,
  onSetMasters,
  confirmed,
  onConfirm,
  onUnconfirm,
  previous,
  masterC4,
  onNext,
  running,
}: {
  targetYm: string;
  role: Role;
  masters: RealSalesMasters;
  onSetMasters: (m: RealSalesMasters) => void;
  confirmed: ConfirmedRealSales | null;
  onConfirm: (c: ConfirmedRealSales) => void | Promise<void>;
  onUnconfirm: () => void;
  previous: PreviousRealSales | null;
  masterC4: number | null;
  onNext: () => void | Promise<void>;
  running: boolean;
}): JSX.Element {
  const [photo, setPhoto] = useState<(UploadedFile & { url: string }) | null>(null);
  const [csv, setCsv] = useState<UploadedFile | null>(null);
  const [ocr, setOcr] = useState<JournalOcrResult | null>(null);
  const [ocrState, setOcrState] = useState<{ phase: 'idle' | 'running' | 'done' | 'error'; done?: number; total?: number; message?: string }>({ phase: 'idle' });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [extraLines, setExtraLines] = useState<ReceivableLine[]>([]);
  const [manualQty, setManualQty] = useState<{ on: boolean; qty: string; reason: string }>({ on: false, qty: '', reason: '' });
  const [checkedByUser, setCheckedByUser] = useState(false);
  const [crops, setCrops] = useState<Record<number, string>>({});

  const resolved = useMemo(() => resolveMasters(masters, targetYm), [masters, targetYm]);
  const groups: LabelGroup[] = useMemo(
    () => [
      ...KNOWN_CHANNELS.map((c) => ({ id: c.id, labels: [c.name, ...c.aliases] })),
      ...resolved.ignoredPayments.map((l) => ({ id: `ignored:${l}`, labels: [l] })),
    ],
    [resolved.ignoredPayments],
  );

  const csvFile = useMemo(() => (csv ? readProductSalesCsv(csv.bytes, csv.fileName) : null), [csv]);
  const extraction = useMemo(
    () => (csvFile && resolved.extractRule && csvFile.rows.length > 0 ? extractContainerQty(csvFile, resolved.extractRule) : null),
    [csvFile, resolved.extractRule],
  );

  // OCR の行から項目への割り当ては、CSV が後から来ても検算②をやり直せるよう、ここで行う
  const fields = useMemo(
    () => (ocr ? { ...mapFields(ocr.rows, { receivableGroups: groups, csvAmountTotal: csvFile?.amountTotal ?? null }), businessYm: ocr.businessYm } : null),
    [ocr, groups, csvFile?.amountTotal],
  );

  const valueOf = (key: string, f: FieldReading | undefined): string => edits[key] ?? f?.value ?? '';
  const journal: JournalEntry = {
    businessYm: valueOf('businessYm', fields?.businessYm) || null,
    storeName: ocr?.storeName ?? null,
    grossTotal: valueOf('grossTotal', fields?.grossTotal) || null,
    discountTotal: valueOf('discountTotal', fields?.discountTotal) || null,
    discountTax: valueOf('discountTax', fields?.discountTax) || null,
    receivableTotal: valueOf('receivableTotal', fields?.receivableTotal) || null,
    receivables: [
      ...(fields?.receivables ?? []).map((r, i) => ({ label: edits[`recv:${i}:label`] ?? r.label, amount: valueOf(`recv:${i}:amount`, r) })),
      ...extraLines,
    ].filter((l) => l.label.trim() !== '' || l.amount.trim() !== ''),
  };

  const result = useMemo(
    () =>
      computeRealSales({
        targetYm,
        journal,
        container: manualQty.on
          ? { source: 'manual', qty: Number(manualQty.qty), reason: manualQty.reason }
          : extraction
            ? { source: 'csv', extraction, csvAmountTotal: csvFile?.amountTotal ?? null, fileName: csvFile?.fileName ?? '' }
            : { source: 'manual', qty: NaN, reason: '' },
        masters,
        previous,
      }),
    // journal は edits・fields・extraLines から作られる
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetYm, JSON.stringify(journal), manualQty, extraction, csvFile, masters, previous],
  );
  const blocking = result.issues.filter((i) => i.level === 'BLOCKING');
  const b = result.breakdown;

  // 入力が変わったら確定を取り消す（再確認・再確定を求める。要件§11.6-8）
  const signature = JSON.stringify({ journal, manualQty, csv: csv?.fileName, csvLen: csv?.bytes.length, photo: photo?.fileName, masters, targetYm });
  const confirmedSig = useRef<string | null>(null);
  useEffect(() => {
    if (confirmed && confirmedSig.current !== null && confirmedSig.current !== signature) {
      confirmedSig.current = null;
      setCheckedByUser(false);
      onUnconfirm();
    }
  }, [signature, confirmed, onUnconfirm]);

  const runOcr = async (file: UploadedFile): Promise<void> => {
    setOcrState({ phase: 'running', done: 0, total: 1 });
    setEdits({});
    setExtraLines([]);
    setCheckedByUser(false);
    try {
      const { readJournalInBrowser, cropToDataUrl } = await import('../../ocr/browser');
      const r = await readJournalInBrowser(new Blob([file.bytes.slice().buffer as ArrayBuffer]), {
        receivableGroups: groups,
        csvAmountTotal: csvFile?.amountTotal ?? null,
        onProgress: (done, total) => setOcrState({ phase: 'running', done, total }),
      });
      setOcr(r);
      setCrops(Object.fromEntries(r.rows.map((row) => [row.index, cropToDataUrl(r.base, row.rect)])));
      setOcrState({ phase: 'done' });
    } catch (e) {
      setOcrState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const doConfirm = async (): Promise<void> => {
    if (!b) return;
    confirmedSig.current = signature;
    await onConfirm({
      realSales: toDecimalString(b.realSales),
      grossTotal: toDecimalString(b.grossTotal),
      feeTotal: toDecimalString(b.feeTotal),
      containerQty: b.containerQty,
      containerCost: toDecimalString(b.containerCost),
      confirmedAt: new Date().toISOString(),
    });
  };

  const attention = fields
    ? [fields.grossTotal, fields.discountTotal, fields.discountTax, fields.receivableTotal, ...fields.receivables].filter(
        (f) => f.source === 'corrected' || f.source === 'none' || ('labelBy' in f && (f as ReceivableReading).labelBy !== 'exact'),
      ).length
    : 0;
  const canConfirm = b !== null && blocking.length === 0 && checkedByUser && !confirmed;

  return (
    <>
      <MasterPanel targetYm={targetYm} role={role} masters={masters} onSetMasters={onSetMasters} resolvedIssues={resolved.issues} />

      <Panel title="写真と商品別売上CSV" hint="ジャーナル（店舗売上レポート）の写真と、POS の商品別売上CSVを指定します。写真はこのPCの中だけで読み取り、外部へは送りません。">
        <FileSlot
          title="ジャーナル写真"
          description="売掛欄（menu・シェアデリなど）が写っている写真。影・重なりがあっても読めますが、真上から明るく撮ると確実です。"
          accept="image/*"
          file={photo}
          onSelect={(f) =>
            void f.arrayBuffer().then((buf) => {
              const bytes = new Uint8Array(buf);
              if (photo) URL.revokeObjectURL(photo.url);
              const next = { fileName: f.name, bytes, url: URL.createObjectURL(f) };
              setPhoto(next);
              setOcr(null);
              void runOcr(next);
            })
          }
          onClear={() => {
            if (photo) URL.revokeObjectURL(photo.url);
            setPhoto(null);
            setOcr(null);
            setOcrState({ phase: 'idle' });
          }}
        />
        <FileSlot
          title="商品別売上CSV"
          description="POS の「商品別売上」。容器対象出数を数え、写真の総計1 との検算（②）にも使います。"
          accept=".csv"
          file={csv}
          onSelect={(f) => void f.arrayBuffer().then((buf) => setCsv({ fileName: f.name, bytes: new Uint8Array(buf) }))}
          onClear={() => setCsv(null)}
        />
        {ocrState.phase === 'running' ? (
          <Note>
            写真を読み取っています…（{ocrState.done ?? 0} / {ocrState.total ?? 1}）。初回は読み取りの部品を読み込むため少し時間がかかります。
          </Note>
        ) : null}
        {ocrState.phase === 'error' ? (
          <Note variant="warn">
            写真を読み取れませんでした（{ocrState.message}）。下の表に写真を見ながら入力すれば続けられます。
          </Note>
        ) : null}
      </Panel>

      <Panel title="読み取り結果の照合" hint="左の写真の行と見比べて、違っていれば右の欄を直します。検算で補正した値・読めなかった値は色が付いています。">
        {attention > 0 ? (
          <Note variant="warn">
            <strong>確認が必要な項目が {attention} 件あります。</strong>色付きの項目を、写真の行と見比べてください。
          </Note>
        ) : null}
        <div className="scroll">
          <table className="grid ocr-table">
            <thead>
              <tr>
                <th>項目</th>
                <th>写真の該当行</th>
                <th className="right">値</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(FIELD_LABELS) as FieldKey[]).map((k) => {
                const f = fields?.[k];
                return (
                  <tr key={k} className={f && (f.source === 'corrected' || f.source === 'none') ? 'anomaly' : undefined}>
                    <td className="nowrap">{FIELD_LABELS[k]}</td>
                    <td>{f?.row && crops[f.row.index] ? <img className="ocr-crop" src={crops[f.row.index]} alt={`${FIELD_LABELS[k]}の行`} /> : <span className="muted">—</span>}</td>
                    <td className="num">
                      <input
                        type={k === 'businessYm' ? 'month' : 'text'}
                        inputMode={k === 'businessYm' ? undefined : 'numeric'}
                        aria-label={FIELD_LABELS[k]}
                        value={valueOf(k, f)}
                        onChange={(e) => setEdits((d) => ({ ...d, [k]: e.target.value.replace(/[,，¥￥\s]/g, '') }))}
                        style={{ width: 150, textAlign: 'right' }}
                      />
                    </td>
                    <td>
                      {f ? <span className={SOURCE_TEXT[f.source].cls}>{SOURCE_TEXT[f.source].text}</span> : <span className="muted">未読取</span>}
                      {edits[k] !== undefined ? <span className="tag-plain">修正済み</span> : null}
                      {f?.note ? <div className="muted small">{f.note}</div> : null}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <th colSpan={4} style={{ textAlign: 'left' }}>
                  売掛欄の内訳（代行チャネルは手数料の対象、それ以外は対象外）
                </th>
              </tr>
              {(fields?.receivables ?? []).map((r, i) => {
                const label = edits[`recv:${i}:label`] ?? r.label;
                const needs = r.source === 'corrected' || r.source === 'none' || r.labelBy !== 'exact';
                return (
                  <tr key={`r${i}`} className={needs ? 'anomaly' : undefined}>
                    <td>
                      <input
                        type="text"
                        aria-label={`内訳${i + 1}の表記`}
                        list="receivable-labels"
                        value={label}
                        onChange={(e) => setEdits((d) => ({ ...d, [`recv:${i}:label`]: e.target.value }))}
                        style={{ width: 150 }}
                      />
                    </td>
                    <td>{r.row && crops[r.row.index] ? <img className="ocr-crop" src={crops[r.row.index]} alt={`${label}の行`} /> : null}</td>
                    <td className="num">
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-label={`${label}の金額`}
                        value={valueOf(`recv:${i}:amount`, r)}
                        onChange={(e) => setEdits((d) => ({ ...d, [`recv:${i}:amount`]: e.target.value.replace(/[,，¥￥\s]/g, '') }))}
                        style={{ width: 150, textAlign: 'right' }}
                      />
                    </td>
                    <td>
                      <span className={SOURCE_TEXT[r.source].cls}>{SOURCE_TEXT[r.source].text}</span>
                      {r.labelBy === 'elimination' ? <span className="tag-unreg">表記は消去法</span> : null}
                      {r.labelBy === 'none' ? <span className="tag-unreg">表記を選んでください</span> : null}
                      {r.note ? <div className="muted small">{r.note}</div> : null}
                    </td>
                  </tr>
                );
              })}
              {extraLines.map((l, i) => (
                <tr key={`x${i}`}>
                  <td>
                    <input type="text" list="receivable-labels" aria-label={`追加${i + 1}の表記`} value={l.label} onChange={(e) => setExtraLines((xs) => xs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} style={{ width: 150 }} />
                  </td>
                  <td className="muted">手入力</td>
                  <td className="num">
                    <input type="text" inputMode="numeric" aria-label={`追加${i + 1}の金額`} value={l.amount} onChange={(e) => setExtraLines((xs) => xs.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[,，¥￥\s]/g, '') } : x)))} style={{ width: 150, textAlign: 'right' }} />
                  </td>
                  <td>
                    <button type="button" onClick={() => setExtraLines((xs) => xs.filter((_x, j) => j !== i))}>
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="receivable-labels">
            {groups.map((g) => (
              <option key={g.id} value={g.labels[0]} />
            ))}
          </datalist>
        </div>
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" onClick={() => setExtraLines((xs) => [...xs, { label: '', amount: '' }])}>
            内訳の行を追加
          </button>
          {photo ? (
            <button type="button" onClick={() => void runOcr(photo)} disabled={ocrState.phase === 'running'}>
              写真を読み取り直す
            </button>
          ) : null}
        </div>
        {photo ? (
          <details className="photo-view">
            <summary>元の写真を表示</summary>
            <img src={photo.url} alt="ジャーナル写真" />
          </details>
        ) : null}
      </Panel>

      <Panel title="検算と計算内訳" hint="検算①②が合っていれば、読み取り値は信頼できます。">
        <div className="kpi-row">
          <CheckCard title="検算① 売掛合計" status={b?.checks.receivables.status ?? 'skipped'} left={b?.checks.receivables.left ?? null} right={b?.checks.receivables.right ?? null} leftLabel="内訳の合計" rightLabel="売掛合計" />
          <CheckCard title="検算② 商品別売上CSV" status={b?.checks.csv.status ?? 'skipped'} left={b?.checks.csv.left ?? null} right={b?.checks.csv.right ?? null} leftLabel="総計1−値割引+税" rightLabel="CSVの売上金額" />
          <div className="kpi">
            <div className="kpi-label">容器対象出数</div>
            <div className="kpi-value">{extraction ? `${extraction.qty.toLocaleString('ja-JP')} 個` : '—'}</div>
            <div className="kpi-note">{extraction ? `対象 ${extraction.included.length} 行／除外（トッピング） ${extraction.excludedQty.toLocaleString('ja-JP')} 個` : 'CSV 未指定'}</div>
          </div>
        </div>

        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={manualQty.on} onChange={(e) => setManualQty((m) => ({ ...m, on: e.target.checked }))} />
          <span>商品別売上CSVが使えないので、容器対象出数を手入力する（理由の入力が必要です）</span>
        </label>
        {manualQty.on ? (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label className="field">
              <span>容器対象出数（個）</span>
              <input type="number" min="0" step="1" value={manualQty.qty} onChange={(e) => setManualQty((m) => ({ ...m, qty: e.target.value }))} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>理由（必須）</span>
              <input type="text" value={manualQty.reason} placeholder="例: CSVの出力に失敗したため、検証値から入力" onChange={(e) => setManualQty((m) => ({ ...m, reason: e.target.value }))} />
            </label>
          </div>
        ) : null}

        {b ? (
          <table className="grid breakdown">
            <tbody>
              <tr>
                <th>総計1（税抜値割引前）</th>
                <td className="num">{yen(b.grossTotal)}</td>
              </tr>
              {b.channels.map((c) => (
                <tr key={c.channelId}>
                  <td>
                    − {c.name}（{yen(c.sales)} × {c.rateText}）
                  </td>
                  <td className="num">{yen(c.fee)}</td>
                </tr>
              ))}
              <tr>
                <th>代行手数料 合計</th>
                <td className="num">{yen(b.feeTotal)}</td>
              </tr>
              <tr>
                <th>
                  弁当容器代（{b.containerQty.toLocaleString('ja-JP')} 個 × {yen(b.containerPrice)} 円）
                </th>
                <td className="num">{yen(b.containerCost)}</td>
              </tr>
              <tr className="total">
                <th>食材費計算用リアル売上</th>
                <td className="num">
                  <strong>{yen(b.realSales)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <Note>総計1・売掛欄の内訳・容器対象出数がそろうと、ここに計算内訳が出ます。</Note>
        )}
        {b && masterC4 !== null && Number(toDecimalString(b.realSales)) !== masterC4 ? (
          <p className="muted">
            当月本部マスタの C4 は {masterC4.toLocaleString('ja-JP')} 円です。確定すると、出力するExcelの C4 はリアル売上になります（差額 {(Number(toDecimalString(b.realSales)) - masterC4).toLocaleString('ja-JP', { maximumFractionDigits: 3 })} 円）。
          </p>
        ) : null}

        <h3>エラー・警告</h3>
        <IssueList issues={result.issues} levels={['BLOCKING', 'WARNING']} emptyText="エラー・警告はありません。" />

        {confirmed ? (
          <>
            <Note>
              <strong>リアル売上を確定しました：{yen(confirmed.realSales)} 円</strong>。分析・出力の原価率と、出力するExcelの C4 にこの値を使います。
              写真・CSV・読み取り値・マスタを変えると確定は取り消されます。
            </Note>
            <div className="actions">
              <button type="button" className="primary" onClick={() => void onNext()} disabled={running}>
                {running ? '再計算中…' : '次へ：分析・出力'}
              </button>
            </div>
          </>
        ) : (
          <div className="actions" style={{ alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={checkedByUser} onChange={(e) => setCheckedByUser(e.target.checked)} disabled={!b} />
              <span>写真と見比べて、読み取り値を確認しました</span>
            </label>
            <button type="button" className="primary" onClick={() => void doConfirm()} disabled={!canConfirm || running}>
              この内容で確定
            </button>
            {blocking.length > 0 ? <span className="muted">エラーが {blocking.length} 件あるため確定できません。</span> : null}
          </div>
        )}
      </Panel>
    </>
  );
}

function CheckCard({
  title,
  status,
  left,
  right,
  leftLabel,
  rightLabel,
}: {
  title: string;
  status: 'ok' | 'ng' | 'skipped';
  left: string | null;
  right: string | null;
  leftLabel: string;
  rightLabel: string;
}): JSX.Element {
  const text = status === 'ok' ? '一致' : status === 'ng' ? '不一致' : '未実施';
  return (
    <div className={status === 'ng' ? 'kpi alert' : 'kpi'}>
      <div className="kpi-label">{title}</div>
      <div className="kpi-value">{text}</div>
      <div className="kpi-note">
        {leftLabel} {left ?? '—'}／{rightLabel} {right ?? '—'}
      </div>
    </div>
  );
}

/** 料率・容器単価マスタ。編集は管理者のみ。値は上書きせず、適用開始年月の行を足す */
function MasterPanel({
  targetYm,
  role,
  masters,
  onSetMasters,
  resolvedIssues,
}: {
  targetYm: string;
  role: Role;
  masters: RealSalesMasters;
  onSetMasters: (m: RealSalesMasters) => void;
  resolvedIssues: readonly { code: string; message: string }[];
}): JSX.Element {
  const resolved = resolveMasters(masters, targetYm);
  const empty = masters.channels.length === 0;
  const [open, setOpen] = useState(empty);
  const [importFrom, setImportFrom] = useState(empty ? EPOCH_YM : targetYm);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ id: string; rate: string; from: string } | null>(null);
  const [priceDraft, setPriceDraft] = useState<{ price: string; from: string } | null>(null);
  const admin = role === 'ADMIN';

  const importFile = async (f: File): Promise<void> => {
    const m = await importMastersFromWorkbook(new Uint8Array(await f.arrayBuffer()), importFrom);
    const keep = masters.channels.filter((c) => !m.channels.some((n) => n.id === c.id && n.validFrom === c.validFrom));
    const prices = m.containerPrice
      ? [...masters.containerPrices.filter((p) => p.validFrom !== importFrom), { price: m.containerPrice, validFrom: importFrom, validTo: null }]
      : masters.containerPrices;
    onSetMasters({ ...masters, channels: [...keep, ...m.channels], containerPrices: prices });
    setMessage(
      `${f.name} から ${m.channels.length} チャネルの料率${m.containerPrice ? 'と容器単価' : ''}を取り込みました（${importFrom === EPOCH_YM ? '最初から' : `${importFrom} から`}適用）。` +
        (m.unknownLabels.length ? ` 対応づけられなかった表記: ${m.unknownLabels.join('、')}` : ''),
    );
  };

  return (
    <Panel title="料率・容器単価マスタ" hint="代行チャネルの手数料率と、弁当容器1個あたりの控除額。値を変えるときは上書きせず、適用開始年月を付けて追加します（過去の月は変わりません）。">
      {resolvedIssues.length > 0 ? (
        <Note variant="warn">
          {resolvedIssues.map((i) => i.message).join(' ')}
          {admin ? ' 下の「既存のマスタExcelから取り込む」を使ってください。' : ' 管理者に登録を依頼してください。'}
        </Note>
      ) : null}
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? 'マスタを閉じる' : `マスタを表示（${targetYm} に適用される値）`}
      </button>
      {open ? (
        <>
          <table className="grid" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>チャネル</th>
                <th>写真上の表記</th>
                <th className="right">{targetYm} の料率</th>
                <th>変更</th>
              </tr>
            </thead>
            <tbody>
              {KNOWN_CHANNELS.map((k) => {
                const c = resolved.channels.find((x) => x.id === k.id);
                return (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="muted small">{k.aliases.join('、')}</td>
                    <td className="num">{c ? `${(Number(c.rateText) * 100).toFixed(2).replace(/\.?0+$/, '')}%（${c.rateText}）` : '未登録'}</td>
                    <td>
                      {admin ? (
                        draft?.id === k.id ? (
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <input aria-label={`${k.name}の新しい料率`} value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} style={{ width: 80 }} placeholder="0.30" />
                            <input aria-label={`${k.name}の適用開始年月`} type="month" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
                            <button
                              type="button"
                              onClick={() => {
                                onSetMasters({ ...masters, channels: [...masters.channels.filter((x) => !(x.id === k.id && x.validFrom === draft.from)), channelRow(k.id, draft.rate.trim(), draft.from)] });
                                setDraft(null);
                              }}
                            >
                              追加
                            </button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setDraft({ id: k.id, rate: c?.rateText ?? '', from: targetYm })}>
                            料率を変更
                          </button>
                        )
                      ) : (
                        <span className="muted">管理者のみ</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td>弁当容器（1個）</td>
                <td className="muted small">TO</td>
                <td className="num">{resolved.containerPriceText !== null ? `${resolved.containerPriceText} 円` : '未登録'}</td>
                <td>
                  {admin ? (
                    priceDraft ? (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <input aria-label="新しい容器単価" value={priceDraft.price} onChange={(e) => setPriceDraft({ ...priceDraft, price: e.target.value })} style={{ width: 80 }} />
                        <input aria-label="容器単価の適用開始年月" type="month" value={priceDraft.from} onChange={(e) => setPriceDraft({ ...priceDraft, from: e.target.value })} />
                        <button
                          type="button"
                          onClick={() => {
                            onSetMasters({ ...masters, containerPrices: [...masters.containerPrices.filter((p) => p.validFrom !== priceDraft.from), { price: priceDraft.price.trim(), validFrom: priceDraft.from, validTo: null }] });
                            setPriceDraft(null);
                          }}
                        >
                          追加
                        </button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setPriceDraft({ price: resolved.containerPriceText ?? '', from: targetYm })}>
                        単価を変更
                      </button>
                    )
                  ) : (
                    <span className="muted">管理者のみ</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          {admin ? (
            <div className="actions" style={{ alignItems: 'center' }}>
              <label className="field">
                <span>適用開始年月</span>
                <input type="month" value={importFrom === EPOCH_YM ? '' : importFrom} onChange={(e) => setImportFrom(e.target.value || EPOCH_YM)} />
              </label>
              <label className="file-button">
                既存のマスタExcelから取り込む
                <input type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
              </label>
              <span className="muted small">「リアル売上算出（マスタ）.xlsx」をそのまま指定できます。適用開始年月を空にすると最初から適用します。</span>
            </div>
          ) : null}
          {message ? <Note>{message}</Note> : null}
        </>
      ) : null}
    </Panel>
  );
}
