/**
 * カテゴリ（分類）定義。
 *
 * 実帳票の分析用シートを正とする。特筆すべき2点:
 *  1. 表示順が分類コード順ではない（01〜14 → 17 → 15 → 16）。
 *  2. 合計 C22 = SUM(C5:C19) のため、20行目のガチャ玉と21行目の靴他が合計から除外される。
 *     物販であり食材原価に含めないためと解釈する。
 */

export interface CategoryDef {
  /** 入力用シート N列（分類）の値。例 "01.ソース" */
  code: string;
  /** 分析用シート A列の表示名。例 "ソース"（"12.朝食メニュー" は "朝食"） */
  displayName: string;
  /** 分析用シートの行番号（5〜21） */
  analysisRow: number;
  /** 使用高合計・食材期末在庫計に算入するか */
  includedInTotal: boolean;
}

/**
 * 分類コード順で定義する（入力用シート S列 3〜19行の並び）。
 * analysisRow が分析用シートでの実際の位置を持つ。
 */
export const CATEGORIES: readonly CategoryDef[] = [
  { code: '01.ソース', displayName: 'ソース', analysisRow: 5, includedInTotal: true },
  { code: '02.主食材Ａ', displayName: '主食材Ａ', analysisRow: 6, includedInTotal: true },
  { code: '03.主食材Ｂ', displayName: '主食材Ｂ', analysisRow: 7, includedInTotal: true },
  { code: '04.米', displayName: '米', analysisRow: 8, includedInTotal: true },
  { code: '05.油', displayName: '油', analysisRow: 9, includedInTotal: true },
  { code: '06.ＴＯ(レジ前)', displayName: 'ＴＯ(レジ前)', analysisRow: 10, includedInTotal: true },
  { code: '07.福神漬', displayName: '福神漬', analysisRow: 11, includedInTotal: true },
  { code: '08.ビール', displayName: 'ビール', analysisRow: 12, includedInTotal: true },
  { code: '09.野菜', displayName: '野菜', analysisRow: 13, includedInTotal: true },
  { code: '10.副食材', displayName: '副食材', analysisRow: 14, includedInTotal: true },
  { code: '11.ドリンク', displayName: 'ドリンク', analysisRow: 15, includedInTotal: true },
  { code: '12.朝食メニュー', displayName: '朝食', analysisRow: 16, includedInTotal: true },
  { code: '13.ドレッシング', displayName: 'ドレッシング', analysisRow: 17, includedInTotal: true },
  { code: '14.限定', displayName: '期間限定', analysisRow: 18, includedInTotal: true },
  // 分析用では 15/16 より前に置かれている（C22=SUM(C5:C19) の範囲内）
  { code: '15.ガチャ玉', displayName: 'ガチャ玉', analysisRow: 20, includedInTotal: false },
  { code: '16.靴他', displayName: '靴他', analysisRow: 21, includedInTotal: false },
  { code: '17.カレーらーめん', displayName: 'カレーらーめん', analysisRow: 19, includedInTotal: true },
] as const;

/** 入力用シート S列（3〜19行）に置かれる分類コードの並び。U/V列の SUMIF 条件に対応する。 */
export const INPUT_SHEET_CATEGORY_ORDER: readonly string[] = CATEGORIES.map((c) => c.code);

/** 分析用シート L14 = C13。野菜カテゴリの当月使用高をそのまま表示する。 */
export const SALAD_VEGETABLE_CATEGORY = '09.野菜';

const BY_CODE = new Map(CATEGORIES.map((c) => [c.code, c]));

/** 未知の分類は undefined を返す。推測で近いカテゴリへ寄せることはしない。 */
export function categoryByCode(code: string): CategoryDef | undefined {
  return BY_CODE.get(code);
}

export function totalTargetCategories(): CategoryDef[] {
  return CATEGORIES.filter((c) => c.includedInTotal);
}

export function excludedCategories(): CategoryDef[] {
  return CATEGORIES.filter((c) => !c.includedInTotal);
}

/** 分析用シートの表示順（analysisRow 昇順）。 */
export function displayOrder(): CategoryDef[] {
  return [...CATEGORIES].sort((a, b) => a.analysisRow - b.analysisRow);
}
