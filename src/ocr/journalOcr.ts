/**
 * ジャーナル（店舗売上レポート）写真の読み取り（要件§11.3・§11.6）。
 *
 * 2段構えで読む。
 *  1. **写真全体を文字として読む**（日本語＋英字）。行ごとの文字列と、その位置が得られる。
 *     項目の割り当ては、この文字列と登録済みの表記との照合だけで決める。
 *  2. 行ごとに**金額の欄だけを数字専用で読み直す**。前処理を変えた複数の画像で読み、多数決をとる
 *     （日本語モデルは数字を誤読し、数字専用モデルは日本語を読めないため、役割を分ける）
 *  3. 検算で誤読を特定し、補正候補を出す
 *     ① 売掛欄の内訳の合計 = 売掛合計
 *     ② 総計1 − 値割引合計 + 値割引消費税 = 商品別売上CSVの売上金額合計
 *
 * **位置や並び順には頼らない**（2026-10-28 変更）。以前は金額欄の黒画素から行を切り出し、
 * 「サービス料の4行上が総計1」のように位置で決めていたが、写真の撮り方やレシートの重なりが
 * 変わると総計1すら取れなくなった。全文から表記で照合する方式に改めた。
 *
 * 読み取り結果は「候補」であり、確定は必ず人が写真と見比べて行う（RS-04）。
 * 読み取った行はすべて返す。画面では行の画像・読んだ文字列・金額を並べて照合できる。
 */
import { crop, flatten, resize, type Band, type Gray, type Rect } from './gray';
import { normalizeLabel } from '../domain/realSales/masters';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrPageWord {
  text: string;
  bbox: Box;
}

/** 全文認識が返す1行 */
export interface OcrPageLine {
  text: string;
  bbox: Box;
  words: OcrPageWord[];
}

/** 認識エンジン（ブラウザは Tesseract.js の Web Worker、テストは Node の Tesseract.js） */
export interface OcrBackend {
  /** 写真全体を日本語＋英字として読み、行と語の位置を返す */
  readPage(img: Gray): Promise<OcrPageLine[]>;
  /** 1行を数字として読む（0-9 , ¥ / のみ） */
  readDigits(img: Gray): Promise<string>;
  /** 1行を日本語として読む。全文で読み落とした表記を読み直すのに使う */
  readLine(img: Gray): Promise<string>;
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
  /** 全文認識が読んだ行そのまま。画面に出して写真と見比べてもらう */
  text: string;
  /** 金額より左の部分。表記の照合に使う */
  label: string;
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
  /** 読み取った行すべて（照合用）。項目に割り当てられなかった行も含む */
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
const BASE_WIDTH = 3200;
/** 金額を数字として読み直すときの画像の横幅 */
const DIGIT_WIDTH = 2400;
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

/**
 * 行の中の文字のかたまり（列方向に間が空いていないまとまり）を左から並べて返す。
 * ジャーナルの行は「表記 … 回数 … 金額」と間を空けて並ぶので、最後のかたまりが金額になる。
 */
function clusters(g: Gray, b: Band, fromX: number, toX: number, gapLimit: number): { left: number; right: number }[] {
  const x0 = Math.max(0, Math.round(fromX));
  const x1 = Math.min(g.width, Math.round(toX));
  const out: { left: number; right: number }[] = [];
  let start = -1, blank = 0;
  for (let x = x0; x < x1; x++) {
    let dark = false;
    for (let y = b.y0; y < b.y1 && !dark; y++) if (g.data[y * g.width + x]! < 150) dark = true;
    if (dark) {
      if (start < 0) start = x;
      blank = 0;
    } else if (start >= 0 && ++blank > gapLimit) {
      out.push({ left: start, right: x - blank });
      start = -1;
      blank = 0;
    }
  }
  if (start >= 0) out.push({ left: start, right: x1 - 1 });
  return out;
}

/**
 * 金額の縦の範囲を画素で詰める。全文認識が返す行の枠は上下に余白が付いたり欠けたりするので、
 * 金額の欄の黒画素だけを見て、文字がきっちり入る高さにする（数字専用の認識はこれで精度が上がる）。
 */
function tighten(g: Gray, b: Band, left: number, right: number, centerY: number): Band {
  const x0 = Math.max(0, Math.round(left)), x1 = Math.min(g.width, Math.round(right) + 1);
  const counts: number[] = [];
  for (let y = b.y0; y < b.y1; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) if (g.data[y * g.width + x]! < 150) c++;
    counts.push(c);
  }
  // 重なったレシートの行が枠に入り込むことがあるので、いちばん濃い行ではなく
  // 全文認識が返した行の中心から上下に広げる
  const c0 = Math.min(counts.length - 1, Math.max(0, Math.round(centerY - b.y0)));
  if (counts.length === 0 || counts[c0] === undefined || counts[c0]! === 0) return b;
  let y0 = c0, y1 = c0;
  while (y0 > 0 && counts[y0 - 1]! > 0) y0--;
  while (y1 + 1 < counts.length && counts[y1 + 1]! > 0) y1++;
  const pad = Math.max(4, Math.round((y1 - y0) * 0.3));
  return { y0: Math.max(0, b.y0 + y0 - pad), y1: Math.min(g.height, b.y0 + y1 + 1 + pad) };
}

