import type {
  ProductRow,
  PreviousMonthEntry,
  OrderLine,
  UnitConversionEntry,
} from '@/domain/models';
import { unsafeProductCode } from '@/domain/productCode';

let seq = 0;

export function makeRow(partial: Partial<ProductRow> = {}): ProductRow {
  seq += 1;
  return {
    lineNo: 2 + seq,
    code: unsafeProductCode('000140'),
    name: 'テスト商品',
    inventoryUnit: '袋',
    category: '01.ソース',
    unitPrice: 100,
    conversionFactor: 1,
    closingQty: 0,
    purchaseQty: 0,
    openingQty: 0,
    status: 'CONTINUED',
    isOwnPurchase: false,
    isSupply: false,
    openingApproved: true,
    usageQty: null,
    usageAmount: null,
    closingAmount: null,
    ...partial,
  };
}

export function makePrev(partial: Partial<PreviousMonthEntry> = {}): PreviousMonthEntry {
  return {
    code: unsafeProductCode('000140'),
    name: 'テスト商品',
    category: '01.ソース',
    unitPrice: 100,
    closingQty: 0,
    purchaseQty: 0,
    openingQty: 0,
    usageQty: null,
    usageAmount: null,
    closingAmount: null,
    lineNo: 3,
    ...partial,
  };
}

export function prevMap(entries: PreviousMonthEntry[]): Map<string, PreviousMonthEntry> {
  return new Map(entries.map((e) => [e.code, e]));
}

export function makeOrder(partial: Partial<OrderLine> = {}): OrderLine {
  return {
    code: unsafeProductCode('000140'),
    orderQty: 0,
    conversionFactor: null,
    convertedQty: null,
    factorSource: null,
    isReturn: false,
    lineNo: 2,
    ...partial,
  };
}

export function makeUnitEntry(partial: Partial<UnitConversionEntry> = {}): UnitConversionEntry {
  return {
    code: unsafeProductCode('000140'),
    name: 'テスト商品',
    orderUnit: 1,
    unitLabel: '袋',
    factor: 1,
    lineNo: 2,
    ...partial,
  };
}

export const code = unsafeProductCode;
