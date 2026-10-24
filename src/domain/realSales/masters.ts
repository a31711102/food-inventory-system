/**
 * リアル売上算出のマスタ（要件§11.5・§11.7）。
 *
 * 料率・容器単価・抽出条件は契約や商品構成で変わるため、コードに埋め込まず
 * 管理者が編集できるようにする。値を変えるときは上書きせず、
 * 新しい適用開始年月の行を足す。対象年月に有効な行を引いて計算するので、
 * 確定済みの過去月は変わらない（RS-05）。
 */
import { IssueCollector, type ValidationIssue } from '../issues';
import { parseDecimal, type Fixed } from './fixed';

/** 「最初から有効」を表す適用開始年月。 */
export const EPOCH_YM = '2000-01';

export interface DeliveryChannel {
  id: string;
  /** マスタ上の正式名 */
  name: string;
  /**
   * ジャーナル写真・既存Excelでの表記。表記ゆれは推測で同一視せず、ここに明示する。
   * 例: 写真は「UEらーめん代」、既存Excelは「UEラ－メン代」（全角マイナス）
   */
  aliases: string[];
  /** 手数料率（十進表記。"0.275" など） */
  rate: string;
  validFrom: string;
  validTo: string | null;
}

export interface ContainerPrice {
  /** 容器1個あたりの控除額（十進表記） */
  price: string;
  validFrom: string;
  validTo: string | null;
}

export interface ExtractRule {
  /** 大分類（いずれか） */
  bigCategories: string[];
  /** 中分類（いずれか）。容器を使う販売チャネル */
  midCategories: string[];
  /** 小分類のうち除外するもの（トッピングは容器を使わない） */
  excludeSmall: string[];
  /**
   * 対象の大分類にあるが、対象外と分かっている中分類（イートインなど）。
   * これ以外の中分類が現れたら、新しい販売チャネルや分類変更の可能性として警告する。
   */
  knownOtherMid: string[];
  /**
   * 対象の中分類で見たことがある小分類（除外分を含む）。
   * これ以外が現れたら数えたうえで警告する（新商品の分類が増えた可能性）。
   */
  knownSmall: string[];
  validFrom: string;
}

export interface RealSalesMasters {
  channels: DeliveryChannel[];
  /**
   * 売掛欄に並ぶが代行チャネルではない項目（手数料の対象外）。
   * 既存Excelに入っていない項目は対象外（店舗オーナー回答）。
   */
  ignoredPayments: string[];
  containerPrices: ContainerPrice[];
  extractRules: ExtractRule[];
}

/**
 * 写真・既存Excelで確認した代行チャネルの表記（料率は持たない）。
 *
 * 料率と容器単価は店舗の契約情報なので、公開リポジトリのコードには書かない。
 * 管理者が画面で登録するか、既存の「リアル売上算出（マスタ）.xlsx」から取り込む。
 * ここにあるのは、写真の表記をどのチャネルに対応づけるかの知識だけである。
 */
export const KNOWN_CHANNELS: readonly { id: string; name: string; aliases: string[] }[] = [
  { id: 'menu', name: 'menu', aliases: ['menu'] },
  { id: 'sharedeli', name: 'シェアデリ', aliases: ['シェアデリ'] },
  { id: 'ue-delivery', name: 'UE配達代行', aliases: ['UE配達代行'] },
  { id: 'ue-menya', name: 'UE麺屋代行', aliases: ['UE麺屋代行', 'UE麵屋代行'] },
  { id: 'ue-ramen', name: 'UEラーメン代行', aliases: ['UEラーメン代行', 'UEらーめん代', 'UEらーめん代行', 'UEラ－メン代', 'UEラーメン代'] },
  { id: 'rocketnow', name: 'ロケットナウ', aliases: ['ロケットナウ'] },
];

/** 容器対象出数の抽出条件（要件§11.4。POS の分類名で、金額を含まない） */
export const DEFAULT_EXTRACT_RULE: ExtractRule = {
  bigCategories: ['カレー', '期間限定'],
  midCategories: ['テイクアウト_カレー', '代行_カレー', 'テイクアウト_期間限定', '代行_期間限定'],
  excludeSmall: ['TO_トッピング', 'HD_トッピング'],
  knownOtherMid: ['イートイン_カレー', 'イートイン_期間限定'],
  knownSmall: [
    'TO_カレー（A）',
    'TO_カレー2品MIX（A）',
    'TO_生ソース（A）',
    'TO_トッピング',
    'HD_カレー（A）',
    'HD_カレー2品MIX（A）',
    'HD_生ソース（A）',
    'HD_トッピング',
  ],
  validFrom: EPOCH_YM,
};

