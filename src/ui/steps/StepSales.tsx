/**
 * STEP 5 売上計算（要件§11.6）。
 *
 * ジャーナルの値は**前工程で作った読み取り結果ファイル**（CSV・JSON）で受け取り、
 * 商品別売上CSVから容器対象出数を数え、料率・容器単価を当てて
 * 当月売上高（総計1 − 代行手数料 − 弁当容器代）を出す。
 *
 * 端末内の画像OCRは廃止した（2026-10-28）。感熱紙の印字＋写真では精度が足りず、
 * 写真を外部のOCRへ送ることは要件§11.3 で禁じているため、読み取りは前工程に任せる。
 * ファイルが無くても、ジャーナルを見ながら画面で直接入力すれば計算できる。
 *
 * 取り込んだ値は候補であり、確定は必ず人が行う。検算（①売掛合計・②CSV）が合わない項目は目立たせる。
 * ファイル・CSV・入力値・マスタのどれかが変われば確定を取り消す（§11.6-8）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, Note, IssueList, FileSlot } from '../components';
import type { Role } from '../App';
import type { ConfirmedRealSales, UploadedFile } from '../../app/pipeline';
import { computeRealSales, type JournalEntry, type PreviousRealSales, type ReceivableLine } from '../../domain/realSales/compute';
import { readJournalUpload, type JournalFileResult } from '../../domain/realSales/journalFile';
import { toDecimalString, type Fixed } from '../../domain/realSales/fixed';
import { channelRow, EPOCH_YM, KNOWN_CHANNELS, resolveMasters, type RealSalesMasters } from '../../domain/realSales/masters';
import { importMastersFromWorkbook } from '../../domain/realSales/masterImport';
import { extractContainerQty, readProductSalesCsv } from '../../domain/realSales/productSalesCsv';
import { sha256Hex } from '../../ingest/fileIdentity';
import type { RealSalesDetail } from '../../domain/realSales/sales';

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

/** 項目の値がどこから来たか */
type ValueSource = 'file' | 'none';

interface Reading {
  value: string | null;
  source: ValueSource;
}

interface ReceivableReadingLine extends Reading {
  label: string;
}

const SOURCE_TEXT: Record<ValueSource, { text: string; cls: string }> = {
  file: { text: '取込ファイル', cls: 'tag-reg' },
  none: { text: '未入力', cls: 'tag-unreg' },
};

/** 読み取り結果ファイルの書き方（画面に出す見本）。金額は架空 */
const JOURNAL_FILE_SAMPLE = `【Excel の場合】店舗オーナーの「リアル売上算出」シートをそのまま指定できます
  営業年月 | 2026.01
  総計１   | 1234567
  チャンネル | 売上  | 手数料率     ← この見出しの下に、チャネルごとの売上を並べる
  menu       | 2345  | 0.2
  シェアデリ | 3000  | 0.2
  …
  ※ 行や列の位置は自由です。見出しの文字で読み取ります
  ※「計」「差引金額」「リアル売上」の行と、弁当容器（出数）の表は読み飛ばします
  ※ 手数料率・容器単価はシステムのマスタを使うため、シートの値は参照しません

【CSV の場合】1列目に項目、2列目に金額
項目,金額
営業月,2026-01
店舗名,○○店
総計1（税抜値割引前）,1234567
値割引合計,1000
値割引消費税,80
売掛合計,245694
menu,2345
シェアデリ,3000

【JSON の場合】
{
  "営業月": "2026-01",
  "総計1": 1234567,
  "売掛合計": 245694,
  "売掛内訳": [
    { "項目": "menu", "金額": 2345 },
    { "項目": "シェアデリ", "金額": 3000 }
  ]
}

※ 売掛欄の内訳は、ジャーナルに出ている行をそのまま並べてください（手数料の対象かどうかはシステムが判断します）。
※ 金額は税込・税抜を変えず、ジャーナルの数字をそのまま書いてください。`;

