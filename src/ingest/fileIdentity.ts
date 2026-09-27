/**
 * 取込ファイルの同一性チェック。
 *
 * ファイルの取り違えは、画面上はエラーが出ないまま数字だけが静かに狂うため、
 * 取込時点で気づけるようにする。検出したいのは次の2つ。
 *
 *   W022  同じファイルを複数の欄に指定した（例: ①と②の両方に当月マスタを入れた）
 *   W008  過去に別の年月・別の種別として取り込んだファイルを、また取り込んでいる
 *
 * 同一性はファイル名ではなく内容の SHA-256 で判定する。名前を変えただけの
 * コピー（「食品棚卸表(1).xlsx」など）も同じファイルとして扱えるようにするため。
 *
 * 同じ年月・同じ種別での再取込は、修正して取り直す通常の運用なので警告しない。
 */
import { IssueCollector, summarize, type IssueDetail, type ValidationIssue } from '../domain/issues';

/** 取込欄の種別。画面の①〜④に対応する。 */
export type FileKind = 'master' | 'previous' | 'orders' | 'unitMaster';

export const FILE_KIND_LABELS: Record<FileKind, string> = {
  master: '当月本部マスタ棚卸表',
  previous: '前月食品棚卸表',
  orders: '発注累計照会',
  unitMaster: '単位計算マスタ',
};

/** 過去に取り込んだファイルの記録。DB または localStorage から与える。 */
export interface ImportedFileRecord {
  kind: FileKind;
  fileName: string;
  sha256: string;
  targetYm: string;
  importedAt: string;
}

/** 今回の取込対象1件。 */
export interface FileIdentity {
  kind: FileKind;
  fileName: string;
  sha256: string;
}

/**
 * バイト列の SHA-256 を16進文字列で返す。
 * ブラウザ・Node 18 以降の WebCrypto を使うので、外部ライブラリは不要。
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 同一性の検証。W022（欄の重複）と W008（過去取込との一致）をそれぞれ1件にまとめて返す。
 *
 * @param files    今回指定されたファイル（未指定の欄は含めない）
 * @param history  過去の取込記録。空なら W008 は判定しない
 * @param targetYm 今回の対象年月（YYYY-MM）
 */
export function checkFileIdentity(
  files: readonly FileIdentity[],
  history: readonly ImportedFileRecord[],
  targetYm: string,
): ValidationIssue[] {
  const issues = new IssueCollector();

  // --- W022 同じ内容のファイルが複数の欄にある ---
  const byHash = new Map<string, FileIdentity[]>();
  for (const f of files) {
    const list = byHash.get(f.sha256);
    if (list) list.push(f);
    else byHash.set(f.sha256, [f]);
  }
  const duplicated: IssueDetail[] = [];
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const slots = group.map((g) => FILE_KIND_LABELS[g.kind]).join(' と ');
    const names = [...new Set(group.map((g) => g.fileName))].join(' / ');
    duplicated.push({ ref: { fileName: group[0]!.fileName }, text: `${slots}（${names}）` });
  }
  issues.addMany(
    'W022',
    duplicated,
    (n, d) =>
      `同じ内容のファイルが複数の欄に指定されています（${n} 組：${summarize(d)}）。欄を取り違えていないか確認してください。`,
  );

  // --- W008 過去に別の年月・別の種別で取り込んだファイル ---
  const past = new Map<string, ImportedFileRecord[]>();
  for (const r of history) {
    const list = past.get(r.sha256);
    if (list) list.push(r);
    else past.set(r.sha256, [r]);
  }
  const reimported: IssueDetail[] = [];
  for (const f of files) {
    // 同じ年月・同じ種別での取り直しは通常運用なので対象外
    const others = (past.get(f.sha256) ?? []).filter(
      (r) => !(r.targetYm === targetYm && r.kind === f.kind),
    );
    if (others.length === 0) continue;
    const where = [...new Set(others.map((r) => `${r.targetYm} の${FILE_KIND_LABELS[r.kind]}`))].join(
      '、',
    );
    reimported.push({
      ref: { fileName: f.fileName },
      text: `${FILE_KIND_LABELS[f.kind]}「${f.fileName}」は ${where} と同じ内容`,
    });
  }
  issues.addMany(
    'W008',
    reimported,
    (n, d) =>
      `過去に別の年月または別の種別で取り込んだファイルが ${n} 件指定されています（${summarize(d)}）。前月分のファイルを指定していないか確認してください。`,
  );

  return [...issues.all];
}

/**
 * 取込記録を更新する。同じ年月・同じ種別の記録は最新の1件だけ残す
 * （取り直すたびに履歴が増え、W008 が自分自身に反応するのを防ぐ）。
 */
export function mergeImportHistory(
  history: readonly ImportedFileRecord[],
  added: readonly ImportedFileRecord[],
  limit = 200,
): ImportedFileRecord[] {
  const keyOf = (r: ImportedFileRecord): string => `${r.targetYm}\u0000${r.kind}`;
  const addedKeys = new Set(added.map(keyOf));
  const kept = history.filter((r) => !addedKeys.has(keyOf(r)));
  return [...added, ...kept].slice(0, limit);
}
