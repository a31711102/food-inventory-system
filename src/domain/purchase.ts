/**
 * 期中仕入の算出。
 *
 *   換算後数量 = 発注数 × 換算係数
 *   期中仕入 (H列) = Σ(当該商品コードの換算後数量)
 *
 * 換算係数は**単位計算マスタの「計算単位」**を正とする。業務フロー（要件§3-3）がそう定めており、
 * 実データでも発注された146商品すべてを網羅していた（当月マスタP列は112商品どまり）。
 * 当月マスタP列はフォールバック兼検証として使い、食い違えば W009 を出す。
 * なお P列は帳票上で非表示にされており、店舗側からは確認・保守できない。
 *
 * 換算できない行はゼロ扱いにせず E005 を出して出力確定を止める（要件§5・受入条件3）。
 */
import type { ProductRow, OrderLine, UnitConversionEntry } from './models';
import { isSupplyCode } from './productKind';
import { IssueCollector, summarize, type IssueDetail, type ValidationIssue } from './issues';

export interface ConvertResult {
  lines: OrderLine[];
  issues: ValidationIssue[];
}

export interface ConvertOptions {
  fileName?: string;
}

/** 換算係数の取得元。優先順位は 確認済み → 単位計算マスタ → 当月マスタP列。 */
export interface FactorSources {
  /**
   * 画面で管理者が確認・登録した換算係数（最優先）。
   * 新規商品は単位計算マスタに載っていないことがあるため、その場で登録できるようにする。
   * 登録した値は履歴に保存され、次月以降も使われる。
   */
  confirmed?: ReadonlyMap<string, number>;
  /**
   * 単位計算マスタ（正）。
   * 業務フロー（要件§3-3）が「発注累計照会と単位計算マスタを突合して換算する」と定めている。
   * ただし新商品は載っていないことがあり、8月版では7月の発注131商品のうち15商品を引けなかった。
   */
  unitMaster: ReadonlyMap<string, UnitConversionEntry>;
  /**
   * 当月マスタ 入力用 P列（仕入れ単位）。フォールバック兼検証。
   * このマップのキー集合は「当月の棚卸対象商品」そのものであり、集計対象かどうかの判定にも使う。
   * なお P列は帳票上で非表示にされており、店舗側からは確認・保守できない。
   */
  masterP: ReadonlyMap<string, number>;
}

function isUsableFactor(factor: number | null | undefined): factor is number {
  return factor !== null && factor !== undefined && Number.isFinite(factor) && factor > 0;
}

/**
 * 発注明細に換算係数を適用する。
 *
 * 優先順位:
 *   1. 単位計算マスタ（正）
 *   2. 当月マスタ P列（単位計算マスタに無い／値が不正なときのフォールバック。W016）
 *   3. どちらからも取れず、かつ棚卸対象商品なら E005 で停止
 *
 * 棚卸対象外の商品（実データでは消耗品・容器類が34件）は、換算できなくても E005 にしない。
 * 集計に入らない商品であり、これを BLOCKING にすると毎月正当な帳票が出力できなくなる。
 * 対象外であることは applyPurchases が W011 としてまとめて提示する。
 */
