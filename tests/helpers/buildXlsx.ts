/**
 * テスト用の合成 xlsx ビルダ。
 *
 * 実ファイル（店舗の実原価データ）をリポジトリに置かずにテストするため、
 * 実帳票と同じ構造（入力用: 見出し行2・データ行3〜、J/L/M に数式、分析用: C4/K7/C22/L11）を
 * 持つ最小限のブックをその場で組み立てる。
 */
import JSZip from 'jszip';

export interface SyntheticRow {
  code: string;
  name: string;
  unit?: string;
  closingQty?: number | null;
  purchaseQty?: number | null;
  openingQty?: number | null;
  unitPrice?: number;
  category: string;
  conversionFactor?: number;
}

export interface BuildOptions {
  rows: SyntheticRow[];
  /** 分析用 C4 当月売上高 */
  totalSales?: number | null;
  /** 分析用 K7 ロス額 */
  lossAmount?: number | null;
  monthLabel?: string;
  /** 商品コードを数値型で書き込む（現行ツールのバグ再現用） */
  codesAsNumbers?: boolean;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="注意事項" sheetId="1" r:id="rId1"/><sheet name="入力用" sheetId="2" r:id="rId2"/><sheet name="分析用" sheetId="3" r:id="rId3"/></sheets><calcPr calcId="191029"/></workbook>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="游ゴシック"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class StringTable {
  private readonly map = new Map<string, number>();
  private readonly list: string[] = [];

  index(value: string): number {
    const found = this.map.get(value);
    if (found !== undefined) return found;
    const i = this.list.length;
    this.map.set(value, i);
    this.list.push(value);
    return i;
  }

  xml(): string {
    const items = this.list.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.list.length}" uniqueCount="${this.list.length}">${items}</sst>`;
  }
}

function numCell(ref: string, value: number | null | undefined, style = 0): string {
  if (value === null || value === undefined) return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
}

function strCell(ref: string, value: string, st: StringTable, style = 0): string {
  return `<c r="${ref}" s="${style}" t="s"><v>${st.index(value)}</v></c>`;
}

function formulaCell(ref: string, formula: string, cached: number | null, style = 0): string {
  const v = cached === null ? '' : `<v>${cached}</v>`;
  return `<c r="${ref}" s="${style}"><f>${esc(formula)}</f>${v}</c>`;
}

