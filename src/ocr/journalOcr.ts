/**
 * ジャーナル（店舗売上レポート）写真の読み取り（要件§11.3・§11.6）。
 *
 * 2026年8月の写真での技術検証に基づく方式:
 *  1. 影を消し、金額欄（右寄せ）の黒画素から行を切り出す
 *  2. 行ごとに、金額は数字専用の認識、ラベルは日本語・英字の認識にかける
 *     （日本語モデルは数字を誤読する）
 *  3. 前処理を変えた複数の画像で金額を読み、多数決をとる
 *  4. 検算で誤読を特定し、補正候補を出す
 *     ① 売掛欄の内訳の合計 = 売掛合計
 *     ② 総計1 − 値割引合計 + 値割引消費税 = 商品別売上CSVの売上金額合計
 *
 * 読み取り結果は「候補」であり、確定は必ず人が写真と見比べて行う（RS-04）。
 * 検算で補正した値・消去法で表記を決めた行には、その旨の注記を付けて返す。
 */
import { crop, findRowBands, flatten, resize, type Band, type Gray, type Rect } from './gray';
import { normalizeLabel } from '../domain/realSales/masters';

export interface OcrLine {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** 認識エンジン（ブラウザは Tesseract.js の Web Worker、テストは Node の Tesseract.js） */
export interface OcrBackend {
  /** 1行を数字として読む（0-9 , ¥ / のみ） */
  readDigits(img: Gray): Promise<string>;
  /** 1行を日本語として読む */
  readJpnLine(img: Gray): Promise<string>;
  /** 1行を英字として読む（menu など） */
  readEngLine(img: Gray): Promise<string>;
  /** 複数行の領域を日本語として読み、行ごとの位置を返す */
  readJpnBlock(img: Gray): Promise<OcrLine[]>;
}

export interface Candidate {
  /** 数字だけの表記（カンマ・円記号なし）。営業月は 'YYYY-MM' */
  value: string;
  votes: number;
  /** 検算で導いた値（OCR の読みには無かった） */
  derived?: boolean;
}

export interface OcrRow {
  index: number;
  /** 基準画像上の位置（照合表示で行の画像を切り出すのに使う） */
  rect: Rect;
  labelJpn: string;
  labelEng: string;
  candidates: Candidate[];
}

/** ocr: 多数決のまま / checked: 検算で裏付け / corrected: 検算で補正 / none: 読めず */
export type FieldSource = 'ocr' | 'checked' | 'corrected' | 'none';

export interface FieldReading {
  value: string | null;
  candidates: Candidate[];
  row: OcrRow | null;
  source: FieldSource;
  note?: string;
}

export interface ReceivableReading extends FieldReading {
  /** 照合後の表記（料率マスタ・対象外一覧の表記）。照合できなければ OCR の文字 */
  label: string;
  /** exact: 表記が一致 / elimination: 消去法で決めた / none: 決められなかった */
  labelBy: 'exact' | 'elimination' | 'none';
}

export interface JournalOcrResult {
  businessYm: FieldReading;
  storeName: string | null;
  grossTotal: FieldReading;
  discountTotal: FieldReading;
  discountTax: FieldReading;
  receivableTotal: FieldReading;
  receivables: ReceivableReading[];
  rows: OcrRow[];
  /** 照合表示用の基準画像（前処理済み） */
  base: Gray;
}

/** 売掛欄の表記の候補。id が同じ表記は同じもの（例: 麺と麵） */
export interface LabelGroup {
  id: string;
  labels: string[];
}

export interface OcrOptions {
  /** 売掛欄の表記として照合する候補（料率マスタのチャネル＋対象外の一覧） */
  receivableGroups: LabelGroup[];
  /** 商品別売上CSVの売上金額合計（検算②。無ければ省略） */
  csvAmountTotal?: number | null;
  onProgress?: (done: number, total: number, phase: string) => void;
}

/** 基準画像の横幅（画素）。写真の解像度によらずここにそろえる */
const BASE_WIDTH = 2400;
/** 金額を読む前処理の組み合わせ（基準画像に対する倍率と、影を消す窓の半径） */
const VARIANTS = [
  { scale: 1.0, radius: 0.022 },
  { scale: 0.75, radius: 0.022 },
  { scale: 1.0, radius: 0.045 },
] as const;
const UPSCALES = [2, 3] as const;
const MATCH = 0.6;

// ---------------------------------------------------------------------------
// 表記の照合
// ---------------------------------------------------------------------------

function lcs(a: string, b: string): number {
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** OCR の読み（余計な記号が混じる）と正しい表記の近さ。0〜1 */
export function labelScore(ocrText: string, label: string): number {
  const clean = (t: string): string => normalizeLabel(t).replace(/[^\p{L}\p{N}・]/gu, '');
  const a = clean(ocrText), b = clean(label);
  if (!a || !b) return 0;
  return lcs(a, b) / b.length;
}

function bestOf(texts: string[], groups: readonly LabelGroup[]): { id: string; label: string; score: number } {
  let best = { id: '', label: '', score: 0 };
  for (const t of texts) for (const g of groups) for (const l of g.labels) {
    const s = labelScore(t, l);
    if (s > best.score) best = { id: g.id, label: l, score: s };
  }
  return best;
}

// ---------------------------------------------------------------------------
// 金額の読み
// ---------------------------------------------------------------------------

/**
 * 数字専用認識の出力を「数字だけ」にする。
 * 先頭の 0（「¥6」の 6 を 0 と読む）も捨てずに残す。検算②で補正する手がかりになる。
 */
export function normalizeAmount(text: string): string | null {
  // 回数の欄（「12回」など）が混じることがあるので、最後の語の、円記号より後ろだけを見る
  const tokens = text.trim().split(/\s+/).filter((t) => /\d/.test(t));
  const last = tokens[tokens.length - 1];
  if (!last) return null;
  const t = last.split(/[¥￥\\]/).pop()!.replace(/^[^0-9]+/, '').replace(/[^0-9,]+$/, '');
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)$/.exec(t) ?? /(\d{1,3}(?:,\d{3})+)$/.exec(t);
  return m ? m[1]!.replace(/,/g, '') : null;
}

function vote(values: (string | null)[]): Candidate[] {
  const m = new Map<string, number>();
  for (const v of values) if (v !== null) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].map(([value, votes]) => ({ value, votes })).sort((a, b) => b.votes - a.votes);
}

