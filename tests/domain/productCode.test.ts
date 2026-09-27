import { describe, it, expect } from 'vitest';
import {
  parseProductCode,
  isOwnPurchaseCode,
  unsafeProductCode,
  PRODUCT_CODE_WIDTH,
} from '@/domain/productCode';

describe('parseProductCode', () => {
  describe('先頭ゼロの保持（受入条件1）', () => {
    it('先頭ゼロを削除しない', () => {
      const r = parseProductCode('000140');
      expect(r.code).toBe('000140');
      expect(r.issues).toHaveLength(0);
    });

    it('先頭ゼロが複数あっても保持する', () => {
      expect(parseProductCode('000001').code).toBe('000001');
    });

    it('先頭ゼロのないコードはそのまま', () => {
      expect(parseProductCode('123456').code).toBe('123456');
    });
  });

  describe('数値型で渡された場合の救済（現行ツールのバグ対策）', () => {
    // 現行PowerShellツールは商品コードを数値型で扱い 000140 -> 140 となり
    // 行位置突合に退行して期首在庫が1行ずれた。ここで必ず可視化する。
    it('整数を6桁ゼロ埋めして復元する', () => {
      const r = parseProductCode(140);
      expect(r.code).toBe('000140');
    });

    it('整数で渡されたら I001 を必ず記録する', () => {
      const r = parseProductCode(140);
      expect(r.issues.map((i) => i.code)).toContain('I001');
    });

    it('小数点付き浮動小数でも整数部のみを使う', () => {
      const r = parseProductCode(6747.0);
      expect(r.code).toBe('006747');
      expect(r.issues.map((i) => i.code)).toContain('I001');
    });

    it('6桁を超える数値はゼロ埋めせずそのまま文字列化する', () => {
      const r = parseProductCode(1234567);
      expect(r.code).toBe('1234567');
    });

    it('文字列で渡された場合は I001 を出さない', () => {
      expect(parseProductCode('000140').issues).toHaveLength(0);
    });
  });

  describe('正規化', () => {
    it('前後の半角空白を除去する', () => {
      expect(parseProductCode('  000140  ').code).toBe('000140');
    });

    it('前後の全角空白を除去する', () => {
      expect(parseProductCode('　000140　').code).toBe('000140');
    });

    it('タブ・改行を除去する', () => {
      expect(parseProductCode('\t000140\n').code).toBe('000140');
    });

    it('全角数字を半角に変換する', () => {
      expect(parseProductCode('０００１４０').code).toBe('000140');
    });

    it('全角英字を半角に変換する', () => {
      expect(parseProductCode('Ａ０００４３').code).toBe('A00043');
    });

    it('正規化で値が変化したら I001 を記録する', () => {
      const r = parseProductCode('  000140 ');
      expect(r.issues.map((i) => i.code)).toContain('I001');
    });

    it('正規化不要なら issue を出さない', () => {
      expect(parseProductCode('A00043').issues).toHaveLength(0);
    });
  });

  describe('空欄の扱い（E003）', () => {
    it.each([null, undefined, '', '   ', '　'])('%p は E003 を返しコードは null', (raw) => {
      const r = parseProductCode(raw);
      expect(r.code).toBeNull();
      expect(r.issues.map((i) => i.code)).toContain('E003');
    });

  });

  // 空欄（E003）と NaN（E013）は原因も対処も違うため、コードを分けている。
  // 空欄は行の削除、NaN は元ファイルのセルの確認が必要になる。
  describe('数値として読めない値の扱い（E013）', () => {
    it('NaN は E013', () => {
      const r = parseProductCode(Number.NaN);
      expect(r.code).toBeNull();
      expect(r.issues.map((i) => i.code)).toEqual(['E013']);
    });

    it('文字列 "nan" も E013 として扱う', () => {
      const r = parseProductCode('nan');
      expect(r.code).toBeNull();
      expect(r.issues.map((i) => i.code)).toEqual(['E013']);
    });

    it('文字列でも数値でもない型は E013', () => {
      const r = parseProductCode({ code: '000140' });
      expect(r.code).toBeNull();
      expect(r.issues.map((i) => i.code)).toEqual(['E013']);
    });
  });

  describe('位置情報の伝播（要件§7）', () => {
    it('issue に元ファイル名・シート名・行番号を持たせる', () => {
      const r = parseProductCode('', {
        fileName: '当月マスタ.xlsx',
        sheetName: '入力用',
        rowNo: 42,
      });
      const issue = r.issues.find((i) => i.code === 'E003');
      expect(issue?.ref.fileName).toBe('当月マスタ.xlsx');
      expect(issue?.ref.sheetName).toBe('入力用');
      expect(issue?.ref.rowNo).toBe(42);
    });
  });
});

describe('isOwnPurchaseCode', () => {
  it('A始まりは自店購入と判定する', () => {
    expect(isOwnPurchaseCode(unsafeProductCode('A00043'))).toBe(true);
  });

  it('0始まりは本部商品と判定する', () => {
    expect(isOwnPurchaseCode(unsafeProductCode('000140'))).toBe(false);
  });

  it('小文字 a でも自店購入と判定する', () => {
    expect(isOwnPurchaseCode(unsafeProductCode('a00043'))).toBe(true);
  });
});

describe('PRODUCT_CODE_WIDTH', () => {
  it('実帳票の実測値どおり6桁', () => {
    expect(PRODUCT_CODE_WIDTH).toBe(6);
  });
});