/** 実帳票と同じ構造の合成ブックを作る。 */
export async function buildSyntheticWorkbook(options: BuildOptions): Promise<Uint8Array> {
  const { rows, totalSales = 1000000, lossAmount = null, monthLabel = '8月' } = options;
  const st = new StringTable();

  // --- 入力用シート ---
  const headerCells = [
    'No', '業態', '店舗コード', '商品コード', '商品名', '棚卸単位', '期末在庫', '期中仕入',
    '期首在庫', '期中使用量', '単価', '当月使用高', '期末在庫高', '分類', '削除日',
    '仕入れ単位', '期首・期末単位', '再カウント',
  ];
  const headerLetters = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R'];

  const sheetRows: string[] = [];
  sheetRows.push(`<row r="1"><c r="I1" t="s"><v>${st.index(monthLabel)}</v></c></row>`);
  sheetRows.push(
    `<row r="2">${headerLetters.map((l, i) => strCell(`${l}2`, headerCells[i]!, st)).join('')}</row>`,
  );

  // カテゴリ集計列（S/U/V）は3行目以降に置かれる
  const categoryOrder = [
    '01.ソース','02.主食材Ａ','03.主食材Ｂ','04.米','05.油','06.ＴＯ(レジ前)','07.福神漬',
    '08.ビール','09.野菜','10.副食材','11.ドリンク','12.朝食メニュー','13.ドレッシング',
    '14.限定','15.ガチャ玉','16.靴他','17.カレーらーめん',
  ];

  const maxRow = Math.max(rows.length + 2, categoryOrder.length + 2);
  for (let i = 0; i < maxRow - 2; i += 1) {
    const r = i + 3;
    const data = rows[i];
    const parts: string[] = [];

    if (data) {
      const usageQty =
        (data.purchaseQty ?? 0) + (data.openingQty ?? 0) - (data.closingQty ?? 0);
      const price = data.unitPrice ?? 0;
      parts.push(numCell(`A${r}`, i + 1));
      parts.push(numCell(`B${r}`, 1));
      // 商品コードは既定で文字列（style 1 = 文字列書式）。バグ再現時のみ数値。
      parts.push(
        options.codesAsNumbers
          ? numCell(`D${r}`, Number(data.code))
          : strCell(`D${r}`, data.code, st, 1),
      );
      parts.push(strCell(`E${r}`, data.name, st));
      parts.push(strCell(`F${r}`, data.unit ?? '袋', st));
      parts.push(numCell(`G${r}`, data.closingQty));
      parts.push(numCell(`H${r}`, data.purchaseQty));
      parts.push(numCell(`I${r}`, data.openingQty));
      parts.push(formulaCell(`J${r}`, `SUM(H${r}:I${r})-G${r}`, usageQty));
      parts.push(numCell(`K${r}`, price));
      parts.push(formulaCell(`L${r}`, `K${r}*J${r}`, price * usageQty));
      parts.push(formulaCell(`M${r}`, `G${r}*K${r}`, (data.closingQty ?? 0) * price));
      parts.push(strCell(`N${r}`, data.category, st));
      parts.push(numCell(`P${r}`, data.conversionFactor ?? 1));
      parts.push(numCell(`Q${r}`, 1));
    }

    const cat = categoryOrder[i];
    if (cat) {
      const usage = rows
        .filter((x) => x.category === cat)
        .reduce(
          (s, x) =>
            s +
            (x.unitPrice ?? 0) *
              ((x.purchaseQty ?? 0) + (x.openingQty ?? 0) - (x.closingQty ?? 0)),
          0,
        );
      const closing = rows
        .filter((x) => x.category === cat)
        .reduce((s, x) => s + (x.closingQty ?? 0) * (x.unitPrice ?? 0), 0);
      parts.push(strCell(`S${r}`, cat, st));
      parts.push(formulaCell(`U${r}`, `SUMIF(N:N,S${r},L:L)`, usage));
      parts.push(formulaCell(`V${r}`, `SUMIF(N:N,S${r},M:M)`, closing));
    }

    if (parts.length) sheetRows.push(`<row r="${r}">${parts.join('')}</row>`);
  }

  const inputSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:V${maxRow}"/><sheetData>${sheetRows.join('')}</sheetData><pageSetup orientation="portrait"/></worksheet>`;

  // --- 分析用シート ---
  const analysisRows: string[] = [];
  analysisRows.push(`<row r="3"><c r="C3" t="s"><v>${st.index('金額')}</v></c></row>`);
  analysisRows.push(
    `<row r="4">${strCell('A4', '当月売上高', st)}${numCell('C4', totalSales)}${strCell('E4', '原価率', st)}${strCell('F4', '食材期末在庫計', st)}</row>`,
  );

  const analysisDisplay = [
    ['01.ソース', 'ソース', 5, 3],
    ['02.主食材Ａ', '主食材Ａ', 6, 4],
    ['03.主食材Ｂ', '主食材Ｂ', 7, 5],
    ['04.米', '米', 8, 6],
    ['05.油', '油', 9, 7],
    ['06.ＴＯ(レジ前)', 'ＴＯ(レジ前)', 10, 8],
    ['07.福神漬', '福神漬', 11, 9],
    ['08.ビール', 'ビール', 12, 10],
    ['09.野菜', '野菜', 13, 11],
    ['10.副食材', '副食材', 14, 12],
    ['11.ドリンク', 'ドリンク', 15, 13],
    ['12.朝食メニュー', '朝食', 16, 14],
    ['13.ドレッシング', 'ドレッシング', 17, 15],
    ['14.限定', '期間限定', 18, 16],
    ['17.カレーらーめん', 'カレーらーめん', 19, 19],
    ['15.ガチャ玉', 'ガチャ玉', 20, 17],
    ['16.靴他', '靴他', 21, 18],
  ] as const;

  // キャッシュ値は「Excelで開いて再計算した結果」と一致していなければならない。
  // 行を組み立てながら合計を足していくと、K9（= C22 - K7）のキャッシュに
  // その時点までの部分合計が入り、検算（W010）が実データでは起きない差で落ちる。
  // そのため、まず全カテゴリを集計してから行を書き出す。
  const usageByCat = new Map<string, number>();
  const closingByCat = new Map<string, number>();
  for (const [catCode] of analysisDisplay) {
    usageByCat.set(
      catCode,
      rows
        .filter((x) => x.category === catCode)
        .reduce(
          (s, x) =>
            s +
            (x.unitPrice ?? 0) *
              ((x.purchaseQty ?? 0) + (x.openingQty ?? 0) - (x.closingQty ?? 0)),
          0,
        ),
    );
    closingByCat.set(
      catCode,
      rows
        .filter((x) => x.category === catCode)
        .reduce((s, x) => s + (x.closingQty ?? 0) * (x.unitPrice ?? 0), 0),
    );
  }
  // 合計はガチャ玉・靴他（行20・21）を含まない15分類（設計書§7.4）
  const totalUsage = analysisDisplay
    .filter(([, , analysisRow]) => analysisRow <= 19)
    .reduce((s, [catCode]) => s + usageByCat.get(catCode)!, 0);
  const totalClosing = analysisDisplay
    .filter(([, , analysisRow]) => analysisRow <= 19)
    .reduce((s, [catCode]) => s + closingByCat.get(catCode)!, 0);
  /** サラダ野菜使用高（分析用 L14 = C13）は野菜カテゴリの当月使用高 */
  const vegetableUsage = usageByCat.get('09.野菜')!;

  for (const [catCode, displayName, analysisRow, inputRow] of analysisDisplay) {
    const usage = usageByCat.get(catCode)!;
    const closing = closingByCat.get(catCode)!;
    const rate = totalSales ? usage / totalSales : null;
    const parts = [
      strCell(`A${analysisRow}`, displayName, st),
      formulaCell(`C${analysisRow}`, `入力用!U${inputRow}`, usage),
      formulaCell(`E${analysisRow}`, `C${analysisRow}/$C$4`, rate),
      formulaCell(`F${analysisRow}`, `入力用!V${inputRow}`, closing),
    ];
    if (analysisRow === 7) parts.push(strCell('I7', '・ロス額', st), numCell('K7', lossAmount));
    if (analysisRow === 9) {
      parts.push(
        strCell('I9', '・ロス引き後原価', st),
        formulaCell('K9', 'C22-K7', totalUsage - (lossAmount ?? 0)),
      );
    }
    if (analysisRow === 11) {
      parts.push(
        strCell('I11', '・ロス引き後原価率', st),
        formulaCell(
          'L11',
          'K9/C4*100',
          totalSales ? ((totalUsage - (lossAmount ?? 0)) / totalSales) * 100 : null,
        ),
      );
    }
    if (analysisRow === 14) {
      parts.push(
        strCell('I14', '・サラダ野菜使用高', st),
        formulaCell('L14', 'C13', vegetableUsage),
      );
    }
    analysisRows.push(`<row r="${analysisRow}">${parts.join('')}</row>`);
  }

  analysisRows.push(
    `<row r="22">${strCell('A22', '合計', st)}${formulaCell('C22', 'SUM(C5:D19)', totalUsage)}${formulaCell('E22', 'C22/$C$4', totalSales ? totalUsage / totalSales : null)}${formulaCell('F22', 'SUM(F5:F19)', totalClosing)}</row>`,
  );

  analysisRows.sort((a, b) => {
    const ra = Number(/r="(\d+)"/.exec(a)![1]);
    const rb = Number(/r="(\d+)"/.exec(b)![1]);
    return ra - rb;
  });

  const analysisSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:P71"/><sheetData>${analysisRows.join('')}</sheetData></worksheet>`;

  const noticeSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="B1:L279"/><sheetData><row r="2">${strCell('D2', '枠内は、必須入力です。', st)}</row></sheetData></worksheet>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('xl/workbook.xml', WORKBOOK);
  zip.file('xl/_rels/workbook.xml.rels', WORKBOOK_RELS);
  zip.file('xl/styles.xml', STYLES);
  zip.file('xl/worksheets/sheet1.xml', noticeSheet);
  zip.file('xl/worksheets/sheet2.xml', inputSheet);
  zip.file('xl/worksheets/sheet3.xml', analysisSheet);
  zip.file('xl/sharedStrings.xml', st.xml());

  return zip.generateAsync({ type: 'uint8array' });
}

