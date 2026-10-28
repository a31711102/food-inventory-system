/**
 * 食材費計算用リアル売上の計算（要件§11.2）。
 *
 *   リアル売上 = 総計1 − 配達代行手数料合計 − 弁当容器代
 *   配達代行手数料合計 = Σ（チャネル別売上 × チャネル別手数料率）   … 途中で丸めない
 *   弁当容器代 = 容器対象出数 × 容器単価
 *
 * ジャーナルの値は、読み取り結果ファイルから取り込むか画面で入力したもの（JournalEntry）を受け取る。
 * 読み取りの誤りは次の2つの検算で検出する（要件§11.3）。
 *
 *   ① 売掛欄の内訳の合計 = 売掛合計
 *   ② 総計1 − 値割引合計 + 値割引消費税 = 商品別売上CSVの売上金額合計
 *
 * ②は CSV に日付列が無いことへの代替で、ジャーナルと CSV が同じ月かの確認にもなる。
 */
import { IssueCollector, type IssueDetail, type ValidationIssue } from '../issues';
import { add, fromInt, isInteger, mul, parseDecimal, sub, toDecimalString, ZERO, type Fixed } from './fixed';
import { classifyPaymentLabel, resolveMasters, type RealSalesMasters } from './masters';
import type { ContainerExtraction } from './productSalesCsv';

/** 売掛欄の1行（表記と金額）。表記はジャーナルの印字のまま */
export interface ReceivableLine {
  label: string;
  amount: string;
}

/** 確認・修正後のジャーナルの値。数値は十進表記の文字列で持つ（倍精度を経由しない）。 */
export interface JournalEntry {
  /** 営業月 'YYYY-MM' */
  businessYm: string | null;
  storeName: string | null;
  grossTotal: string | null;
  discountTotal: string | null;
  discountTax: string | null;
  receivableTotal: string | null;
  receivables: ReceivableLine[];
}

export type ContainerQtyInput =
  | { source: 'csv'; extraction: ContainerExtraction; csvAmountTotal: number | null; fileName: string }
  | { source: 'manual'; qty: number; reason: string };

export interface PreviousRealSales {
  targetYm: string;
  realSales: string;
  feeTotal: string;
  containerQty: number;
}

export interface RealSalesInput {
  targetYm: string;
  journal: JournalEntry;
  container: ContainerQtyInput;
  masters: RealSalesMasters;
  previous?: PreviousRealSales | null;
}

export type CheckStatus = 'ok' | 'ng' | 'skipped';

export interface CheckResult {
  status: CheckStatus;
  /** 左辺（読み取り値から計算した値） */
  left: string | null;
  /** 右辺（照合先の値） */
  right: string | null;
  note: string;
}

export interface ChannelFee {
  channelId: string;
  name: string;
  /** ジャーナル上の表記 */
  label: string;
  sales: Fixed;
  rate: Fixed;
  rateText: string;
  fee: Fixed;
}

export interface RealSalesBreakdown {
  targetYm: string;
  grossTotal: Fixed;
  channels: ChannelFee[];
  feeTotal: Fixed;
  containerQty: number;
  containerQtySource: 'csv' | 'manual';
  containerPrice: Fixed;
  containerPriceText: string;
  containerCost: Fixed;
  realSales: Fixed;
  ignoredLabels: string[];
  unknownLabels: string[];
  checks: { receivables: CheckResult; csv: CheckResult };
}

export interface RealSalesResult {
  breakdown: RealSalesBreakdown | null;
  issues: ValidationIssue[];
}

