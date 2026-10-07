/**
 * 検証結果（エラー・警告・情報）の定義とコレクタ。
 *
 * 設計方針:
 *  1. 判定できない値を黙って埋めない。疑わしい入力は必ず ValidationIssue として可視化し、
 *     BLOCKING が1件でもあれば Excel 出力を禁止する。
 *  2. **別の事象には別のコードを与える。** 同じコードに複数の意味を持たせると、
 *     一覧を見た人が対処を誤る。
 *  3. **1つの事象につきメッセージは1件。** 同じ事象が複数の商品・行で起きた場合は
 *     1件にまとめ、内訳を `details` に持たせる。数十件のメッセージが並んで
 *     重要な指摘が埋もれるのを防ぐ。
 */

export type IssueLevel = 'BLOCKING' | 'WARNING' | 'INFO';

/** エラーコード表。設計書 §9.2 と1対1で対応する。 */
export const ISSUE_CATALOG = {
  // --- 取込・列・シート ---
  E001: { level: 'BLOCKING', title: '必須列欠落' },
  E014: { level: 'BLOCKING', title: '見出しの列名が重複' },
  E008: { level: 'BLOCKING', title: 'シート未検出' },
  W006: { level: 'WARNING', title: '任意列未検出' },
  W007: { level: 'WARNING', title: '見出し位置変化' },
  W020: { level: 'WARNING', title: '任意シート未検出' },
  I002: { level: 'INFO', title: '未知列' },

  // --- ファイルの取り違え・重複 ---
  E004: { level: 'BLOCKING', title: '対象年月不一致' },
  W008: { level: 'WARNING', title: '同一ファイルの再取込' },
  W015: { level: 'WARNING', title: '集計期間が月初〜月末でない' },
  W017: { level: 'WARNING', title: '集計期間の混在' },
  W022: { level: 'WARNING', title: '同じファイルが複数の欄に指定されている' },

  // --- 商品コード ---
  E002: { level: 'BLOCKING', title: '商品コード重複' },
  E003: { level: 'BLOCKING', title: '商品コード空欄' },
  E013: { level: 'BLOCKING', title: '商品コードの型が不正' },
  I001: { level: 'INFO', title: '商品コードを正規化' },

  // --- 値 ---
  E007: { level: 'BLOCKING', title: '数値変換不可' },
  E015: { level: 'BLOCKING', title: '期末在庫が負の値' },

  // --- 商品差分 ---
  W001: { level: 'WARNING', title: '削除商品に期末残あり' },
  W002: { level: 'WARNING', title: '商品名変更' },
  W003: { level: 'WARNING', title: '分類変更' },
  W004: { level: 'WARNING', title: '新規商品の期首未承認' },
  W018: { level: 'WARNING', title: '当月マスタの期首在庫を引継ぎ値で上書き' },

  // --- 換算・期中仕入 ---
  E005: { level: 'BLOCKING', title: '換算係数を取得できない' },
  E012: { level: 'BLOCKING', title: '単位計算マスタの計算単位が矛盾' },
  W009: { level: 'WARNING', title: '換算係数不一致' },
  W011: { level: 'WARNING', title: '棚卸対象外の商品への発注' },
  W014: { level: 'WARNING', title: '単位計算マスタの重複行' },
  W016: { level: 'WARNING', title: '単位計算マスタ未登録につきP列で換算' },
  W019: { level: 'WARNING', title: '新規商品の換算係数が未登録' },
  W023: { level: 'WARNING', title: '返品行を期中仕入に反映' },

  // --- 自店購入・備品 ---
  W021: { level: 'WARNING', title: '自店購入品が当月マスタにない' },
  W024: { level: 'WARNING', title: '備品に自店購入を入力' },
  W025: { level: 'WARNING', title: '当月マスタの期末在庫が未入力' },
  I004: { level: 'INFO', title: '備品を計算対象外にした' },
  I005: { level: 'INFO', title: '登録外の品目に自店購入を入力' },

  // --- 集計・検算 ---
  W005: { level: 'WARNING', title: '原価率算出不可' },
  W010: { level: 'WARNING', title: '検算不一致' },
  W012: { level: 'WARNING', title: '当月使用高がマイナス' },
  W013: { level: 'WARNING', title: '未知の分類' },
  I003: { level: 'INFO', title: '換算係数の照合結果' },

  // --- 出力 ---
  E010: { level: 'BLOCKING', title: '数式セルへの書込み' },
  E011: { level: 'BLOCKING', title: '当月売上高未設定' },
} as const satisfies Record<string, { level: IssueLevel; title: string }>;

export type IssueCode = keyof typeof ISSUE_CATALOG;

/** エラーの位置。要件§7「元ファイル名・シート名・行・商品コードで表示する」に対応。 */
export interface SourceRef {
  fileName?: string;
  sheetName?: string;
  /** Excel 上の実行番号（見出し行を含む1始まり）。配列インデックスは入れない。 */
  rowNo?: number;
  productCode?: string;
  cell?: string;
}

/** まとめた事象の内訳1件。画面では折りたたんで表示する。 */
export interface IssueDetail {
  ref: SourceRef;
  text: string;
}

