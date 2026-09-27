/** Excel の列記号（A, B, ..., Z, AA, ...）とセル参照のユーティリティ。 */

export function colLetterToIndex(letter: string): number {
  let index = 0;
  for (const ch of letter.toUpperCase()) {
    const code = ch.charCodeAt(0) - 64; // 'A' -> 1
    if (code < 1 || code > 26) throw new Error(`列記号が不正です: ${letter}`);
    index = index * 26 + code;
  }
  return index;
}

export function colIndexToLetter(index: number): string {
  if (index < 1) throw new Error(`列番号が不正です: ${index}`);
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const REF_PATTERN = /^([A-Z]+)(\d+)$/i;

export function parseRef(ref: string): { col: number; row: number } {
  const m = REF_PATTERN.exec(ref.trim());
  if (!m) throw new Error(`セル参照が不正です: ${ref}`);
  return { col: colLetterToIndex(m[1]!), row: Number(m[2]) };
}

export function makeRef(col: number, row: number): string {
  return `${colIndexToLetter(col)}${row}`;
}
