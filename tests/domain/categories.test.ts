import { describe, it, expect } from 'vitest';
import {
  CATEGORIES,
  categoryByCode,
  totalTargetCategories,
  excludedCategories,
  displayOrder,
  SALAD_VEGETABLE_CATEGORY,
} from '@/domain/categories';

describe('カテゴリ定義（実帳票の分析用シート準拠）', () => {
  it('17カテゴリを定義している', () => {
    expect(CATEGORIES).toHaveLength(17);
  });

  it('分類コードは実帳票の表記どおり', () => {
    expect(CATEGORIES.map((c) => c.code)).toEqual([
      '01.ソース',
      '02.主食材Ａ',
      '03.主食材Ｂ',
      '04.米',
      '05.油',
      '06.ＴＯ(レジ前)',
      '07.福神漬',
      '08.ビール',
      '09.野菜',
      '10.副食材',
      '11.ドリンク',
      '12.朝食メニュー',
      '13.ドレッシング',
      '14.限定',
      '15.ガチャ玉',
      '16.靴他',
      '17.カレーらーめん',
    ]);
  });

  it('分析用シートの表示名は分類コードと異なるものがある', () => {
    expect(categoryByCode('12.朝食メニュー')?.displayName).toBe('朝食');
    expect(categoryByCode('14.限定')?.displayName).toBe('期間限定');
    expect(categoryByCode('01.ソース')?.displayName).toBe('ソース');
  });
});

describe('合計対象の判定（分析用!C22 = SUM(C5:C19)）', () => {
  it('合計対象は15カテゴリ', () => {
    expect(totalTargetCategories()).toHaveLength(15);
  });

  it('ガチャ玉と靴他だけが合計から除外される', () => {
    expect(excludedCategories().map((c) => c.code)).toEqual(['15.ガチャ玉', '16.靴他']);
  });

  it('ガチャ玉は合計対象外', () => {
    expect(categoryByCode('15.ガチャ玉')?.includedInTotal).toBe(false);
  });

  it('靴他は合計対象外', () => {
    expect(categoryByCode('16.靴他')?.includedInTotal).toBe(false);
  });

  it('カレーらーめんは合計対象（19行目までに入るため）', () => {
    expect(categoryByCode('17.カレーらーめん')?.includedInTotal).toBe(true);
  });
});

describe('分析用シートの表示順（分類コード順ではない）', () => {
  it('01〜14 → 17 → 15 → 16 の順で並ぶ', () => {
    expect(displayOrder().map((c) => c.code)).toEqual([
      '01.ソース',
      '02.主食材Ａ',
      '03.主食材Ｂ',
      '04.米',
      '05.油',
      '06.ＴＯ(レジ前)',
      '07.福神漬',
      '08.ビール',
      '09.野菜',
      '10.副食材',
      '11.ドリンク',
      '12.朝食メニュー',
      '13.ドレッシング',
      '14.限定',
      '17.カレーらーめん',
      '15.ガチャ玉',
      '16.靴他',
    ]);
  });

  it('表示順はそのまま分析用シートの行番号5〜21に対応する', () => {
    const order = displayOrder();
    expect(order[0]!.analysisRow).toBe(5);
    expect(order[14]!.analysisRow).toBe(19); // カレーらーめん
    expect(order[15]!.analysisRow).toBe(20); // ガチャ玉
    expect(order[16]!.analysisRow).toBe(21); // 靴他
  });

  it('合計対象の分析用行は5〜19に収まる（C22=SUM(C5:C19)と整合）', () => {
    for (const c of totalTargetCategories()) {
      expect(c.analysisRow).toBeGreaterThanOrEqual(5);
      expect(c.analysisRow).toBeLessThanOrEqual(19);
    }
  });
});

describe('サラダ野菜使用高の参照元（分析用!L14 = C13）', () => {
  it('野菜カテゴリを指す', () => {
    expect(SALAD_VEGETABLE_CATEGORY).toBe('09.野菜');
  });

  it('野菜カテゴリの分析用行は13（L14=C13と整合）', () => {
    expect(categoryByCode('09.野菜')?.analysisRow).toBe(13);
  });
});

describe('categoryByCode', () => {
  it('未知の分類は undefined を返す（勝手に補完しない）', () => {
    expect(categoryByCode('99.存在しない')).toBeUndefined();
  });
});