export async function readJournal(photo: Gray, backend: OcrBackend, opts: OcrOptions): Promise<JournalOcrResult> {
  const base = flatten(resize(photo, BASE_WIDTH / photo.width), Math.round(BASE_WIDTH * VARIANTS[0].radius));
  const W = base.width, H = base.height;

  const pageLines = (await backend.readPage(base)).filter((l) => {
    const h = l.bbox.y1 - l.bbox.y0;
    return l.text.trim() !== '' && h > 6 && h < H * 0.08;
  });
  const lines = [...pageLines].sort((a, b) => a.bbox.y0 - b.bbox.y0);

  // 文字がある横の範囲。金額はこの範囲の右寄りにあるので、どの行も同じ位置から右を探す。
  // 行ごとの枠から決めると、枠が金額の途中から始まる行で先頭の桁を切り落としてしまう。
  const spanLeft = Math.min(...lines.map((l) => l.bbox.x0), W);
  const spanRight = Math.max(...lines.map((l) => l.bbox.x1), 0);
  const amountFrom = spanLeft + (spanRight - spanLeft) * 0.5;

  // 金額を読む画像は基準画像より小さくする。文字を大きく写しすぎると数字の認識が落ちる
  // （全文の方は表記を読むため大きめが要る）。k は基準画像の座標をこの画像の座標へ直す倍率。
  const variants = VARIANTS.map((v) => ({
    img: flatten(resize(photo, (DIGIT_WIDTH * v.scale) / photo.width), Math.round(DIGIT_WIDTH * v.scale * v.radius)),
    k: (DIGIT_WIDTH * v.scale) / BASE_WIDTH,
  }));

  const total = lines.length * VARIANTS.length * UPSCALES.length + 2;
  let done = 1;
  opts.onProgress?.(done, total, '全文');
  const tick = (phase: string): void => opts.onProgress?.(++done, total, phase);

  const rows: OcrRow[] = [];
  /** 行ごとの、表記がある左側の範囲（読み直すときに使う） */
  const labelRegions: { left: number; width: number }[] = [];
  for (const [index, l] of lines.entries()) {
    const h = l.bbox.y1 - l.bbox.y0;
    const pad = Math.round(h * 0.45);
    const band: Band = { y0: Math.max(0, Math.round(l.bbox.y0 - pad)), y1: Math.min(H, Math.round(l.bbox.y1 + pad)) };
    const rect: Rect = { left: Math.max(0, l.bbox.x0 - pad), top: band.y0, width: Math.min(W, l.bbox.x1 + pad) - Math.max(0, l.bbox.x0 - pad), height: band.y1 - band.y0 };

    // 金額の欄: 語の位置で当たりを付け、画素で左右の端を詰める
    // 金額の欄: 行の中ほどから右を見て、右端の文字のかたまりを金額とする。
    // 語の位置（全文認識）は数字の途中で切れることがあるので、左端の当たりには使わない。
    const margin = h * 0.6;
    const cs = clusters(base, band, l.bbox.x0 - margin, Math.max(l.bbox.x1 + margin, amountFrom + margin), Math.max(W * 0.015, h * 0.7));
    const last = cs[cs.length - 1];
    const ax0 = last ? last.left - margin : amountFrom;
    const ax1 = last ? last.right + margin : l.bbox.x1 + margin;
    const tight = last ? tighten(base, band, ax0, ax1, (l.bbox.y0 + l.bbox.y1) / 2) : band;

    // 全文認識が読んだ金額も票に入れる（2票）。数字専用とは別のモデルなので、
    // 片方が誤読しても、もう片方の読みが候補に残り、検算で正せるようになる。
    const pageAmount = normalizeAmount(l.text.replace(/\s+/g, ' ').replace(/([\d,])\s+(?=[\d,])/g, '$1'));
    const reads: (string | null)[] = [pageAmount, pageAmount];
    for (const v of variants) {
      const a = crop(v.img, { left: ax0 * v.k, top: tight.y0 * v.k, width: (ax1 - ax0) * v.k, height: (tight.y1 - tight.y0) * v.k });
      for (const up of UPSCALES) {
        reads.push(normalizeAmount(await backend.readDigits(resize(a, up))));
        tick('金額');
      }
    }

    // 表記は金額より左の語だけから作る（金額や回数の数字を表記に混ぜない）
    const label = l.words
      .filter((w) => w.text.trim() !== '' && w.bbox.x1 <= ax0 + margin)
      .map((w) => w.text)
      .join('')
      .trim() || l.text.replace(/\s/g, '');

    rows.push({ index, rect, text: l.text.replace(/\s+/g, ' ').trim(), label, candidates: vote(reads) });
    // 表記は行の枠ではなく、レシートの左端から金額の手前までを見る
    // （表記が薄くて全文に出なかった行は、枠が金額から始まってしまう）
    labelRegions.push({ left: spanLeft, width: Math.max(10, ax0 - margin - spanLeft) });
  }

  // 全文認識は薄い表記を落とすことがある（金額だけの行になる）。
  // 売掛欄の内訳らしい行のうち表記が照合できなかったものだけ、左側をもう一度読む。
  for (const [i, r] of rows.entries()) {
    if (!paren(r)) continue;
    if (bestOf([r.label, r.text], opts.receivableGroups).score >= MATCH) continue;
    const reg = labelRegions[i]!;
    const img = crop(base, { left: reg.left, top: r.rect.top, width: reg.width, height: r.rect.height });
    const t = (await backend.readLine(resize(img, 1.5))).trim();
    if (t) r.label = `${r.label} ${t}`.trim();
  }

  const fields = mapFields(rows, opts);
  const header = await readHeader(base, backend, rows);
  tick('営業月');

  return { ...fields, businessYm: header.businessYm, storeName: header.storeName, rows, base };
}

