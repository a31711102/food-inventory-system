/**
 * 月次処理のパイプライン。
 *
 *   当月マスタ取込 → 前月取込 → 期首引継ぎ → 単位換算 → 期中仕入反映
 *   → 自店購入反映 → 導出値算出 → 検証 → レポート集計 → 前月比較・異常判定 → 検算
 *
 * 各段階はドメイン層の純粋関数であり、ここではその順序と入出力の受け渡しだけを担う。
 */
import { XlsxWorkbook } from '../xlsx/workbook';
import { readInventorySheet, toPreviousEntries, crossCheck, type AnalysisValues } from '../ingest/inventorySheet';
import { readOrderTable, readUnitMasterTable, type OrderFileMeta } from '../ingest/orderFile';
import { tableFromCsv, tableFromSheet } from '../ingest/tabular';
import { DEFAULT_PROFILES } from '../ingest/profiles';
import type { MappingProfile } from '../ingest/mapping';
import { applyCarryover } from '../domain/carryover';
import { convertOrderLines, applyPurchases } from '../domain/purchase';
import { computeAllDerived } from '../domain/calculation';
import { checkOrderPeriod } from '../domain/period';
import { validateProductRows } from '../domain/validation';
import { buildReport } from '../domain/report';
import { diffProducts, diffReports, type ProductDiffRow, type ReportDiffRow } from '../domain/diff';
import { detectAnomalies, DEFAULT_ANOMALY_RULES, type Anomaly, type AnomalyRule } from '../domain/anomaly';
import { IssueCollector, summarize, type ValidationIssue } from '../domain/issues';
import {
  checkFileIdentity,
  sha256Hex,
  type FileIdentity,
  type FileKind,
  type ImportedFileRecord,
} from '../ingest/fileIdentity';
import type {
  ProductRow,
  PreviousMonthEntry,
  ReportValues,
  OrderLine,
  UnitConversionEntry,
  OwnPurchaseInput,
  OwnPurchaseCandidate,
} from '../domain/models';

export interface UploadedFile {
  fileName: string;
  bytes: Uint8Array;
}

/**
 * 換算係数の確認が必要な新規商品。
 *
 * 新規商品は単位計算マスタに載っていないことがある（6月→7月では新規25件中3件が該当）。
 * 当月マスタP列の値を初期値として提示し、管理者に確認・修正させる。
 * 「先月になくて新しく登録された品名だけ単位を聞く」という運用要望に対応する。
 */
export interface FactorConfirmation {
  code: string;
  name: string;
  category: string;
  inventoryUnit: string | null;
  /** 当月マスタP列の値。初期値として画面に出す */
  suggestedFactor: number | null;
  /** 当月に発注があるか。あれば換算に直接影響するため確認は必須 */
  hasOrder: boolean;
  /** 換算前の発注数（発注がある場合） */
  orderQty: number | null;
}

export interface PipelineInput {
  targetYm: string;
  master: UploadedFile;
  previous?: UploadedFile | null;
  orders?: UploadedFile | null;
  unitMaster?: UploadedFile | null;
  ownPurchases?: readonly OwnPurchaseInput[];
  /** 画面で入力した当月売上高。null ならファイルの値を使う */
  totalSalesOverride?: number | null;
  lossAmountOverride?: number | null;
  approveNewOpening?: boolean;
  /**
   * 商品差分画面で期首在庫0を承認済みの商品コード。
   * W004 は1件のメッセージにまとめるため、承認済みを後から取り除くことができない。
   * 承認状態は引継ぎの前に反映し、そもそも未承認分だけがメッセージに載るようにする。
   */
  approvedOpeningCodes?: ReadonlySet<string>;
  /** 画面で確認・登録した換算係数（商品コード → 計算単位）。単位計算マスタより優先する */
  confirmedFactors?: ReadonlyMap<string, number>;
  /** 自店購入品の商品コード。未指定なら既定の5品（domain/productKind.ts） */
  ownPurchaseCodes?: ReadonlySet<string>;
  /** 過去の取込記録。同じファイルの取り違え（W008）の判定に使う。未指定なら判定しない */
  importHistory?: readonly ImportedFileRecord[];
  anomalyRules?: readonly AnomalyRule[];
  profiles?: Partial<Record<keyof typeof DEFAULT_PROFILES, MappingProfile>>;
}

