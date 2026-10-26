/**
 * 確定した当月売上高（画面・パイプライン・データベースで共有する型）。
 * 金額・料率は十進表記の文字列で持ち、倍精度を経由しない。
 */
import type { RealSalesMasters } from './masters';

/** 監査用の明細（要件§11.7）。データベースへの保存に使う */
export interface RealSalesDetail {
  channels: { channelId: string; label: string; sales: string; rate: string; fee: string }[];
  containerPrice: string;
  containerQtySource: 'csv' | 'manual';
  containerQtyReason: string | null;
  /** OCR の読取値と確定値。どの項目をどう直したかを残す */
  readings: { field: string; ocrValue: string | null; finalValue: string | null; source: string; edited: boolean }[];
  /** 入力ファイルの指紋。写真そのものは保存しない */
  files: { kind: 'photo' | 'csv'; fileName: string; sha256: string }[];
  /** 確定時に適用したマスタ */
  masters: RealSalesMasters;
}

export interface ConfirmedRealSales {
  realSales: string;
  grossTotal: string;
  feeTotal: string;
  containerQty: number;
  containerCost: string;
  confirmedAt: string;
  detail?: RealSalesDetail;
}