export function convertOrderLines(
  orders: readonly OrderLine[],
  sources: FactorSources,
  options: ConvertOptions = {},
): ConvertResult {
  const issues = new IssueCollector();
  /** 単位計算マスタから引けず P列へ落ちた商品。1件ずつ警告すると埋もれるためまとめる。 */
  const fallbacks = new Map<string, { lineNo: number; reason: string; factor: number }>();
  const conflicts: IssueDetail[] = [];
  const agreed: IssueDetail[] = [];
  const unresolvable: IssueDetail[] = [];
  /** 発注数が負の行。年数回しか出ないため、出たことを必ず知らせる */
  const returns: IssueDetail[] = [];

  const lines = orders.map((order): OrderLine => {
    const ref = { fileName: options.fileName, rowNo: order.lineNo, productCode: order.code };
    const isReturn = order.orderQty < 0;
    if (isReturn) {
      returns.push({ ref, text: `${order.code}（発注数 ${order.orderQty}）` });
    }
    const unresolved = {
      ...order,
      conversionFactor: null,
      convertedQty: null,
      factorSource: null,
      isReturn,
    };

    /** 当月の棚卸対象商品か（P列のキー集合＝当月マスタの商品集合） */
    const inScope = sources.masterP.has(order.code);
    const pFactor = sources.masterP.get(order.code);
    const unitEntry = sources.unitMaster.get(order.code);
    const confirmed = sources.confirmed?.get(order.code);

    // --- 0. 画面で確認・登録された係数（最優先） ---
    if (isUsableFactor(confirmed)) {
      return {
        ...order,
        conversionFactor: confirmed,
        convertedQty: order.orderQty * confirmed,
        factorSource: 'CONFIRMED',
        isReturn,
      };
    }

    // --- 1. 単位計算マスタ（正） ---
    if (unitEntry && isUsableFactor(unitEntry.factor)) {
      const factor = unitEntry.factor;
      if (inScope) {
        if (isUsableFactor(pFactor) && pFactor !== factor) {
          conflicts.push({ ref, text: `${order.code}（単位計算マスタ ${factor} / 当月マスタ ${pFactor}）` });
        } else if (isUsableFactor(pFactor)) {
          agreed.push({ ref, text: `${order.code}` });
        }
      }
      return {
        ...order,
        conversionFactor: factor,
        convertedQty: order.orderQty * factor,
        factorSource: 'UNIT_MASTER',
        isReturn,
      };
    }

    // 棚卸対象外で単位計算マスタにも無い → 集計に入らないので問題としない
    if (!inScope) return unresolved;

    // --- 2. 当月マスタP列へフォールバック ---
    if (isUsableFactor(pFactor)) {
      if (!fallbacks.has(order.code)) {
        fallbacks.set(order.code, {
          lineNo: order.lineNo,
          reason: unitEntry ? `計算単位が不正（値: ${unitEntry.factor}）` : '未登録',
          factor: pFactor,
        });
      }
      return {
        ...order,
        conversionFactor: pFactor,
        convertedQty: order.orderQty * pFactor,
        factorSource: 'MASTER_P',
        isReturn,
      };
    }

    // --- 3. どちらからも取れない ---
    // 0 や負の値は係数として使えないので「未登録」と同じ扱いで表示する。
    // 生の 0 を出すと「0 のどこが悪いのか」が伝わらず、直し方も分からない。
    const shown = (value: number | undefined): string =>
      isUsableFactor(value) ? String(value) : '未登録';
    unresolvable.push({
      ref,
      text: `${order.code}（単位計算マスタ：${shown(unitEntry?.factor)}／当月マスタ：${shown(pFactor)}）`,
    });
    return unresolved;
  });

  // 返品は本システムの管理対象外（要件§10-1・2026-09-27 確定）。
  // ただし式どおり計算すれば負の発注数はそのまま期中仕入から引かれるため、
  // 黙って引くのではなく「引いた」ことを知らせる。年数回しか起きず、
  // 気づかないまま数字が動くと原因の特定が難しくなるため。
  issues.addMany('W023', returns, (n, d) =>
    `発注累計照会に返品行（発注数がマイナス）が ${n} 件あります（${summarize(d)}）。発注数 × 計算単位 の式どおり、期中仕入から差し引いて計算します。本システムは返品を個別には管理しないため、数量が想定どおりか確認してください。`,
    { fileName: options.fileName });

  issues.addMany('E005', unresolvable, (n, d) =>
    `当月の棚卸対象商品 ${n} 件の換算係数を取得できません（${summarize(d)}）。仕入数量を確定できないため、期中仕入に反映できません。`,
    { fileName: options.fileName });

  issues.addMany('W009', conflicts, (n, d) =>
    `単位計算マスタと当月マスタで換算係数が一致しない商品が ${n} 件あります（${summarize(d)}）。単位計算マスタの値を優先して採用します。どちらが正しいか店舗オーナーへ確認してください。`,
    { fileName: options.fileName });

  issues.addMany('I003', agreed, (n) =>
    `${n} 商品で単位計算マスタと当月マスタの換算係数が一致しました。`,
    { fileName: options.fileName });

  const fallbackDetails: IssueDetail[] = [...fallbacks.entries()].map(([c, f]) => ({
    ref: { fileName: options.fileName, rowNo: f.lineNo, productCode: c },
    text: `${c}（${f.reason}→当月マスタ ${f.factor}）`,
  }));
  issues.addMany('W016', fallbackDetails, (n, d) =>
    `棚卸対象の ${n} 商品が単位計算マスタから引けなかったため、当月マスタの非表示列（P列）の値で換算しました（${summarize(d)}）。単位計算マスタへの登録を本部へ依頼してください。P列は帳票上で非表示のため、店舗側では値を確認できません。`,
    { fileName: options.fileName });

  return { lines, issues: [...issues.all] };
}