export interface PipelineResult {
  targetYm: string;
  rows: ProductRow[];
  previousEntries: PreviousMonthEntry[];
  newProducts: ProductRow[];
  /** 換算係数の確認が必要な新規商品（単位計算マスタに登録がないもの） */
  factorConfirmations: FactorConfirmation[];
  deletedProducts: PreviousMonthEntry[];
  orderLines: OrderLine[];
  /** 発注累計照会のヘッダ情報（集計期間・店舗）。未取込なら null */
  orderMeta: OrderFileMeta | null;
  unitMaster: Map<string, UnitConversionEntry>;
  ownPurchaseCandidates: OwnPurchaseCandidate[];
  report: ReportValues;
  previousReport: ReportValues | null;
  productDiffs: ProductDiffRow[];
  reportDiffs: ReportDiffRow[];
  anomalies: Anomaly[];
  analysis: AnalysisValues;
  issues: ValidationIssue[];
  /** 今回取り込んだファイルの識別情報。取込履歴への記録に使う */
  importedFiles: ImportedFileRecord[];
  /** 出力時にテンプレートとして使うブック */
  masterWorkbook: XlsxWorkbook;
  hasBlocking: boolean;
}

function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length > 1 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const issues = new IssueCollector();
  const profiles = { ...DEFAULT_PROFILES, ...input.profiles };

  // --- 0. ファイルの同一性チェック（欄の取り違え・前月分の指定を先に出す） ---
  const slots: Array<[FileKind, typeof input.master | null | undefined]> = [
    ['master', input.master],
    ['previous', input.previous],
    ['orders', input.orders],
    ['unitMaster', input.unitMaster],
  ];
  const importedFiles: ImportedFileRecord[] = [];
  const identities: FileIdentity[] = [];
  const importedAt = new Date().toISOString();
  for (const [kind, file] of slots) {
    if (!file) continue;
    const sha256 = await sha256Hex(file.bytes);
    identities.push({ kind, fileName: file.fileName, sha256 });
    importedFiles.push({ kind, fileName: file.fileName, sha256, targetYm: input.targetYm, importedAt });
  }
  issues.addAll(checkFileIdentity(identities, input.importHistory ?? [], input.targetYm));

  // --- 1. 当月本部マスタ ---
  const masterWorkbook = await XlsxWorkbook.load(input.master.bytes);
  const master = readInventorySheet(masterWorkbook, profiles.HQ_MASTER, {
    fileName: input.master.fileName,
    approveOpening: input.approveNewOpening ?? false,
    ownPurchaseCodes: input.ownPurchaseCodes,
  });
  issues.addAll(master.issues);

  // 当月マスタは「店舗が数えた期末在庫を入力したもの」を渡す運用（設計書§12.1）。
  // 本部から届いたままのファイルは期末在庫が空で、そのまま取り込むと
  // 期首在庫と期中仕入を全量使い切った計算になり、使用高と原価率が大きく過大になる。
  // 1件も入っていなければ入力漏れとみなす。全商品の実在庫が0になることは実務上ありえない。
  if (master.rows.length > 0 && master.rows.every((r) => r.closingQty === 0)) {
    issues.add(
      'W025',
      `当月本部マスタの期末在庫が ${master.rows.length} 商品すべて0です。店舗が数えた期末在庫を入力してから指定してください。このまま進めると、期首在庫と期中仕入を全量使い切った計算になり、使用高と原価率が大きく過大になります。`,
      { fileName: input.master.fileName, sheetName: master.resolved.sheetName },
    );
  }

  // --- 2. 前月食品棚卸表 ---
  let previousEntries: PreviousMonthEntry[] = [];
  let previousReport: ReportValues | null = null;

  if (input.previous) {
    const prevWb = await XlsxWorkbook.load(input.previous.bytes);
    const prev = readInventorySheet(prevWb, profiles.PREV_INVENTORY, {
      fileName: input.previous.fileName,
      approveOpening: true,
      ownPurchaseCodes: input.ownPurchaseCodes,
    });
    issues.addAll(prev.issues);
    previousEntries = toPreviousEntries(prev.rows);
    previousReport = buildReport(prev.rows, {
      targetYm: previousYm(input.targetYm),
      totalSales: prev.analysis.totalSales,
      lossAmount: prev.analysis.lossAmount ?? 0,
    });

    // 検算は前月ファイルに対して行う。
    // 前月ファイルは完成済みで、こちらが値を書き換えないため、
    // 「システムの計算エンジンが現行帳票の数式と同じ結果を出すか」を毎月自動で確認できる。
    // 当月マスタは期首・期中仕入をこれから書き込む雛形であり、
    // キャッシュされた集計値は空欄状態のものなので比較対象にならない。
    issues.addAll(crossCheck(previousReport, prev.analysis));
  }

  // --- 3. 単位計算マスタ（換算係数の正） ---
  let unitMaster = new Map<string, UnitConversionEntry>();
  if (input.unitMaster) {
    const profile = profiles.UNIT_MASTER;
    // xlsx でも CSV でも受け取れるようにする。
    // 本部からは xlsx で配布されるが、発注システムの出力に計算単位を付けた CSV が
    // 使われることもあるため、形式で分岐する。
    let table: ReturnType<typeof tableFromCsv> | null = null;
    if (isXlsx(input.unitMaster.bytes)) {
      const wb = await XlsxWorkbook.load(input.unitMaster.bytes);
      const sheetName = profile.sheet.byName.find((n) => wb.hasSheet(n)) ?? wb.sheetNames[0];
      if (sheetName) {
        table = tableFromSheet(wb, sheetName, profile.header.row, profile.data.startRow);
      } else {
        issues.add('E008', '単位計算マスタのシートが見つかりません。', {
          fileName: input.unitMaster.fileName,
        });
      }
    } else {
      table = tableFromCsv(input.unitMaster.bytes, profile.header.detectBy);
    }

    if (table) {
      const read = readUnitMasterTable(table, profile, { fileName: input.unitMaster.fileName });
      issues.addAll(read.issues);
      unitMaster = read.entries;
    }
  }

  // --- 4. 期首引継ぎ（商品コード突合。行位置は使わない） ---
  const prevByCode = new Map(previousEntries.map((p) => [p.code as string, p]));
  const approved = input.approvedOpeningCodes;
  const masterRows =
    approved && approved.size > 0
      ? master.rows.map((r) => (approved.has(r.code) ? { ...r, openingApproved: true } : r))
      : master.rows;
  const carried = applyCarryover(masterRows, prevByCode, {
    fileName: input.master.fileName,
    sheetName: master.resolved.sheetName,
  });
  issues.addAll(carried.issues);
  let rows = carried.rows;

  // --- 5. 発注累計照会 → 単位換算 → 期中仕入 ---
  let orderLines: OrderLine[] = [];
  let orderMeta: OrderFileMeta | null = null;
  if (input.orders) {
    const profile = profiles.ORDER_CUMULATIVE;
    const table = isXlsx(input.orders.bytes)
      ? await (async () => {
          const wb = await XlsxWorkbook.load(input.orders!.bytes);
          const sheetName = profile.sheet.byName.find((n) => wb.hasSheet(n)) ?? wb.sheetNames[0]!;
          return tableFromSheet(wb, sheetName, profile.header.row, profile.data.startRow);
        })()
      : tableFromCsv(input.orders.bytes, profile.header.detectBy);

    const read = readOrderTable(table, profile, { fileName: input.orders.fileName });
    issues.addAll(read.issues);
    orderMeta = read.meta;

    // 納品日From/To が対象年月と整合するか（別の月のファイルを取り違えていないか）
    issues.addAll(
      checkOrderPeriod(
        input.targetYm,
        read.meta.periodFrom,
        read.meta.periodTo,
        input.orders.fileName,
        read.meta.periods,
      ),
    );

    // 換算係数は単位計算マスタを正とし、当月マスタP列はフォールバック兼検証に使う。
    // masterP のキー集合が「当月の棚卸対象商品」の判定も兼ねる。
    const masterP = new Map(rows.map((r) => [r.code as string, r.conversionFactor]));
    const converted = convertOrderLines(
      read.lines,
      { confirmed: input.confirmedFactors, unitMaster, masterP },
      { fileName: input.orders.fileName },
    );
    issues.addAll(converted.issues);
    orderLines = converted.lines;

    const applied = applyPurchases(rows, orderLines);
    issues.addAll(applied.issues);
    rows = applied.rows;
  }

  // --- 5.5 換算係数の確認が必要な新規商品 ---
  // 単位計算マスタに登録がない新規商品を抽出する。P列の値を初期値として提示し、
  // 管理者が確認・修正した値は次月以降のために保存される。
  const orderQtyByCode = new Map<string, number>();
  for (const line of orderLines) {
    orderQtyByCode.set(line.code, (orderQtyByCode.get(line.code) ?? 0) + line.orderQty);
  }
  const factorConfirmations: FactorConfirmation[] = carried.newProducts
    // 自店購入品は発注累計に現れないので換算係数が要らない。
    // 備品はそもそもこの棚卸表の計算対象外（要件§10-2）。
    .filter((r) => !r.isOwnPurchase && !r.isSupply)
    .filter((r) => !unitMaster.has(r.code))
    .filter((r) => !input.confirmedFactors?.has(r.code))
    .map((r) => ({
      code: r.code,
      name: r.name,
      category: r.category,
      inventoryUnit: r.inventoryUnit,
      suggestedFactor: r.conversionFactor > 0 ? r.conversionFactor : null,
      hasOrder: orderQtyByCode.has(r.code),
      orderQty: orderQtyByCode.get(r.code) ?? null,
    }))
    .sort((a, b) => Number(b.hasOrder) - Number(a.hasOrder) || (a.code < b.code ? -1 : 1));

  const needConfirm = factorConfirmations
    .filter((f) => f.hasOrder)
    .map((f) => ({ ref: { productCode: f.code }, text: `${f.code} ${f.name}` }));
  issues.addMany('W019', needConfirm, (n, d) =>
    `新規商品 ${n} 件に発注がありますが、単位計算マスタに計算単位が登録されていません（${summarize(d)}）。商品差分画面で換算係数を確認してください。`,
    { fileName: input.master.fileName });

  // --- 6. 自店購入（Aコード行への入力） ---
  const ownPurchaseCandidates = buildOwnPurchaseCandidates(rows);
  if (input.ownPurchases?.length) {
    const byCode = new Map(input.ownPurchases.map((o) => [o.code as string, o]));
    // 備品への入力は反映しない。「備品はこの棚卸表で計算しない」を画面の入力で破らせないため。
    const supplyEntries = rows.filter((r) => r.isSupply && byCode.has(r.code));
    rows = rows.map((row) => {
      const entry = byCode.get(row.code);
      if (!entry || row.isSupply) return row;
      return {
        ...row,
        purchaseQty: entry.purchaseQty,
        closingQty: entry.closingQty,
        unitPrice: entry.unitPrice,
      };
    });
    issues.addMany('W024',
      supplyEntries.map((r) => ({ ref: { productCode: r.code }, text: `${r.code} ${r.name}` })),
      (n, d) =>
        `備品 ${n} 件に自店購入が入力されましたが、反映していません（${summarize(d)}）。備品はこの棚卸表で計算しない取り決めです。食材であればコードが誤っていないか確認してください。`,
      { fileName: input.master.fileName });

    const missingOwn = input.ownPurchases
      .filter((o) => !rows.some((r) => r.code === o.code))
      .map((o) => ({ ref: { productCode: o.code }, text: `${o.code}` }));
    issues.addMany('W021', missingOwn, (n, d) =>
      `自店購入で指定された商品 ${n} 件が当月マスタにありません（${summarize(d)}）。本部へAコードの登録を依頼してください。`,
      { fileName: input.master.fileName });

    // 登録外の品目への入力は止めないが、後から追える形で残す。
    // 登録リストの更新漏れなのか、その月限りの購入なのかを翌月に判断できるようにする。
    const unregistered = rows
      .filter((r) => !r.isSupply && !r.isOwnPurchase && byCode.has(r.code))
      .map((r) => {
        const note = byCode.get(r.code)?.note;
        return { ref: { productCode: r.code }, text: `${r.code} ${r.name}${note ? `（${note}）` : ''}` };
      });
    issues.addMany('I005', unregistered, (n, d) =>
      `自店購入品として登録されていない ${n} 件に期中仕入を入力しました（${summarize(d)}）。毎月続くようであれば、自店購入品の登録を本部・店舗オーナーに依頼してください。`,
      { fileName: input.master.fileName });
  }

  // --- 7. 導出値 ---
  rows = computeAllDerived(rows);

  // --- 8. 検証 ---
  issues.addAll(
    validateProductRows(rows, {
      fileName: input.master.fileName,
      sheetName: master.resolved.sheetName,
    }),
  );

  // --- 9. レポート集計 ---
  const totalSales = input.totalSalesOverride ?? master.analysis.totalSales;
  const lossAmount = input.lossAmountOverride ?? master.analysis.lossAmount ?? 0;
  const report = buildReport(rows, { targetYm: input.targetYm, totalSales, lossAmount });

  if (report.overallCostRatePercent === null) {
    const reason =
      report.unavailableReasons['COST_RATE'] ?? '当月売上高が使えないため原価率を算出できません';
    issues.add(
      'W005',
      `${reason}。分析用シートの当月売上高を確認するか、分析・出力画面で入力してください。`,
      { fileName: input.master.fileName, sheetName: profiles.HQ_MASTER.analysisSheet?.name },
    );
  }

  // --- 10. 比較・異常判定 ---
  const rules = input.anomalyRules ?? DEFAULT_ANOMALY_RULES;
  const productDiffs = diffProducts(rows, previousEntries);
  const reportDiffs = diffReports(report, previousReport, rules);
  const anomalies = detectAnomalies(report, previousReport, rules);

  return {
    targetYm: input.targetYm,
    rows,
    previousEntries,
    newProducts: carried.newProducts,
    factorConfirmations,
    deletedProducts: carried.deletedProducts,
    orderLines,
    orderMeta,
    unitMaster,
    ownPurchaseCandidates,
    report,
    previousReport,
    productDiffs,
    reportDiffs,
    anomalies,
    analysis: master.analysis,
    issues: [...issues.all],
    importedFiles,
    masterWorkbook,
    hasBlocking: issues.hasBlocking(),
  };
}

