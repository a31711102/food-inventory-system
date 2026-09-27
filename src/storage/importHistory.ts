/**
 * 取込履歴（ファイルの SHA-256）の保存。
 *
 * 同一ファイルの取り違え検知（W008）は「前回までに何を取り込んだか」を知る必要がある。
 * SQLite の import_file テーブルにも記録するが、DB を接続していなくても検知できるよう、
 * ブラウザの localStorage にも軽い履歴を残す。
 *
 * 保存するのはファイル名・種別・年月・ハッシュだけで、原価データは一切含まない。
 */
import { mergeImportHistory, type ImportedFileRecord } from '../ingest/fileIdentity';

const STORAGE_KEY = 'fis.importHistory.v1';

export function loadImportHistory(): ImportedFileRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is ImportedFileRecord =>
        typeof r === 'object' && r !== null && typeof (r as ImportedFileRecord).sha256 === 'string',
    );
  } catch {
    // プライベートウィンドウ等で localStorage が使えない場合は履歴なしとして続行する
    return [];
  }
}

export function saveImportHistory(records: readonly ImportedFileRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // 保存できなくても処理自体は続行する（検知精度が落ちるだけ）
  }
}

export function appendImportHistory(added: readonly ImportedFileRecord[]): ImportedFileRecord[] {
  const merged = mergeImportHistory(loadImportHistory(), added);
  saveImportHistory(merged);
  return merged;
}

export function clearImportHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}