export interface ApplyPurchasesResult {
  rows: ProductRow[];
  issues: ValidationIssue[];
}

/** 換算済みの発注明細を商品明細の期中仕入（H列）へ集約する。 */
export function applyPurchases(
  rows: readonly ProductRow[],
  lines: readonly OrderLine[],
): ApplyPurchasesResult {
  const issues = new IssueCollector();
  const known = new Set(rows.map((r) => r.code as string));

  const totals = new Map<string, number>();
  const unresolved = new Set<string>();
  const unknown = new Map<string, number>(); // コード → 最初に現れた行番号
  const supplies = new Map<string, number>();

  for (const line of lines) {
    // 備品（5桁コード）はこの棚卸表の計算対象外なので、発注があっても期中仕入に入れない
    // （要件§10-2・2026-09-27 確定）。2026年8月の発注累計149行のうち35行が備品だった。
    // マスタに無いことが問題なのではなく、そもそも対象外なので警告ではなく情報として記録する。
    if (isSupplyCode(line.code)) {
      if (!supplies.has(line.code)) supplies.set(line.code, line.lineNo);
      continue;
    }
    if (!known.has(line.code)) {
      // 実データでは消耗品・容器類などが該当する。1件ずつ警告すると埋もれるためまとめる。
      if (!unknown.has(line.code)) unknown.set(line.code, line.lineNo);
      continue;
    }
    if (line.convertedQty === null) {
      // convertOrderLines で E005 を出している行。合計を信用できないことをここでも明示する。
      unresolved.add(line.code);
      continue;
    }
    totals.set(line.code, (totals.get(line.code) ?? 0) + line.convertedQty);
  }

  const unknownDetails: IssueDetail[] = [...unknown].map(([codeValue, rowNo]) => ({
    ref: { rowNo, productCode: codeValue },
    text: codeValue,
  }));
  issues.addMany('W011', unknownDetails, (n, d) =>
    `発注累計にあるが当月本部マスタに存在しない商品が ${n} 件あります（${summarize(d, 15)}）。当月の計算対象外として扱います。棚卸対象に加えるべき商品が含まれていないか確認してください。`);

  const supplyDetails: IssueDetail[] = [...supplies].map(([codeValue, rowNo]) => ({
    ref: { rowNo, productCode: codeValue },
    text: codeValue,
  }));
  issues.addMany('I004', supplyDetails, (n, d) =>
    `発注累計にある備品 ${n} 件を計算対象外にしました（${summarize(d, 15)}）。商品コードの数値部が5桁のものは食材ではないため、期中仕入に反映しません。`);

  // 換算できなかった商品はここでも検出できるが、メッセージは出さない。
  // 原因は convertOrderLines が E005 として1件にまとめて報告済みで、
  // 同じ原因で2つのエラーを並べると対処の起点が分からなくなるため
  // （「1エラーに対して1エラーメッセージ」）。
  // 期中仕入は書き換えずマスタの値のままとし、E005 が残る限り出力はブロックされる。
  const result = rows.map((row): ProductRow => {
    if (row.isSupply) return row;
    if (unresolved.has(row.code)) return row;
    const total = totals.get(row.code);
    return total === undefined ? row : { ...row, purchaseQty: total };
  });

  return { rows: result, issues: [...issues.all] };
}
