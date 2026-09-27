/**
 * CSV の読み取り。
 *
 * 実ファイル（発注累計照会）は CP932（Shift_JIS）で出力されていた。
 * 文字コードは BOM と UTF-8 としての妥当性で判定し、推測で壊さないようにする。
 */

export type CsvEncoding = 'utf-8' | 'utf-8-bom' | 'shift_jis';

export interface DecodedCsv {
  encoding: CsvEncoding;
  rows: string[][];
}

export function detectEncoding(bytes: Uint8Array): CsvEncoding {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8-bom';
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'shift_jis';
  }
}

export function decodeBytes(bytes: Uint8Array, encoding: CsvEncoding): string {
  if (encoding === 'utf-8-bom') {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (encoding === 'shift_jis') {
    return new TextDecoder('shift_jis').decode(bytes);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** RFC4180 準拠の最小限の CSV パーサ（引用符・埋め込み改行に対応）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field !== '' || row.length > 0) pushRow();

  // 末尾の空行を落とす
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.length === 1 && last[0] === '') rows.pop();
    else break;
  }

  return rows;
}

export function readCsv(bytes: Uint8Array): DecodedCsv {
  const encoding = detectEncoding(bytes);
  return { encoding, rows: parseCsv(decodeBytes(bytes, encoding)) };
}
