/**
 * 商品コード。
 *
 * 要件§4「商品コードは文字列で保持し、先頭のゼロを削除しない」を型で保証する。
 * 現行PowerShellツールは商品コードを数値型で扱って先頭ゼロを失っており、
 * 6桁ゼロ埋めで突合するとAコード21件（自店購入のキャベツを含む）が落ちる（設計書§1.9）。
 * これを再発させないため、数値型で渡された時点で必ず I001 を記録して可視化する。
 */
import { createIssue, type SourceRef, type ValidationIssue } from './issues';

/** 実帳票の商品コードは全件6桁（実測）。数値型で渡された場合のゼロ埋め幅に使う。 */
export const PRODUCT_CODE_WIDTH = 6;

declare const productCodeBrand: unique symbol;

/** 正規化済みの商品コード。生の文字列を直接代入できないよう branded type にしている。 */
export type ProductCode = string & { readonly [productCodeBrand]: true };

export interface ProductCodeParseResult {
  code: ProductCode | null;
  issues: ValidationIssue[];
}

/** 検証済みであることが自明な場面（テスト・DB復元）でのみ使う。 */
export function unsafeProductCode(value: string): ProductCode {
  return value as ProductCode;
}

const BLANK_PATTERN = /^[\s　]*$/;

function stripEdges(value: string): string {
  return value.replace(/^[\s　]+/, '').replace(/[\s　]+$/, '');
}

export function parseProductCode(raw: unknown, ref: SourceRef = {}): ProductCodeParseResult {
  const issues: ValidationIssue[] = [];

  if (raw === null || raw === undefined) {
    issues.push(createIssue('E003', '商品コードが空欄です。', ref));
    return { code: null, issues };
  }

  let text: string;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      issues.push(
        createIssue('E013', `商品コードが数値として読み取れません（${raw}）。元ファイルの該当セルを確認してください。`, ref),
      );
      return { code: null, issues };
    }
    // 数値型 = 先頭ゼロが失われている可能性がある。整数部だけを使い、6桁に復元する。
    const digits = String(Math.trunc(Math.abs(raw)));
    text = digits.length < PRODUCT_CODE_WIDTH ? digits.padStart(PRODUCT_CODE_WIDTH, '0') : digits;
    issues.push(
      createIssue(
        'I001',
        `商品コードが数値型で格納されていました（${raw}）。先頭ゼロが失われている可能性があるため ${text} として扱います。元ファイルのセル書式を文字列に変更することを推奨します。`,
        { ...ref, productCode: text },
      ),
    );
    return { code: text as ProductCode, issues };
  }

  if (typeof raw !== 'string') {
    issues.push(
      createIssue(
        'E013',
        `商品コードのセルが文字列でも数値でもありません（型: ${typeof raw}）。元ファイルの該当セルを確認してください。`,
        ref,
      ),
    );
    return { code: null, issues };
  }

  const original = raw;

  if (BLANK_PATTERN.test(original)) {
    issues.push(createIssue('E003', '商品コードが空欄です。', ref));
    return { code: null, issues };
  }

  // 全角英数字を半角へ。商品コードは英数字のみのため NFKC が安全に使える。
  text = stripEdges(original.normalize('NFKC'));

  if (text === '') {
    issues.push(createIssue('E003', '商品コードが空欄です。', ref));
    return { code: null, issues };
  }

  // 現行ツールは空欄の商品コードを "NaN" という文字列で出力することがある。
  // 空欄（E003）とは原因も対処も違うため、数値として読めない値（E013）として区別する。
  if (text.toLowerCase() === 'nan') {
    issues.push(
      createIssue(
        'E013',
        `商品コードが数値として読み取れません（${original}）。元ファイルの該当セルを確認してください。`,
        ref,
      ),
    );
    return { code: null, issues };
  }

  if (text !== original) {
    issues.push(
      createIssue('I001', `商品コードを正規化しました（"${original}" → "${text}"）。`, {
        ...ref,
        productCode: text,
      }),
    );
  }

  return { code: text as ProductCode, issues };
}

/**
 * 自店購入品かどうか。
 * 本部マスタの注意事項シートに「0から始まる商品コード＝期末在庫のみ入力／
 * Aから始まる商品コード＝期末在庫・期中仕入を入力」と明記されている。
 */
export function isOwnPurchaseCode(code: ProductCode): boolean {
  return code.charAt(0).toUpperCase() === 'A';
}