const fileReading = (value: string | null): Reading => ({ value, source: value === null ? 'none' : 'file' });

export function StepSales({
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
  return (
    <>
      <Panel title="STEP 5　売上計算" hint="原価率の分母にする当月売上高を計算し、確定します。">
        <Note>
          <strong>当月売上高 ＝ 総計1 − 代行手数料 − 弁当容器代</strong>
          <br />
          ジャーナル（店舗売上レポート）の値と、POS の商品別売上CSVから計算します。ジャーナルの値は、前工程で作った読み取り結果ファイルで取り込むか、下の表に直接入力します。
        </Note>
      </Panel>

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
  const [csv, setCsv] = useState<UploadedFile | null>(null);
  /** 前工程（店舗オーナー）がジャーナルを読み取って作ったファイル */
  const [journalFile, setJournalFile] = useState<UploadedFile | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [extraLines, setExtraLines] = useState<ReceivableLine[]>([]);
  const [manualQty, setManualQty] = useState<{ on: boolean; qty: string; reason: string }>({ on: false, qty: '', reason: '' });
  const [checkedByUser, setCheckedByUser] = useState(false);

  const resolved = useMemo(() => resolveMasters(masters, targetYm), [masters, targetYm]);
  /** 売掛欄の表記の候補（入力の補助に出す） */
  const labelChoices = useMemo(
    () => [...KNOWN_CHANNELS.map((c) => c.name), ...resolved.ignoredPayments],
    [resolved.ignoredPayments],
  );

  const csvFile = useMemo(() => (csv ? readProductSalesCsv(csv.bytes, csv.fileName) : null), [csv]);
  const extraction = useMemo(
    () => (csvFile && resolved.extractRule && csvFile.rows.length > 0 ? extractContainerQty(csvFile, resolved.extractRule) : null),
    [csvFile, resolved.extractRule],
  );

  // Excel は読み込みが非同期（ZIP を展開する）ため、state に受ける
  const [parsedFile, setParsedFile] = useState<JournalFileResult | null>(null);
  useEffect(() => {
    if (!journalFile) {
      setParsedFile(null);
      return;
    }
    let live = true;
    void readJournalUpload(journalFile.bytes, journalFile.fileName).then((r) => {
      if (live) setParsedFile(r);
    });
    return () => {
      live = false;
    };
  }, [journalFile]);

  const fields = useMemo(() => {
    if (!parsedFile || parsedFile.issues.length > 0) return null;
    return {
      businessYm: fileReading(parsedFile.businessYm),
      grossTotal: fileReading(parsedFile.grossTotal),
      discountTotal: fileReading(parsedFile.discountTotal),
      discountTax: fileReading(parsedFile.discountTax),
      receivableTotal: fileReading(parsedFile.receivableTotal),
      receivables: parsedFile.receivables.map((l): ReceivableReadingLine => ({ ...fileReading(l.amount), label: l.label })),
    };
  }, [parsedFile]);

  const valueOf = (key: string, f: Reading | undefined): string => edits[key] ?? f?.value ?? '';
  const journal: JournalEntry = {
    businessYm: valueOf('businessYm', fields?.businessYm) || null,
    storeName: parsedFile?.storeName ?? null,
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
  const signature = JSON.stringify({ journal, manualQty, csv: csv?.fileName, csvLen: csv?.bytes.length, jfile: journalFile?.fileName, jfileLen: journalFile?.bytes.length, masters, targetYm });
  const confirmedSig = useRef<string | null>(null);
  useEffect(() => {
    if (confirmed && confirmedSig.current !== null && confirmedSig.current !== signature) {
      confirmedSig.current = null;
      setCheckedByUser(false);
      onUnconfirm();
    }
  }, [signature, confirmed, onUnconfirm]);

  const doConfirm = async (): Promise<void> => {
    if (!b) return;
    confirmedSig.current = signature;
    // 監査用に、取り込んだ値と確定値、どれを手で直したかを残す（要件§11.7）
    const readings: RealSalesDetail['readings'] = [
      ...(Object.keys(FIELD_LABELS) as FieldKey[]).map((k) => ({
        field: FIELD_LABELS[k],
        readValue: fields?.[k]?.value ?? null,
        finalValue: journal[k] ?? null,
        source: fields?.[k]?.source ?? 'manual',
        edited: edits[k] !== undefined,
      })),
      ...journal.receivables.map((l, i) => {
        const f = fields?.receivables[i];
        return {
          field: `売掛内訳:${l.label}`,
          readValue: f?.value ?? null,
          finalValue: l.amount,
          source: f?.source ?? 'manual',
          edited: edits[`recv:${i}:amount`] !== undefined || edits[`recv:${i}:label`] !== undefined || !f,
        };
      }),
    ];
    const files: RealSalesDetail['files'] = [];
    if (csv) files.push({ kind: 'csv', fileName: csv.fileName, sha256: await sha256Hex(csv.bytes) });
    if (journalFile) files.push({ kind: 'journalFile', fileName: journalFile.fileName, sha256: await sha256Hex(journalFile.bytes) });
    await onConfirm({
      realSales: toDecimalString(b.realSales),
      grossTotal: toDecimalString(b.grossTotal),
      feeTotal: toDecimalString(b.feeTotal),
      containerQty: b.containerQty,
      containerCost: toDecimalString(b.containerCost),
      confirmedAt: new Date().toISOString(),
      detail: {
        channels: b.channels.map((c) => ({ channelId: c.channelId, label: c.label, sales: toDecimalString(c.sales), rate: c.rateText, fee: toDecimalString(c.fee) })),
        containerPrice: b.containerPriceText || toDecimalString(b.containerPrice),
        containerQtySource: b.containerQtySource,
        containerQtyReason: manualQty.on ? manualQty.reason.trim() : null,
        readings,
        files,
        masters,
      },
    });
  };

  // 取り込めなかった（空の）項目は、ジャーナルを見ながら手で入れてもらう
  const attention = fields
    ? [fields.grossTotal, fields.discountTotal, fields.discountTax, fields.receivableTotal, ...fields.receivables].filter((f) => f.source === 'none')
        .length
    : 0;
  const canConfirm = b !== null && blocking.length === 0 && checkedByUser && !confirmed;

  return (
    <>
      <MasterPanel targetYm={targetYm} role={role} masters={masters} onSetMasters={onSetMasters} resolvedIssues={resolved.issues} />

      <Panel title="ジャーナルと商品別売上CSV" hint="ジャーナル（店舗売上レポート）の読み取り結果ファイルと、POS の商品別売上CSVを指定します。ファイルはこのPCの中だけで読み、外部へは送りません。">
        <FileSlot
          title="ジャーナルの読み取り結果ファイル"
          description="前工程でジャーナルを読み取って作ったファイル（Excel・CSV・JSON）。店舗オーナーの「リアル売上算出」シートをそのまま指定できます。無いときは下の表に直接入力できます。"
          accept=".xlsx,.xlsm,.csv,.tsv,.txt,.json"
          file={journalFile}
          onSelect={(f) => void f.arrayBuffer().then((buf) => setJournalFile({ fileName: f.name, bytes: new Uint8Array(buf) }))}
          onClear={() => setJournalFile(null)}
        />
        {parsedFile && parsedFile.issues.length > 0 ? <IssueList issues={parsedFile.issues} levels={['BLOCKING']} /> : null}
        {parsedFile && parsedFile.issues.length === 0 ? (
          <Note>
            読み取り結果ファイルの値を使います（売掛欄の内訳 {parsedFile.receivables.length} 件）。違っていれば下の表で直せます。
          </Note>
        ) : null}
        <details className="photo-view">
          <summary>読み取り結果ファイルの作り方（店舗オーナー向け）</summary>
          <p className="muted small">
            ジャーナルの値を次のいずれかの形で渡してください。項目名はジャーナルの表記のままで構いません。
          </p>
          <pre className="sample">{JOURNAL_FILE_SAMPLE}</pre>
        </details>

        <FileSlot
          title="商品別売上CSV"
          description="POS の「商品別売上」。容器対象出数を数え、ジャーナルの総計1 との検算（②）にも使います。"
          accept=".csv"
          file={csv}
          onSelect={(f) => void f.arrayBuffer().then((buf) => setCsv({ fileName: f.name, bytes: new Uint8Array(buf) }))}
          onClear={() => setCsv(null)}
        />
      </Panel>

      <Panel title="値の確認" hint="取り込んだ値を一覧にしています。ジャーナルと見比べて、違っていれば直してください。ファイルが無いときは、ここに直接入力しても計算できます。">
        {attention > 0 ? (
          <Note variant="warn">
            <strong>値が入っていない項目が {attention} 件あります。</strong>ジャーナルを見て入力してください。
          </Note>
        ) : null}
        <div className="scroll">
          <table className="grid ocr-table">
            <thead>
              <tr>
                <th>項目</th>
                <th className="right">値</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(FIELD_LABELS) as FieldKey[]).map((k) => {
                const f = fields?.[k];
                return (
                  <tr key={k} className={f?.source === 'none' ? 'anomaly' : undefined}>
                    <td className="nowrap">{FIELD_LABELS[k]}</td>
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
                      {f ? <span className={SOURCE_TEXT[f.source].cls}>{SOURCE_TEXT[f.source].text}</span> : <span className="muted">手入力</span>}
                      {edits[k] !== undefined ? <span className="tag-plain">修正済み</span> : null}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <th colSpan={3} style={{ textAlign: 'left' }}>
                  売掛欄の内訳（代行チャネルは手数料の対象、それ以外は対象外）
                </th>
              </tr>
              {(fields?.receivables ?? []).map((r, i) => {
                const label = edits[`recv:${i}:label`] ?? r.label;
                return (
                  <tr key={`r${i}`} className={r.source === 'none' ? 'anomaly' : undefined}>
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
                      {edits[`recv:${i}:label`] !== undefined || edits[`recv:${i}:amount`] !== undefined ? <span className="tag-plain">修正済み</span> : null}
                    </td>
                  </tr>
                );
              })}
              {extraLines.map((l, i) => (
                <tr key={`x${i}`}>
                  <td>
                    <input type="text" list="receivable-labels" aria-label={`追加${i + 1}の表記`} value={l.label} onChange={(e) => setExtraLines((xs) => xs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} style={{ width: 150 }} />
                  </td>
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
            {labelChoices.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </div>
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" onClick={() => setExtraLines((xs) => [...xs, { label: '', amount: '' }])}>
            内訳の行を追加
          </button>
        </div>
      </Panel>

      <Panel title="検算と計算内訳" hint="検算①②が合っていれば、取り込んだ値は信頼できます。">
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
                <th>当月売上高（食材費計算用）</th>
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
            当月本部マスタの C4 は {masterC4.toLocaleString('ja-JP')} 円です。確定すると、出力するExcelの C4 はここで計算した値になります（差額 {(Number(toDecimalString(b.realSales)) - masterC4).toLocaleString('ja-JP', { maximumFractionDigits: 3 })} 円）。
          </p>
        ) : null}

        <h3>エラー・警告</h3>
        <IssueList issues={result.issues} levels={['BLOCKING', 'WARNING']} emptyText="エラー・警告はありません。" />

        {confirmed ? (
          <>
            <Note>
              <strong>当月売上高を確定しました：{yen(confirmed.realSales)} 円</strong>。分析・出力の原価率と、出力するExcelの C4 にこの値を使います。
              ファイル・CSV・入力値・マスタを変えると確定は取り消されます。
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
              <span>ジャーナルと見比べて、値を確認しました</span>
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
                <th>ジャーナルの表記</th>
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