/**
 * 自店購入の候補。品名の部分一致検索の母集合になる。
 *
 * 棚卸対象の全商品を候補にする。登録済みの自店購入品だけに絞っていたが、
 * 発注累計にも登録リストにも無い品を店舗が実際に買っており、
 * その分の期中仕入を入力する手段が無かった（要件§10-4）。
 *
 * 備品だけは除く。「備品はこの棚卸表で計算しない」が確定ルールであり、
 * ここから入力できると期中仕入に入ってしまい、そのルールを破るため。
 */
export function buildOwnPurchaseCandidates(rows: readonly ProductRow[]): OwnPurchaseCandidate[] {
  return rows
    .filter((r) => !r.isSupply)
    .map((r) => ({
      code: r.code,
      name: r.name,
      category: r.category,
      registered: r.isOwnPurchase,
      lastUsedYm: null,
      lastUnitPrice: r.unitPrice || null,
    }));
}

/**
 * 品名の部分一致検索。
 * 正規化は前後空白除去と英字小文字化のみ。全角/半角・カタカナ/ひらがなの
 * 統合はしない（要件§4「表記揺れを推測で同一視しない」）。
 */
export function searchOwnPurchaseCandidates(
  candidates: readonly OwnPurchaseCandidate[],
  query: string,
  limit = 50,
): OwnPurchaseCandidate[] {
  const key = query.trim().toLowerCase();
  const hit = key === '' ? [...candidates] : candidates.filter((c) => c.name.trim().toLowerCase().includes(key));
  // 登録済みの自店購入品を先頭に出す。母集合が全商品になったため、
  // 毎月入力する5品が候補の奥に埋もれないようにする。
  return hit
    .sort((a, b) => {
      if (a.registered !== b.registered) return a.registered ? -1 : 1;
      const ay = a.lastUsedYm ?? '';
      const by = b.lastUsedYm ?? '';
      if (ay !== by) return by.localeCompare(ay);
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    })
    .slice(0, limit);
}

export function previousYm(targetYm: string): string {
  const [y, m] = targetYm.split('-').map(Number);
  if (!y || !m) return targetYm;
  const date = new Date(Date.UTC(y, m - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