const yen = (f: Fixed): string => {
  const s = toDecimalString(f);
  const [i, d] = s.split('.');
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${d ? `.${d}` : ''}`;
};

/** 金額欄は0以上の整数円。読めない・負・小数は null */
function money(text: string | null | undefined): Fixed | null {
  const v = parseDecimal(text);
  if (v === null || v < 0n || !isInteger(v)) return null;
  return v;
}

/** CSV から逆算した「総計1 があるべき値」。検算②で差を示すのに使う */
export function expectedGrossFromCsv(csvAmountTotal: number, discountTotal: string | null, discountTax: string | null): string | null {
  const d = money(discountTotal);
  const t = money(discountTax);
  if (d === null || t === null) return null;
  return toDecimalString(add(fromInt(csvAmountTotal), d, sub(ZERO, t)));
}

/** 売掛欄の内訳から「売掛合計があるべき値」 */
export function expectedReceivableTotal(lines: readonly ReceivableLine[]): string | null {
  const vs = lines.map((l) => money(l.amount));
  if (vs.some((v) => v === null)) return null;
  return toDecimalString(add(...(vs as Fixed[])));
}

export function computeRealSales(input: RealSalesInput): RealSalesResult {
  const issues = new IssueCollector();
  const { journal: j, targetYm } = input;
  const resolved = resolveMasters(input.masters, targetYm);
  issues.addAll(resolved.issues);

  // --- 営業月 ---
  if (!j.businessYm) {
    issues.add('E020', 'ジャーナルの営業月が入っていません。ジャーナルの「営業月」を確認して入力してください。');
  } else if (j.businessYm !== targetYm) {
    issues.add(
      'E016',
      `ジャーナルの営業月が対象年月と違います（ジャーナル: ${j.businessYm} / 対象年月: ${targetYm}）。別の月のジャーナルか、対象年月の指定を確認してください。`,
    );
  }

  // --- 総計1 ---
  const gross = money(j.grossTotal);
  if (gross === null) {
    issues.add('E020', `ジャーナルの「総計1（税抜値割引前）」が${j.grossTotal ? `数値として読めません（${j.grossTotal}）` : '入力されていません'}。`);
  }

  // --- 売掛欄の分類 ---
  const fees: ChannelFee[] = [];
  const ignoredLabels: string[] = [];
  const unknown: IssueDetail[] = [];
  const badAmount: string[] = [];
  const seen = new Map<string, string[]>();
  for (const line of j.receivables) {
    const amount = money(line.amount);
    if (amount === null) {
      badAmount.push(`${line.label}「${line.amount}」`);
      continue;
    }
    const kind = classifyPaymentLabel(line.label, resolved);
    if (kind.kind === 'ignored') {
      ignoredLabels.push(line.label);
      continue;
    }
    if (kind.kind === 'unknown') {
      unknown.push({ ref: {}, text: `${line.label}（${yen(amount)}円）` });
      continue;
    }
    const c = kind.channel;
    seen.set(c.id, [...(seen.get(c.id) ?? []), line.label]);
    fees.push({ channelId: c.id, name: c.name, label: line.label, sales: amount, rate: c.rate, rateText: c.rateText, fee: mul(amount, c.rate) });
  }
  if (badAmount.length > 0) {
    issues.add('E020', `売掛欄に金額として読めない値があります（${badAmount.join(' / ')}）。ジャーナルを見て入力し直してください。`);
  }
  const dup = [...seen].filter(([, labels]) => labels.length > 1);
  if (dup.length > 0) {
    issues.add(
      'E021',
      `同じ代行チャネルに複数の行が対応しています（${dup.map(([, l]) => l.join(' と ')).join(' / ')}）。重複して手数料を計上するおそれがあるため、どちらか一方にしてください。`,
    );
  }
  issues.addMany(
    'W026',
    unknown,
    (n, d) =>
      `売掛欄に、料率マスタにも対象外の一覧にも無い項目が ${n} 件あります（${d.map((x) => x.text).join(' / ')}）。新しい代行チャネルなら料率マスタに登録してください。登録するまで手数料には含めません。`,
  );
  const missing = resolved.channels.filter((c) => !seen.has(c.id));
  issues.addMany(
    'W027',
    missing.map((c) => ({ ref: {}, text: c.name })),
    (n, d) =>
      `登録済みの代行チャネル ${n} 件がジャーナルの売掛欄にありません（${d.map((x) => x.text).join(' / ')}）。その月の売上が無かったなら0円として扱います。読み落としでないかジャーナルを確認してください。`,
  );

  // --- 容器対象出数 ---
  let containerQty: number | null = null;
  let csvAmountTotal: number | null = null;
  if (input.container.source === 'csv') {
    issues.addAll(input.container.extraction.issues);
    containerQty = input.container.extraction.qty;
    csvAmountTotal = input.container.csvAmountTotal;
  } else {
    const { qty, reason } = input.container;
    if (!Number.isInteger(qty) || qty < 0) {
      issues.add('E018', `手入力の容器対象出数が0以上の整数ではありません（${qty}）。`);
    } else if (!reason.trim()) {
      issues.add('E018', '容器対象出数を手入力するときは、理由の入力が必要です。');
    } else {
      containerQty = qty;
      issues.add('I007', `容器対象出数を手入力の ${qty} 個で採用しました（理由: ${reason.trim()}）。`);
    }
  }

  // --- 検算 ---
  const receivables = checkReceivables(j);
  if (receivables.status === 'ng') {
    issues.add('W028', `検算①が合いません。売掛欄の内訳の合計 ${receivables.left} 円が、売掛合計 ${receivables.right} 円と一致しません。値をジャーナルと見比べてください。`);
  }
  const csv = checkAgainstCsv(j, csvAmountTotal);
  if (csv.status === 'ng') {
    issues.add('W028', `検算②が合いません。${csv.note}ジャーナルと商品別売上CSVが同じ月のものか、総計1・値割引の値を確認してください。`);
  }

  if (gross === null || containerQty === null || resolved.containerPrice === null) {
    return { breakdown: null, issues: [...issues.all] };
  }

  const feeTotal = add(...fees.map((f) => f.fee));
  const containerCost = mul(fromInt(containerQty), resolved.containerPrice);
  const realSales = sub(sub(gross, feeTotal), containerCost);

  if (input.previous) checkTrend(issues, input.previous, realSales, feeTotal, containerQty);

  return {
    breakdown: {
      targetYm,
      grossTotal: gross,
      channels: fees,
      feeTotal,
      containerQty,
      containerQtySource: input.container.source,
      containerPrice: resolved.containerPrice,
      containerPriceText: resolved.containerPriceText ?? '',
      containerCost,
      realSales,
      ignoredLabels,
      unknownLabels: unknown.map((u) => u.text),
      checks: { receivables, csv },
    },
    issues: [...issues.all],
  };
}

function checkReceivables(j: JournalEntry): CheckResult {
  const total = money(j.receivableTotal);
  const sum = expectedReceivableTotal(j.receivables);
  if (total === null || sum === null || j.receivables.length === 0) {
    return { status: 'skipped', left: sum, right: total === null ? null : toDecimalString(total), note: '売掛合計または内訳が未入力のため検算していません。' };
  }
  const ok = parseDecimal(sum) === total;
  return { status: ok ? 'ok' : 'ng', left: yen(parseDecimal(sum)!), right: yen(total), note: '' };
}

function checkAgainstCsv(j: JournalEntry, csvAmountTotal: number | null): CheckResult {
  const gross = money(j.grossTotal);
  if (csvAmountTotal === null || gross === null) {
    return { status: 'skipped', left: null, right: null, note: '商品別売上CSVの売上金額か総計1が無いため検算していません。' };
  }
  const csv = fromInt(csvAmountTotal);
  const d = money(j.discountTotal);
  const t = money(j.discountTax);
  if (d === null || t === null) {
    // 値割引が読めないときは、総計1 と CSV の差が1%以内かだけを見る
    const diff = gross > csv ? gross - csv : csv - gross;
    const ok = diff * 100n <= gross;
    return {
      status: ok ? 'skipped' : 'ng',
      left: yen(gross),
      right: yen(csv),
      note: ok
        ? '値割引が未入力のため厳密な検算はしていません（総計1とCSVの差は1%以内）。'
        : `値割引が未入力で、総計1 ${yen(gross)} 円と CSV の売上金額合計 ${yen(csv)} 円の差が1%を超えています。`,
    };
  }
  const left = add(gross, sub(ZERO, d), t);
  const ok = left === csv;
  return {
    status: ok ? 'ok' : 'ng',
    left: yen(left),
    right: yen(csv),
    note: ok ? '' : `総計1 − 値割引合計 + 値割引消費税 = ${yen(left)} 円が、CSV の売上金額合計 ${yen(csv)} 円と一致しません（差 ${yen(sub(left, csv))} 円）。`,
  };
}

/** 前月から大きく動いたら知らせる（要件§11.8「過去月からの大幅変動」） */
function checkTrend(issues: IssueCollector, prev: PreviousRealSales, realSales: Fixed, feeTotal: Fixed, qty: number): void {
  const ratio = (now: number, before: number): number | null => (before > 0 ? (now - before) / before : null);
  const items: IssueDetail[] = [];
  const pushIf = (name: string, now: number, before: number): void => {
    const r = ratio(now, before);
    if (r !== null && Math.abs(r) >= 0.2) items.push({ ref: {}, text: `${name} ${r > 0 ? '+' : ''}${(r * 100).toFixed(1)}%` });
  };
  pushIf('リアル売上', Number(toDecimalString(realSales)), Number(prev.realSales));
  pushIf('手数料合計', Number(toDecimalString(feeTotal)), Number(prev.feeTotal));
  pushIf('容器対象出数', qty, prev.containerQty);
  issues.addMany(
    'W031',
    items,
    (_n, d) => `前月（${prev.targetYm}）から20%以上動いた項目があります（${d.map((x) => x.text).join(' / ')}）。読み取り値や商品別売上CSVの月を確認してください。`,
  );
}