/** 違う桁の数（桁数が違うときは増減した1桁を数える） */
function changedDigits(a: string, b: string): number {
  if (a.length !== b.length) return 1;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** 1〜2桁の読み違い、または先頭の1桁が増減しただけの差か */
export function closeDigits(read: string, truth: string): boolean {
  if (read === truth) return true;
  if (read.length === truth.length) {
    let d = 0;
    for (let i = 0; i < read.length; i++) if (read[i] !== truth[i]) d++;
    return d <= 2;
  }
  if (read.length === truth.length + 1) return read.slice(1) === truth;
  if (read.length + 1 === truth.length) return truth.slice(1) === read;
  return false;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/** 感熱紙の文字がある横の範囲（左端・右端）。写真の撮り方で変わるので毎回求める */
function textSpan(g: Gray, bands: Band[]): { left: number; right: number } {
  const cols = new Uint32Array(g.width);
  for (const b of bands) {
    for (let y = b.y0; y < b.y1; y++) {
      const row = y * g.width;
      for (let x = 0; x < g.width; x++) if (g.data[row + x]! < 150) cols[x]!++;
    }
  }
  let max = 0;
  for (const c of cols) if (c > max) max = c;
  const th = max * 0.08;
  let left = 0, right = g.width - 1;
  while (left < g.width && cols[left]! < th) left++;
  while (right > 0 && cols[right]! < th) right--;
  return { left, right };
}

/**
 * 行の中で、右端にある文字のかたまり（＝金額）の横の範囲を求める。
 * 2枚のレシートが重なって写ると上下で左右の位置がずれるため、行ごとに求める。
 * 回数の欄（「12回」など）とは間が空いているので、右端のかたまりだけを取れば金額になる。
 */
function amountExtent(g: Gray, b: Band, fromX: number): { left: number; right: number } | null {
  const x0 = Math.round(fromX);
  const cols: boolean[] = [];
  for (let x = x0; x < g.width; x++) {
    let c = 0;
    for (let y = b.y0; y < b.y1; y++) if (g.data[y * g.width + x]! < 150) c++;
    cols.push(c > 0);
  }
  const gap = Math.round(g.width * 0.025);
  let right = -1;
  for (let i = cols.length - 1; i >= 0; i--) if (cols[i]) { right = i; break; }
  if (right < 0) return null;
  let left = right, blank = 0;
  for (let i = right; i >= 0; i--) {
    if (cols[i]) { left = i; blank = 0; } else if (++blank > gap) break;
  }
  return { left: x0 + left, right: x0 + right };
}

export async function readJournal(photo: Gray, backend: OcrBackend, opts: OcrOptions): Promise<JournalOcrResult> {
  const base = flatten(resize(photo, BASE_WIDTH / photo.width), Math.round(BASE_WIDTH * VARIANTS[0].radius));
  const W = base.width, H = base.height;

  // 行の検出は2段階。まず画像の中ほどで粗く探して文字の横の範囲を求め、
  // そのうえで右側の金額欄で探し直す。
  const span = textSpan(base, findRowBands(base, W * 0.5, W * 0.8));
  const spanW = span.right - span.left;
  const amountFrom = span.left + spanW * 0.62;
  const bands = findRowBands(base, amountFrom, span.right).filter((b) => b.y1 - b.y0 < H * 0.05);

  const variants = VARIANTS.map((v, i) => ({
    img: i === 0 ? base : flatten(resize(photo, (BASE_WIDTH * v.scale) / photo.width), Math.round(BASE_WIDTH * v.scale * v.radius)),
    k: v.scale,
  }));

  const total = bands.length * (VARIANTS.length * UPSCALES.length + 2) + 1;
  let done = 0;
  const tick = (phase: string): void => opts.onProgress?.(++done, total, phase);

  const rows: OcrRow[] = [];
  for (const [index, b] of bands.entries()) {
    const pad = Math.round((b.y1 - b.y0) * 0.3);
    const rect: Rect = { left: span.left, top: b.y0 - pad, width: spanW, height: b.y1 - b.y0 + pad * 2 };
    const labelImg = crop(base, { ...rect, width: spanW * 0.5 });
    const labelJpn = (await backend.readJpnLine(labelImg)).trim();
    tick('表記');
    const labelEng = (await backend.readEngLine(labelImg)).trim();
    tick('表記');

    const ext = amountExtent(base, b, span.left + spanW * 0.5);
    const margin = (b.y1 - b.y0) * 0.6;
    const ax0 = ext ? ext.left - margin : amountFrom - spanW * 0.04;
    const ax1 = ext ? ext.right + margin : span.right + spanW * 0.06;
    const reads: (string | null)[] = [];
    for (const v of variants) {
      const a = crop(v.img, { left: ax0 * v.k, top: rect.top * v.k, width: (ax1 - ax0) * v.k, height: rect.height * v.k });
      for (const up of UPSCALES) {
        reads.push(normalizeAmount(await backend.readDigits(resize(a, up))));
        tick('金額');
      }
    }
    rows.push({ index, rect, labelJpn, labelEng, candidates: vote(reads) });
  }

  const fields = mapFields(rows, opts);
  const header = await readHeader(base, backend, fields.grossTotal.row?.rect.top ?? H * 0.3, span);
  tick('営業月');

  return { ...fields, businessYm: header.businessYm, storeName: header.storeName, rows, base };
}

// ---------------------------------------------------------------------------
// 行 → 項目
// ---------------------------------------------------------------------------

const GROSS = [{ id: 'gross', labels: ['総計1(税抜値割引前)', '総計1', '税抜値割引前'] }];
const DISCOUNT = [{ id: 'disc', labels: ['値割引合計', '割引合計'] }];
const DISCOUNT_TAX = [{ id: 'tax', labels: ['(値割引消費税)', '値割引消費税', '割引消費税'] }];
const SERVICE = [{ id: 'service', labels: ['サービス料'] }];
const RECEIVABLE = [{ id: 'recv', labels: ['売掛'] }];

const reading = (row: OcrRow | null): FieldReading => ({
  value: row?.candidates[0]?.value ?? null,
  candidates: row?.candidates ?? [],
  row,
  source: row?.candidates[0] ? 'ocr' : 'none',
});

export function mapFields(rows: OcrRow[], opts: OcrOptions): Pick<JournalOcrResult, 'grossTotal' | 'discountTotal' | 'discountTax' | 'receivableTotal' | 'receivables'> {
  const score = (r: OcrRow, g: LabelGroup[]): number => bestOf([r.labelJpn, r.labelEng], g).score;
  const argBest = (g: LabelGroup[], from = 0, to = rows.length): number => {
    let best = -1, s = MATCH;
    for (let i = Math.max(0, from); i < Math.min(rows.length, to); i++) {
      const v = score(rows[i]!, g);
      if (v >= s) { s = v; best = i; }
    }
    return best;
  };
  const at = (i: number): OcrRow | null => (i >= 0 && i < rows.length ? rows[i]! : null);
  const paren = (r: OcrRow): boolean => /^[\s|「。]*[(（]/.test(r.labelJpn) || /^[\s|]*[(（]/.test(r.labelEng);

  // --- 売掛欄の内訳 ---
  // 括弧つきの行が続くかたまりのうち、表記が売掛欄の候補にいちばん多く一致したもの。
  // 「売掛」の文字そのものは崩れやすい（「売 持」と読まれた）ので、内訳の側から範囲を決める。
  const hit = rows.map((r) => score(r, opts.receivableGroups) >= MATCH);
  let first = -1, last = -1, bestHits = 0;
  for (let a = 0; a < rows.length; ) {
    if (!(hit[a] || paren(rows[a]!))) { a++; continue; }
    let b = a;
    while (b + 1 < rows.length && (hit[b + 1] || paren(rows[b + 1]!))) b++;
    const n = hit.slice(a, b + 1).filter(Boolean).length;
    if (n > bestHits) { bestHits = n; first = a; last = b; }
    a = b + 1;
  }
  const iRecv = first > 0 ? first - 1 : argBest(RECEIVABLE);

  // --- 上段 ---
  // 並びは 総計1 → 値割引合計 → (値割引消費税) → 消費税 → サービス料。
  // 総計1 などの表記は崩れやすいが「サービス料」はきれいに読めるので、そこから位置で決める。
  const limit = iRecv >= 0 ? iRecv : rows.length;
  let iGross = argBest(GROSS, 0, limit);
  if (iGross < 0) {
    const iService = argBest(SERVICE, 0, limit);
    if (iService >= 4) iGross = iService - 4;
  }
  if (iGross < 0) iGross = rows.findIndex((r, i) => i < limit && (r.candidates[0]?.value.length ?? 0) >= 6);
  const after = (g: LabelGroup[], from: number): number => {
    if (from < 0) return -1;
    const b = argBest(g, from, Math.min(limit, from + 2));
    return b >= 0 ? b : from;
  };
  const iDisc = iGross >= 0 ? after(DISCOUNT, iGross + 1) : -1;
  const iDiscTax = iDisc >= 0 ? after(DISCOUNT_TAX, iDisc + 1) : -1;

  const receivables = first >= 0 ? labelReceivables(rows.slice(first, last + 1), opts.receivableGroups) : [];
  const out = {
    grossTotal: reading(at(iGross)),
    discountTotal: reading(at(iDisc)),
    discountTax: reading(at(iDiscTax)),
    receivableTotal: reading(at(iRecv)),
    receivables,
  };
  solveReceivables(out.receivables, out.receivableTotal);
  solveGross(out.grossTotal, out.discountTotal, out.discountTax, opts.csvAmountTotal ?? null);
  return out;
}

/**
 * 内訳の各行に表記を付ける。一致しなかった行が1つだけで、まだ現れていない候補も1つだけ、
 * かつ多少でも似ているなら、消去法でその表記にする（注記を付け、人の確認に委ねる）。
 */
function labelReceivables(rows: OcrRow[], groups: LabelGroup[]): ReceivableReading[] {
  const out: ReceivableReading[] = rows.map((r) => {
    const m = bestOf([r.labelJpn, r.labelEng], groups);
    const ok = m.score >= MATCH;
    return {
      ...reading(r),
      label: ok ? m.label : (r.labelJpn.replace(/^[(（|「。\s]+/, '').replace(/\s/g, '') || r.labelEng),
      labelBy: ok ? 'exact' : 'none',
      _id: ok ? m.id : '',
    } as ReceivableReading & { _id: string };
  });
  const seen = new Set(out.map((o) => (o as ReceivableReading & { _id: string })._id).filter(Boolean));
  const open = out.filter((o) => o.labelBy === 'none');
  const missing = groups.filter((g) => !seen.has(g.id));
  if (open.length === 1 && missing.length >= 1) {
    const o = open[0]!;
    const r = o.row!;
    const ranked = missing
      .map((g) => ({ g, s: Math.max(...g.labels.map((l) => Math.max(labelScore(r.labelJpn, l), labelScore(r.labelEng, l)))) }))
      .sort((a, b) => b.s - a.s);
    if (ranked[0]!.s >= 0.3 && (ranked.length === 1 || ranked[0]!.s > ranked[1]!.s)) {
      o.label = ranked[0]!.g.labels[0]!;
      o.labelBy = 'elimination';
      o.note = `表記を読み取れなかったため、まだ現れていない「${o.label}」と判断しました（消去法）。写真で確認してください。`;
    }
  }
  for (const o of out) delete (o as Partial<ReceivableReading & { _id: string }>)._id;
  return out;
}

// ---------------------------------------------------------------------------
// 検算で誤読を正す
// ---------------------------------------------------------------------------

function setValue(f: FieldReading, value: string, source: FieldSource, note?: string): void {
  if (!f.candidates.some((c) => c.value === value)) f.candidates = [...f.candidates, { value, votes: 0, derived: true }];
  f.value = value;
  f.source = source;
  if (note) f.note = note;
}

const fmt = (v: string | null): string => (v === null ? '空欄' : v.replace(/\B(?=(\d{3})+(?!\d))/g, ','));

/**
 * 検算①: 内訳の合計 = 売掛合計。
 *  1. 多数決の上位候補の組み合わせで成立するものを探す
 *  2. 無ければ「1項目だけ誤読」とみなし、売掛合計から他の項目を引いた値を求める。
 *     それが読んだ値と1〜2桁しか違わなければ補正候補にする（売掛合計の側の誤読も同様）
 * 解が1つに決まったときだけ採用する。決まらなければ多数決のまま人に委ねる。
 */
export function solveReceivables(items: FieldReading[], total: FieldReading): void {
  if (items.length === 0 || total.candidates.length === 0 || items.some((i) => i.candidates.length === 0)) return;
  const top3 = (f: FieldReading): string[] => f.candidates.slice(0, 3).map((c) => c.value);
  const votesOf = (f: FieldReading, v: string): number => f.candidates.find((c) => c.value === v)?.votes ?? 0;

  // 1. 上位候補の組み合わせ
  const exact: { values: string[]; total: string; votes: number }[] = [];
  const choices = items.map(top3);
  const idx = new Array<number>(choices.length).fill(0);
  for (;;) {
    const vals = idx.map((k, i) => choices[i]![k]!);
    const sum = vals.reduce((a, v) => a + BigInt(v), 0n).toString();
    if (top3(total).includes(sum)) {
      exact.push({ values: vals, total: sum, votes: vals.reduce((a, v, i) => a + votesOf(items[i]!, v), 0) + votesOf(total, sum) });
    }
    let p = 0;
    while (p < idx.length && ++idx[p]! >= choices[p]!.length) idx[p++] = 0;
    if (p === idx.length) break;
  }
  if (exact.length > 0) {
    exact.sort((a, b) => b.votes - a.votes);
    if (exact.length > 1 && exact[1]!.votes === exact[0]!.votes) return;
    applyAll(items, total, exact[0]!.values, exact[0]!.total);
    return;
  }

  // 2. 1項目だけの誤読。合計との差が「1桁の違い」だと、5桁以上のどの項目を直しても
  //    成立してしまう（差が 30,000 なら menu も ナカペイ も候補になる）。
  //    そこで、複数の前処理で読みが割れていた項目を誤読とみなす。割れていたのが1つだけのときに限る
  const tops = items.map((f) => f.candidates[0]!.value);
  const tTop = total.candidates[0]!.value;
  const sumTops = tops.reduce((a, v) => a + BigInt(v), 0n);
  const share = (f: FieldReading): number => f.candidates[0]!.votes / f.candidates.reduce((a, c) => a + c.votes, 0);
  const fixes: { k: number; v: string; share: number; changed: number }[] = [];
  items.forEach((f, k) => {
    const v = BigInt(tTop) - (sumTops - BigInt(tops[k]!));
    if (v > 0n && closeDigits(tops[k]!, v.toString())) fixes.push({ k, v: v.toString(), share: share(f), changed: changedDigits(tops[k]!, v.toString()) });
  });
  const totalFix = sumTops.toString();
  if (closeDigits(tTop, totalFix)) fixes.push({ k: -1, v: totalFix, share: share(total), changed: changedDigits(tTop, totalFix) });
  if (fixes.length === 0) return;
  // 直す桁が少ないものを優先し、同じなら読みが割れていたものを選ぶ
  const fewest = Math.min(...fixes.map((f) => f.changed));
  const pool = fixes.filter((f) => f.changed === fewest).sort((a, b) => a.share - b.share);
  const pick = pool[0]!;
  // いちばん割れていた項目が、次点よりはっきり割れているときだけ採用する
  if (pool.length > 1 && pool[1]!.share - pick.share < 0.3) return;
  if (pick.k >= 0) {
    const values = [...tops];
    values[pick.k] = pick.v;
    applyAll(items, total, values, tTop);
  } else {
    applyAll(items, total, tops, totalFix);
  }
}

function applyAll(items: FieldReading[], total: FieldReading, values: string[], sum: string): void {
  items.forEach((f, i) => {
    const v = values[i]!;
    if (v === f.value) setValue(f, v, 'checked');
    else setValue(f, v, 'corrected', `検算①（売掛合計）で ${fmt(f.value)} を ${fmt(v)} に補正しました。写真で確認してください。`);
  });
  if (sum === total.value) setValue(total, sum, 'checked');
  else setValue(total, sum, 'corrected', `検算①（内訳の合計）で ${fmt(total.value)} を ${fmt(sum)} に補正しました。写真で確認してください。`);
}

/**
 * 検算②: 総計1 − 値割引合計 + 値割引消費税 = CSV の売上金額合計。
 * 値割引の読みの組み合わせごとに「総計1 のあるべき値」を求め、
 * 総計1 の候補そのものか、候補と1〜2桁しか違わない値なら採用する。
 */
export function solveGross(gross: FieldReading, disc: FieldReading, tax: FieldReading, csvTotal: number | null): void {
  if (csvTotal === null || disc.candidates.length === 0 || tax.candidates.length === 0) return;
  const grossTop = gross.candidates.slice(0, 3).map((c) => c.value);
  const hits: { g: string; d: string; t: string; exact: boolean; votes: number }[] = [];
  for (const d of disc.candidates.slice(0, 3)) {
    for (const t of tax.candidates.slice(0, 3)) {
      const g = (BigInt(csvTotal) + BigInt(d.value) - BigInt(t.value)).toString();
      const exact = grossTop.includes(g);
      if (exact || grossTop.some((r) => closeDigits(r, g))) {
        hits.push({ g, d: d.value, t: t.value, exact, votes: d.votes + t.votes + (gross.candidates.find((c) => c.value === g)?.votes ?? 0) });
      }
    }
  }
  if (hits.length === 0) return;
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || b.votes - a.votes);
  const h = hits[0]!;
  const apply = (f: FieldReading, v: string, name: string): void => {
    if (f.value === v) setValue(f, v, 'checked');
    else setValue(f, v, 'corrected', `検算②（商品別売上CSV）で${name}を ${fmt(f.value)} から ${fmt(v)} に補正しました。写真で確認してください。`);
  };
  apply(gross, h.g, '総計1');
  apply(disc, h.d, '値割引合計');
  apply(tax, h.t, '値割引消費税');
}

// ---------------------------------------------------------------------------
// 見出し（営業月・店舗名）
// ---------------------------------------------------------------------------

async function readHeader(
  base: Gray,
  backend: OcrBackend,
  bottom: number,
  span: { left: number; right: number },
): Promise<{ businessYm: FieldReading; storeName: string | null }> {
  const region: Rect = { left: span.left, top: 0, width: span.right - span.left, height: Math.max(10, bottom) };
  const lines = await backend.readJpnBlock(crop(base, region));

  let storeName: string | null = null;
  const yms: string[] = [];
  const push = (y: string, m: string): void => {
    if (Number(m) >= 1 && Number(m) <= 12) yms.push(`${y}-${m.padStart(2, '0')}`);
  };
  for (const l of lines) {
    const t = l.text.replace(/\s/g, '');
    if (!storeName && /店舗/.test(t)) {
      const s = t.split(/[:：]/).slice(1).join('').trim();
      if (s) storeName = s;
    }
    if (/営業|業月/.test(t)) {
      const m = /(20\d{2})[/／年7]?(\d{1,2})(?!\d)/.exec(t.split(/[:：]/).slice(1).join('') || t);
      if (m) push(m[1]!, m[2]!);
      // 同じ行を数字だけで読み直す（日本語モデルは / を 7 と読むことがある）。2票として数える
      const lineImg = crop(base, { left: region.left + l.bbox.x0, top: region.top + l.bbox.y0 - 6, width: l.bbox.x1 - l.bbox.x0, height: l.bbox.y1 - l.bbox.y0 + 12 });
      const d = (await backend.readDigits(resize(lineImg, 2))).replace(/\s/g, '');
      const m2 = /(20\d{2})\/(\d{1,2})(?!\d)/.exec(d);
      if (m2) { push(m2[1]!, m2[2]!); push(m2[1]!, m2[2]!); }
    }
  }
  const candidates = vote(yms);
  return {
    businessYm: { value: candidates[0]?.value ?? null, candidates, row: null, source: candidates[0] ? 'ocr' : 'none' },
    storeName,
  };
}
