/**
 * 既存の「リアル売上算出（マスタ）.xlsx」から料率と容器単価を取り込む。
 *
 * 料率は店舗の契約情報なのでコードに持たない（公開リポジトリのため）。
 * 店舗がこれまで使っていた Excel をそのまま読めば、手で打ち直さずに済む。
 *
 * 既存Excelの形（Sheet1）:
 *   A列 チャンネル / B列 売上 / C列 手数料率 / D列 手数料額   … 2行目から「計」の行の手前まで
 *   A列「TO」の行の C列 = 容器の控除額単価
 */
import { XlsxWorkbook } from '../../xlsx/workbook';
import { parseDecimal, toDecimalString } from './fixed';
import { channelRow, EPOCH_YM, KNOWN_CHANNELS, normalizeLabel, type DeliveryChannel } from './masters';

export interface ImportedMasters {
  channels: DeliveryChannel[];
  containerPrice: string | null;
  /** Excel にあったが既知のチャネルに対応づけられなかった表記 */
  unknownLabels: string[];
}

const cellText = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim();

export async function importMastersFromWorkbook(bytes: Uint8Array, validFrom: string = EPOCH_YM): Promise<ImportedMasters> {
  const wb = await XlsxWorkbook.load(bytes);
  const sheet = wb.sheetNames[0]!;
  const channels: DeliveryChannel[] = [];
  const unknownLabels: string[] = [];
  let containerPrice: string | null = null;

  for (let r = 2; r <= 60; r++) {
    const label = cellText(wb.cell(sheet, `A${r}`)?.value);
    const rateCell = wb.cell(sheet, `C${r}`)?.value;
    if (!label) continue;
    if (label === 'TO') {
      const p = parseDecimal(cellText(rateCell));
      if (p !== null) containerPrice = toDecimalString(p);
      continue;
    }
    if (label === 'チャンネル') continue; // 2つ目の表の見出し
    const rate = parseDecimal(cellText(rateCell));
    if (rate === null) continue;
    const key = normalizeLabel(label);
    const known = KNOWN_CHANNELS.find((c) => [c.name, ...c.aliases].some((a) => normalizeLabel(a) === key));
    if (!known) {
      unknownLabels.push(label);
      continue;
    }
    channels.push(channelRow(known.id, toDecimalString(rate), validFrom));
  }
  return { channels, containerPrice, unknownLabels };
}