export interface ValidationIssue {
  code: IssueCode;
  level: IssueLevel;
  title: string;
  /** 1事象につき1つ。複数件をまとめた場合は件数を含む要約にする */
  message: string;
  /** 代表位置。まとめた場合は先頭の位置 */
  ref: SourceRef;
  /** まとめた場合の内訳。単発なら空 */
  details: IssueDetail[];
  /** 対象件数。まとめていなければ 1 */
  count: number;
}

export function createIssue(code: IssueCode, message: string, ref: SourceRef = {}): ValidationIssue {
  const meta = ISSUE_CATALOG[code];
  return { code, level: meta.level, title: meta.title, message, ref, details: [], count: 1 };
}

export function levelOf(code: IssueCode): IssueLevel {
  return ISSUE_CATALOG[code].level;
}

/** 内訳の先頭 n 件を並べ、残りは「ほか」で締める。メッセージが長くなりすぎるのを防ぐ。 */
export function summarize(details: readonly IssueDetail[], limit = 8): string {
  const shown = details.slice(0, limit).map((d) => d.text).join(' / ');
  return details.length > limit ? `${shown} ほか` : shown;
}

/** 検証結果を集めるコレクタ。ドメイン層は例外ではなくこれを通じて異常を報告する。 */
export class IssueCollector {
  private readonly items: ValidationIssue[] = [];

  add(code: IssueCode, message: string, ref: SourceRef = {}): ValidationIssue {
    const issue = createIssue(code, message, ref);
    this.items.push(issue);
    return issue;
  }

  /**
   * 同じ事象が複数件あるとき、1件のメッセージにまとめて記録する。
   * 内訳は details に残るので、どの行が該当するかは画面で追える。
   * details が空なら何も記録しない。
   */
  addMany(
    code: IssueCode,
    details: readonly IssueDetail[],
    buildMessage: (count: number, detailList: readonly IssueDetail[]) => string,
    baseRef?: SourceRef,
  ): ValidationIssue | null {
    if (details.length === 0) return null;
    // 1件だけなら、その1件の位置（行・商品コード）を代表位置にする。
    // 複数件をまとめたときは特定の行を指せないので、ファイル・シートまでに留める。
    const ref: SourceRef =
      details.length === 1 ? { ...baseRef, ...details[0]!.ref } : (baseRef ?? details[0]!.ref);
    const issue = createIssue(code, buildMessage(details.length, details), ref);
    issue.details = [...details];
    issue.count = details.length;
    this.items.push(issue);
    return issue;
  }

  addAll(issues: readonly ValidationIssue[]): void {
    this.items.push(...issues);
  }

  get all(): readonly ValidationIssue[] {
    return this.items;
  }

  byLevel(level: IssueLevel): ValidationIssue[] {
    return this.items.filter((i) => i.level === level);
  }

  byCode(code: IssueCode): ValidationIssue[] {
    return this.items.filter((i) => i.code === code);
  }

  get blocking(): ValidationIssue[] {
    return this.byLevel('BLOCKING');
  }

  hasBlocking(): boolean {
    return this.items.some((i) => i.level === 'BLOCKING');
  }

  counts(): Record<IssueLevel, number> {
    return {
      BLOCKING: this.byLevel('BLOCKING').length,
      WARNING: this.byLevel('WARNING').length,
      INFO: this.byLevel('INFO').length,
    };
  }

  clear(): void {
    this.items.length = 0;
  }
}

/**
 * 同じコードのメッセージが複数残っている場合に1件へ畳む。
 *
 * 行単位で発行される検証（商品コードの解析など）は発行側でまとめきれないため、
 * 取込処理の出口でここを通して「1事象1メッセージ」を担保する。
 */
export function foldByCode(
  issues: readonly ValidationIssue[],
  codes: readonly IssueCode[],
  buildMessage: (code: IssueCode, count: number, details: readonly IssueDetail[]) => string,
): ValidationIssue[] {
  const target = new Set<IssueCode>(codes);
  const out: ValidationIssue[] = [];
  // 畳んだ結果を「そのコードが最初に現れた位置」に戻すための索引。
  // 末尾にまとめて寄せると、BLOCKING が警告の下に沈んで見落とされる。
  const slotByCode = new Map<IssueCode, number>();
  const grouped = new Map<IssueCode, ValidationIssue[]>();

  for (const issue of issues) {
    if (!target.has(issue.code)) {
      out.push(issue);
      continue;
    }
    const list = grouped.get(issue.code);
    if (list) {
      list.push(issue);
      continue;
    }
    grouped.set(issue.code, [issue]);
    slotByCode.set(issue.code, out.length);
    out.push(issue); // 仮置き。あとで畳んだものに差し替える
  }

  for (const [code, list] of grouped) {
    // 1件でも件数入りのメッセージにする。行単位のメッセージは対処方法を持たないことが多く、
    // 畳んだ側の文言のほうが「何をすればよいか」まで書けるため。
    const details: IssueDetail[] = list.flatMap((i) =>
      i.details.length > 0 ? i.details : [{ ref: i.ref, text: i.message }],
    );
    const folded = createIssue(code, buildMessage(code, details.length, details), list[0]!.ref);
    folded.details = details;
    folded.count = details.length;
    out[slotByCode.get(code)!] = folded;
  }

  return out;
}