/** 実帳票の先頭数行を模した既定の行データ。 */
export const SAMPLE_ROWS: SyntheticRow[] = [
  { code: '000140', name: '２Ｎ甘口ポークソース１．６５ｋｇ', closingQty: 0, purchaseQty: 0, openingQty: 0, unitPrice: 1791, category: '01.ソース' },
  { code: '000158', name: '甘口ポークソース２．２ｋｇＲ８', closingQty: 7, purchaseQty: 76, openingQty: 5, unitPrice: 1194, category: '01.ソース' },
  { code: '000155', name: '２．２Ｎポークソース４ｋｇＲ６', closingQty: 6, purchaseQty: 116, openingQty: 5, unitPrice: 4972, category: '01.ソース' },
  { code: '006747', name: '特原を使用しないカレー１２袋', closingQty: 6, purchaseQty: 0, openingQty: 12, unitPrice: 104, category: '01.ソース', conversionFactor: 12 },
  { code: '001868', name: 'クリームコロッケ（Ｈ６）', closingQty: 10, purchaseQty: 240, openingQty: 44, unitPrice: 50, category: '03.主食材Ｂ', conversionFactor: 40 },
  { code: 'A00043', name: 'キャベツ(自店購入）', closingQty: 2, purchaseQty: 24, openingQty: 0, unitPrice: 273, category: '09.野菜' },
  { code: 'A00001', name: '本部商品カプセルトイ１００', closingQty: 0, purchaseQty: 0, openingQty: 0, unitPrice: 100, category: '15.ガチャ玉' },
  { code: 'A10005', name: 'レターパック520', closingQty: 0, purchaseQty: 100, openingQty: 0, unitPrice: 520, category: '16.靴他' },
];
