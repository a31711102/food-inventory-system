/**
 * 発注累計照会の集計期間の検証。
 *
 * 実ファイルには 納品日From / 納品日To が入っており、2026年8月分は
 * 2026/08/01 〜 2026/08/31 だった。これにより要件§4の「集計期間」が
 * 月初〜月末であることが確定した。
 *
 * 取り違えたファイル（先月分の発注累計など）をそのまま処理すると、
 * 期中仕入だけが別月のものになった帳票ができあがる。それを防ぐ。
 */
import { IssueCollector, type ValidationIssue } from './issues';

/** "2026/08/01" と "2026-08-01" のどちらも受け付ける。 */
function parseDate(text: string | null): { year: number; month: number; day: number } | null {
  if (!text) return null;
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * 集計期間が対象年月と整合するか検証する。
 *
 * - 年月が違う → E004（BLOCKING）。取り違えたファイルで帳票を作らせない。
 * - 年月は合っているが月初〜月末でない → W015（WARNING）。締め日運用の可能性があるため止めない。
 * - 期間が読めない → 何も言わない（推測しない）。
 */
export function checkOrderPeriod(
  targetYm: string,
  periodFrom: string | null,
  periodTo: string | null,
  fileName?: string,
  /** ファイル内に現れた期間の異なり。2組以上あれば混在として警告する */
  allPeriods: readonly { from: string | null; to: string | null }[] = [],
): ValidationIssue[] {
  const issues = new IssueCollector();
  const ref0 = { fileName };

  if (allPeriods.length > 1) {
    const shown = allPeriods
      .slice(0, 5)
      .map((p) => `${p.from ?? '?'}〜${p.to ?? '?'}`)
      .join(' / ');
    issues.add(
      'W017',
      `発注累計照会に集計期間が ${allPeriods.length} 種類混在しています（${shown}${allPeriods.length > 5 ? ' ほか' : ''}）。複数月分をまとめて出力したファイルの可能性があります。対象年月の分だけになっているか確認してください。`,
      ref0,
    );
  }

  const from = parseDate(periodFrom);
  const to = parseDate(periodTo);
  if (!from || !to) return [...issues.all];

  const [ty, tm] = targetYm.split('-').map(Number);
  if (!ty || !tm) return [...issues.all];

  const ref = { fileName };
  const fromYm = `${from.year}-${String(from.month).padStart(2, '0')}`;
  const toYm = `${to.year}-${String(to.month).padStart(2, '0')}`;

  if (fromYm !== targetYm || toYm !== targetYm) {
    issues.add(
      'E004',
      `発注累計照会の集計期間が対象年月と一致しません（ファイルの期間: ${periodFrom} 〜 ${periodTo} / 対象年月: ${targetYm}）。別の月のファイルを指定していないか確認してください。`,
      ref,
    );
    return [...issues.all];
  }

  const lastDay = lastDayOfMonth(ty, tm);
  if (from.day !== 1 || to.day !== lastDay) {
    issues.add(
      'W015',
      `発注累計照会の集計期間が月初〜月末ではありません（${periodFrom} 〜 ${periodTo}、${targetYm}の月末は${lastDay}日）。締め日運用であれば問題ありませんが、期間の欠落がないか確認してください。`,
      ref,
    );
  }

  return [...issues.all];
}