// ---------------------------------------------------------------------------
// 行 → 項目
// ---------------------------------------------------------------------------

const GROSS = [{ id: 'gross', labels: ['総計1(税抜値割引前)', '総計1', '税抜値割引前'] }];
const DISCOUNT = [{ id: 'disc', labels: ['値割引合計', '割引合計'] }];
const DISCOUNT_TAX = [{ id: 'tax', labels: ['(値割引消費税)', '値割引消費税', '割引消費税'] }];
const RECEIVABLE = [{ id: 'recv', labels: ['売掛'] }];

const reading = (row: OcrRow | null): FieldReading => ({
  value: row?.candidates[0]?.value ?? null,
  candidates: row?.candidates ?? [],
  row,
  source: row?.candidates[0] ? 'ocr' : 'none',
});

/** 括弧でくくられた行（売掛欄の内訳はこの形。前後どちらかの括弧が読めれば拾う） */
function paren(r: OcrRow): boolean {
  const t = r.text.replace(/\s/g, '');
  return /^[「。|]*[(（]/.test(t) || /[)）]$/.test(t);
}

export function mapFields(rows: OcrRow[], opts: OcrOptions): Pick<JournalOcrResult, 'grossTotal' | 'discountTotal' | 'discountTax' | 'receivableTotal' | 'receivables'> {
  const score = (r: OcrRow, g: LabelGroup[]): number => bestOf([r.label, r.text], g).score;
  // 同じ行を2つの項目に割り当てない。表記が崩れると「総計1(税抜値割引前)」の行が
  // 「値割引合計」にも 0.6 で一致してしまい、値割引が総計1の金額になることがあった。
  const taken = new Set<number>();
  const argBest = (g: LabelGroup[], from = 0, to = rows.length): number => {
    let best = -1, s = MATCH;
    for (let i = Math.max(0, from); i < Math.min(rows.length, to); i++) {
      if (taken.has(i)) continue;
      const v = score(rows[i]!, g);
      if (v >= s) { s = v; best = i; }
    }
    if (best >= 0) taken.add(best);
    return best;
  };
  const at = (i: number): OcrRow | null => (i >= 0 && i < rows.length ? rows[i]! : null);

  // --- 売掛欄の内訳 ---
  // 「売掛」の行を見つけ、そのすぐ下に続く括弧つき（または表記が一致する）行を内訳とする。
  // 売掛の文字が読めなかったときは、表記が一致する行がいちばん多いかたまりを使う。
  const hit = rows.map((r) => score(r, opts.receivableGroups) >= MATCH);
  const iRecv = argBest(RECEIVABLE);
  if (iRecv >= 0) for (let i = iRecv; i < rows.length; i++) taken.add(i);
  let first = -1, last = -1;
  if (iRecv >= 0) {
    let b = iRecv;
    while (b + 1 < rows.length && (hit[b + 1] || paren(rows[b + 1]!))) b++;
    if (b > iRecv) { first = iRecv + 1; last = b; }
  }
  if (first < 0) {
    let bestHits = 0;
    for (let a = 0; a < rows.length; ) {
      if (!(hit[a] || paren(rows[a]!))) { a++; continue; }
      let b = a;
      while (b + 1 < rows.length && (hit[b + 1] || paren(rows[b + 1]!))) b++;
      const n = hit.slice(a, b + 1).filter(Boolean).length;
      if (n > bestHits) { bestHits = n; first = a; last = b; }
      a = b + 1;
    }
  }

  // --- 上段 ---
  // 総計1・値割引合計・（値割引消費税）は表記の照合だけで決める（位置には頼らない）。
  // 総計1 がどうしても読めないときだけ、売掛より上で桁数がいちばん多い行を候補にする。
  const limit = first > 0 ? first : rows.length;
  let iGross = argBest(GROSS, 0, limit);
  if (iGross < 0) {
    let bestLen = 5;
    for (let i = 0; i < limit; i++) {
      const len = rows[i]!.candidates[0]?.value.length ?? 0;
      if (len > bestLen) { bestLen = len; iGross = i; }
    }
  }
  // 値割引の2行は表記が崩れやすい（「EIE [AE」などと読まれる）。
  // 照合できなければ、総計1 のすぐ下2行までを順に当てる。総計1 より小さい額であることを条件にする。
  const smaller = (i: number): boolean => {
    const a = rows[i]?.candidates[0]?.value, g = at(iGross)?.candidates[0]?.value;
    return !!a && (!g || a.length < g.length);
  };
  const near = (groups: LabelGroup[], from: number): number => {
    const b = argBest(groups, 0, limit);
    if (b >= 0) return b;
    if (from < 0 || from >= limit || taken.has(from) || !smaller(from)) return -1;
    taken.add(from);
    return from;
  };
  const iDisc = near(DISCOUNT, iGross + 1);
  const iDiscTax = near(DISCOUNT_TAX, iDisc >= 0 ? iDisc + 1 : -1);

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
    const m = bestOf([r.label, r.text], groups);
    const ok = m.score >= MATCH;
    return {
      ...reading(r),
      label: ok ? m.label : (r.label.replace(/^[(（|「。\s]+/, '').replace(/\s/g, '') || r.text),
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
      .map((g) => ({ g, s: Math.max(...g.labels.map((l) => Math.max(labelScore(r.label, l), labelScore(r.text, l)))) }))
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
  //    売掛合計そのものも誤読されうるので、合計は多数決の上位3候補まで試す
  //    （項目と合計が同時に誤読されたとき、合計の2位の候補が正しいことがある）
  const tops = items.map((f) => f.candidates[0]!.value);
  const sumTops = tops.reduce((a, v) => a + BigInt(v), 0n);
  const share = (f: FieldReading): number => f.candidates[0]!.votes / f.candidates.reduce((a, c) => a + c.votes, 0);
  const fixes: { k: number; v: string; total: string; share: number; changed: number; totalRank: number }[] = [];
  total.candidates.slice(0, 3).forEach((tc, totalRank) => {
    items.forEach((f, k) => {
      const v = BigInt(tc.value) - (sumTops - BigInt(tops[k]!));
      const changed = v > 0n ? changedDigits(tops[k]!, v.toString()) : 99;
      // 売掛合計そのものも多数決の1位でないときは、項目の方も1桁違いまでしか認めない。
      // どちらの読みも弱い状態で2桁直すと、もっともらしい別の値に確定してしまう。
      if (v > 0n && closeDigits(tops[k]!, v.toString()) && !(changed >= 2 && totalRank > 0)) {
        fixes.push({ k, v: v.toString(), total: tc.value, share: share(f), changed, totalRank });
      }
    });
  });
  const totalFix = sumTops.toString();
  const tTop = total.candidates[0]!.value;
  if (closeDigits(tTop, totalFix)) fixes.push({ k: -1, v: totalFix, total: totalFix, share: share(total), changed: changedDigits(tTop, totalFix), totalRank: 0 });
  if (fixes.length === 0) return;
  // 直す桁が少ないものを優先し、同じなら読みが割れていたもの、合計の候補順位が高いものを選ぶ
  const fewest = Math.min(...fixes.map((f) => f.changed));
  const pool = fixes.filter((f) => f.changed === fewest).sort((a, b) => a.share - b.share || a.totalRank - b.totalRank);
  const pick = pool[0]!;
  // いちばん割れていた項目が、次点よりはっきり割れているときだけ採用する（同じ項目の別解は除く）
  const rival = pool.find((f) => f.k !== pick.k);
  if (rival && rival.share - pick.share < 0.3) return;
  if (pick.k >= 0) {
    const values = [...tops];
    values[pick.k] = pick.v;
    applyAll(items, total, values, pick.total);
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
  rows: OcrRow[],
): Promise<{ businessYm: FieldReading; storeName: string | null }> {
  let storeName: string | null = null;
  const yms: string[] = [];
  const push = (y: string, m: string): void => {
    if (Number(m) >= 1 && Number(m) <= 12) yms.push(`${y}-${m.padStart(2, '0')}`);
  };
  for (const r of rows) {
    const t = r.text.replace(/\s/g, '');
    if (!storeName && /店舗/.test(t)) {
      const s = t.split(/[:：]/).slice(1).join('').trim();
      if (s) storeName = s;
    }
    // 「印刷日時」も年月を含むので、営業月の行だけを見る
    if (/営業|業月/.test(t) && !/印刷/.test(t)) {
      const m = /(20\d{2})[/／年7]?(\d{1,2})(?!\d)/.exec(t.split(/[:：]/).slice(1).join('') || t);
      if (m) push(m[1]!, m[2]!);
      // 同じ行を数字だけで読み直す（日本語モデルは / を 7 と読み、2026 を Z0Z5 と読む）。2票として数える
      const d = (await backend.readDigits(resize(crop(base, r.rect), 2))).replace(/\s/g, '');
      const m2 = /(20\d{2})[/]?(\d{1,2})(?!\d)/.exec(d);
      if (m2) { push(m2[1]!, m2[2]!); push(m2[1]!, m2[2]!); }
    }
  }
  const candidates = vote(yms);
  return {
    businessYm: { value: candidates[0]?.value ?? null, candidates, row: null, source: candidates[0] ? 'ocr' : 'none' },
    storeName,
  };
}
