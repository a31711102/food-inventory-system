import { useMemo, useState, type ReactNode } from 'react';
import type { ValidationIssue, IssueLevel } from '../domain/issues';

export function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

export function Note({
  children,
  variant = 'info',
}: {
  children: ReactNode;
  variant?: 'info' | 'warn';
}): JSX.Element {
  return <div className={variant === 'warn' ? 'note warn' : 'note'}>{children}</div>;
}

/** エラーの位置を「元ファイル名・シート名・行・商品コード」で示す（要件§7）。 */
function refText(issue: ValidationIssue): string {
  const parts: string[] = [];
  if (issue.ref.fileName) parts.push(issue.ref.fileName);
  if (issue.ref.sheetName) parts.push(`シート「${issue.ref.sheetName}」`);
  if (issue.ref.rowNo !== undefined) parts.push(`${issue.ref.rowNo}行目`);
  if (issue.ref.productCode) parts.push(`商品コード ${issue.ref.productCode}`);
  if (issue.ref.cell) parts.push(`セル ${issue.ref.cell}`);
  return parts.join(' / ');
}

const LEVEL_LABEL: Record<IssueLevel, string> = {
  BLOCKING: 'エラー',
  WARNING: '警告',
  INFO: '情報',
};

export function IssueList({
  issues,
  levels = ['BLOCKING', 'WARNING', 'INFO'],
  limit = 200,
  emptyText = '指摘はありません。',
}: {
  issues: readonly ValidationIssue[];
  levels?: IssueLevel[];
  limit?: number;
  emptyText?: string;
}): JSX.Element {
  const filtered = useMemo(
    () => issues.filter((i) => levels.includes(i.level)).slice(0, limit),
    [issues, levels, limit],
  );

  if (filtered.length === 0) return <p className="muted">{emptyText}</p>;

  return (
    <div>
      {filtered.map((issue, i) => (
        <div key={`${issue.code}-${i}`} className={`issue ${issue.level}`}>
          <div className="issue-head">
            [{issue.code}] {LEVEL_LABEL[issue.level]}: {issue.title}
          </div>
          <div>{issue.message}</div>
          {issue.details.length > 1 ? (
            <details className="issue-details">
              <summary>該当 {issue.count} 件の内訳を表示</summary>
              <ul>
                {issue.details.map((d, j) => (
                  <li key={j}>
                    {d.text}
                    {refText({ ...issue, ref: d.ref }) ? (
                      <span className="issue-ref"> {refText({ ...issue, ref: d.ref })}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {refText(issue) ? <div className="issue-ref">{refText(issue)}</div> : null}
        </div>
      ))}
      {issues.filter((i) => levels.includes(i.level)).length > limit ? (
        <p className="muted">ほか {issues.filter((i) => levels.includes(i.level)).length - limit} 件</p>
      ) : null}
    </div>
  );
}

export function IssueBadges({ issues }: { issues: readonly ValidationIssue[] }): JSX.Element {
  const counts = {
    BLOCKING: issues.filter((i) => i.level === 'BLOCKING').length,
    WARNING: issues.filter((i) => i.level === 'WARNING').length,
    INFO: issues.filter((i) => i.level === 'INFO').length,
  };
  return (
    <div className="badges">
      <span className={counts.BLOCKING > 0 ? 'badge blocking' : 'badge ok'}>
        エラー {counts.BLOCKING} 件
      </span>
      <span className={counts.WARNING > 0 ? 'badge warning' : 'badge'}>警告 {counts.WARNING} 件</span>
      <span className="badge">情報 {counts.INFO} 件</span>
    </div>
  );
}

export function FileSlot({
  title,
  description,
  accept,
  file,
  onSelect,
  onClear,
}: {
  title: string;
  description: string;
  accept: string;
  file: { fileName: string; bytes: Uint8Array } | null;
  onSelect: (file: File) => void;
  onClear: () => void;
}): JSX.Element {
  const [inputKey, setInputKey] = useState(0);
  return (
    <div className={file ? 'file-slot loaded' : 'file-slot'}>
      <div className="slot-title">{title}</div>
      <div className="slot-desc">{description}</div>
      {file ? (
        <div>
          <span className="slot-file">
            {file.fileName}（{(file.bytes.length / 1024).toFixed(0)} KB）
          </span>
          <button
            type="button"
            style={{ marginLeft: 12 }}
            onClick={() => {
              onClear();
              setInputKey((k) => k + 1);
            }}
          >
            取り消す
          </button>
        </div>
      ) : (
        <input
          key={inputKey}
          type="file"
          accept={accept}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onSelect(f);
          }}
        />
      )}
    </div>
  );
}

export function Kpi({
  label,
  value,
  note,
  alert = false,
}: {
  label: string;
  value: string;
  note?: string;
  alert?: boolean;
}): JSX.Element {
  return (
    <div className={alert ? 'kpi alert' : 'kpi'}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {note ? <div className="kpi-note">{note}</div> : null}
    </div>
  );
}
