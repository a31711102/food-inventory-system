/**
 * 商品の種別判定。
 *
 * 2026-09-27 に本部・店舗オーナーへ確認して確定した2つのルールを扱う（要件§10-2）。
 *
 *   1. 食材のコードは4桁、備品は5桁。備品はこの棚卸表で計算しない
 *   2. 自店購入品は4品（缶ビール・ミニトマト・キャベツ・コーラ160ml）＋レモンスライス
 *
 * どちらも商品コードそのものから決まるので、ドメイン層に置いて取込・集計の両方から使う。
 */
import type { ProductCode } from './productCode';

/**
 * コードの数値部。先頭の `A` と先頭ゼロを取り除いた値の桁数を数えるために使う。
 * 例: `006063` → 6063（4桁）、`041303` → 41303（5桁）、`A20309` → 20309（5桁）
 */
function numericPart(code: string): number {
  const body = code.charAt(0).toUpperCase() === 'A' ? code.slice(1) : code;
  return Number(body);
}

/** 数値部の桁数。数値として読めないコードは 0 を返す。 */
export function codeDigits(code: string): number {
  const n = numericPart(code);
  return Number.isFinite(n) ? String(Math.trunc(Math.abs(n))).length : 0;
}

/**
 * 備品（食材以外）かどうか。**数値部が5桁なら備品**。
 *
 * 2026年8月の実データでは26件が該当し、内容はセレクトボックス・ギフト・ぬいぐるみ・
 * ボールペン・FANBOOK・ドリンク提供付属品セットなど、すべて食材ではなかった。
 * 食材には2桁・3桁もある（01.ソース や 14.限定 に15件）ため、
 * 「4桁なら食材」ではなく「**5桁なら備品**」で判定する。
 */
export function isSupplyCode(code: string): boolean {
  return codeDigits(code) === 5;
}

/**
 * 自店購入品の既定リスト（2026-09-27 時点）。
 *
 * 以前は「Aから始まるコード＝自店購入」と判定していたが、実データと合っていなかった。
 * 4品のうち3品は0始まりの本部コードで、逆にAコード21件のうち自店購入はキャベツ1件だけだった
 * （残りは日めくり・炭酸ガスボンベ・カプセルトイ・レターパックなどの備品や本部商品）。
 *
 * 品目が増減したらここを直す。`PipelineInput.ownPurchaseCodes` で上書きもできる。
 */
export const DEFAULT_OWN_PURCHASE_CODES: readonly string[] = [
  '006063', // 缶ビール６缶パック
  '001250', // ミニトマト
  'A00043', // キャベツ(自店購入）
  '005249', // コーラ１６０ＭＬ３０缶入
  // レモンスライスは本部発注だが、納品方法が通常と違い発注累計に計上されない。
  // 今後は使わない見込みだが、当面は自店購入として扱う（2026-09-27 確認）。
  '007193', // レモンハーフスライス５００ｇ１袋
];

export function isOwnPurchase(code: ProductCode, codes: ReadonlySet<string>): boolean {
  return codes.has(code);
}