/**
 * 初期状態のマスタ。料率と容器単価は空で、登録するまで E019 で止まる。
 * 売掛欄の対象外項目は支払方法の名称なので初期値として持つ。
 */
export const DEFAULT_MASTERS: RealSalesMasters = {
  channels: [],
  ignoredPayments: ['ナカペイ', 'モバイル・C'],
  containerPrices: [],
  extractRules: [DEFAULT_EXTRACT_RULE],
};

/** 既知チャネルの表記と料率から、マスタのチャネル行を作る（取込・初回登録用） */
export function channelRow(id: string, rate: string, validFrom: string = EPOCH_YM): DeliveryChannel {
  const known = KNOWN_CHANNELS.find((c) => c.id === id);
  if (!known) throw new Error(`未知のチャネル: ${id}`);
  return { id, name: known.name, aliases: [...known.aliases], rate, validFrom, validTo: null };
}

/** 対象年月に有効か（validTo は含む） */
export function isActive(row: { validFrom: string; validTo?: string | null }, ym: string): boolean {
  return row.validFrom <= ym && (row.validTo === null || row.validTo === undefined || ym <= row.validTo);
}

export interface ResolvedChannel {
  id: string;
  name: string;
  aliases: string[];
  rate: Fixed;
  rateText: string;
}

export interface ResolvedMasters {
  channels: ResolvedChannel[];
  ignoredPayments: string[];
  containerPrice: Fixed | null;
  containerPriceText: string | null;
  extractRule: ExtractRule | null;
  issues: ValidationIssue[];
}

/**
 * 対象年月に有効なマスタを引く。
 * 同じチャネルで有効な行が複数ある場合は、適用開始年月がいちばん新しいものを使う。
 */
export function resolveMasters(m: RealSalesMasters, ym: string): ResolvedMasters {
  const issues = new IssueCollector();

  const latest = <T extends { validFrom: string }>(rows: T[]): T | undefined =>
    [...rows].sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];

  const ids = [...new Set(m.channels.map((c) => c.id))];
  const channels: ResolvedChannel[] = [];
  const badRate: string[] = [];
  for (const id of ids) {
    const row = latest(m.channels.filter((c) => c.id === id && isActive(c, ym)));
    if (!row) continue;
    const rate = parseDecimal(row.rate);
    if (rate === null || rate < 0n) {
      badRate.push(`${row.name}（${row.rate}）`);
      continue;
    }
    channels.push({ id, name: row.name, aliases: row.aliases, rate, rateText: row.rate });
  }
  if (channels.length === 0) {
    issues.add('E019', `${ym} に有効な代行チャネルの料率がありません。料率マスタを登録してください（既存の「リアル売上算出（マスタ）.xlsx」から取り込めます）。`);
  }
  if (badRate.length > 0) {
    issues.add('E019', `料率が数値として読めないチャネルがあります（${badRate.join(' / ')}）。料率マスタを修正してください。`);
  }

  const priceRow = latest(m.containerPrices.filter((p) => isActive(p, ym)));
  const price = priceRow ? parseDecimal(priceRow.price) : null;
  if (!priceRow || price === null || price < 0n) {
    issues.add('E019', `${ym} に有効な容器単価がありません。容器単価マスタを登録してください。`);
  }

  const rule = latest(m.extractRules.filter((r) => r.validFrom <= ym)) ?? null;
  if (!rule) {
    issues.add('E019', `${ym} に有効な容器対象出数の抽出条件がありません。`);
  }

  return {
    channels,
    ignoredPayments: m.ignoredPayments,
    containerPrice: price,
    containerPriceText: priceRow?.price ?? null,
    extractRule: rule,
    issues: [...issues.all],
  };
}

/**
 * 表記の照合用の正規化。全角半角・空白・括弧だけをそろえる。
 * 麺と麵、ラーメンとらーめんのような違いはここでは吸収しない（別名表で明示する）。
 */
export function normalizeLabel(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s()（）「」\[\]【】]/g, '')
    .toLowerCase();
}

export type LabelKind = { kind: 'channel'; channel: ResolvedChannel } | { kind: 'ignored' } | { kind: 'unknown' };

/** 売掛欄の表記を、代行チャネル／対象外／未登録に分類する。 */
export function classifyPaymentLabel(label: string, resolved: ResolvedMasters): LabelKind {
  const key = normalizeLabel(label);
  const channel = resolved.channels.find((c) => [c.name, ...c.aliases].some((a) => normalizeLabel(a) === key));
  if (channel) return { kind: 'channel', channel };
  if (resolved.ignoredPayments.some((a) => normalizeLabel(a) === key)) return { kind: 'ignored' };
  return { kind: 'unknown' };
}
