/**
 * SQLite スキーマ。設計書§5 のテーブル定義に対応する。
 *
 * ブラウザ内で sql.js（SQLite の WebAssembly ビルド）を動かし、
 * File System Access API で店舗PCのローカルフォルダにある .db ファイルを直接更新する。
 * 生成されるのは本物の SQLite ファイルなので、バックアップはコピーするだけでよく、
 * DB Browser for SQLite 等で中身を確認することもできる。
 *
 * 数値は TEXT で保持する。IEEE754 の丸め差で現行帳票との一致が崩れるのを避けるため、
 * 書いた文字列をそのまま読み戻す方針とする（Number 化は読み出し側で明示的に行う）。
 */

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 処理ラン（対象年月 × 版）
CREATE TABLE IF NOT EXISTS processing_run (
  run_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL DEFAULT 1,
  target_ym   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  state       TEXT    NOT NULL,
  is_final    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  note        TEXT,
  UNIQUE (store_id, target_ym, revision)
);

-- 対象年月ごとに最終確定版は1つだけ
CREATE UNIQUE INDEX IF NOT EXISTS ux_run_final
  ON processing_run (store_id, target_ym) WHERE is_final = 1;

-- 取込ファイルの識別情報（sha256 は同一ファイル再取込の検知 W008 に使う）
CREATE TABLE IF NOT EXISTS import_file (
  import_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES processing_run(run_id) ON DELETE CASCADE,
  file_kind         TEXT    NOT NULL,
  original_filename TEXT    NOT NULL,
  sha256            TEXT    NOT NULL,
  sheet_name        TEXT,
  header_row        INTEGER,
  row_count         INTEGER,
  profile_version   INTEGER,
  imported_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_import_run ON import_file (run_id);
CREATE INDEX IF NOT EXISTS ix_import_sha ON import_file (sha256);

-- 列マッピングプロファイル（更新せず常に新版を追加する）
CREATE TABLE IF NOT EXISTS mapping_profile (
  profile_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  file_kind        TEXT    NOT NULL,
  version          INTEGER NOT NULL,
  definition_json  TEXT    NOT NULL,
  effective_from_ym TEXT   NOT NULL,
  created_at       TEXT    NOT NULL,
  created_by       TEXT,
  change_reason    TEXT,
  UNIQUE (file_kind, version)
);

-- 月次商品明細のスナップショット（分類も月ごとに保持する）
CREATE TABLE IF NOT EXISTS monthly_product (
  run_id            INTEGER NOT NULL REFERENCES processing_run(run_id) ON DELETE CASCADE,
  line_no           INTEGER NOT NULL,
  product_code      TEXT    NOT NULL,
  product_name      TEXT,
  category          TEXT,
  inventory_unit    TEXT,
  unit_price        TEXT,
  conversion_factor TEXT,
  opening_qty       TEXT,
  purchase_qty      TEXT,
  closing_qty       TEXT,
  usage_qty         TEXT,
  usage_amount      TEXT,
  closing_amount    TEXT,
  status            TEXT,
  is_own_purchase   INTEGER NOT NULL DEFAULT 0,
  opening_approved  INTEGER NOT NULL DEFAULT 0,
  source_row_ref    TEXT,
  PRIMARY KEY (run_id, line_no)
);
CREATE INDEX IF NOT EXISTS ix_mp_run_code ON monthly_product (run_id, product_code);

-- 発注累計明細（換算前後と適用係数を残して追跡可能にする）
CREATE TABLE IF NOT EXISTS order_line (
  order_line_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES processing_run(run_id) ON DELETE CASCADE,
  product_code      TEXT    NOT NULL,
  order_qty         TEXT,
  conversion_factor TEXT,
  converted_qty     TEXT,
  factor_source     TEXT,
  is_return         INTEGER NOT NULL DEFAULT 0,
  source_row_ref    TEXT
);
CREATE INDEX IF NOT EXISTS ix_ol_run_code ON order_line (run_id, product_code);

-- 単位計算マスタの取込結果
CREATE TABLE IF NOT EXISTS unit_conversion (
  run_id       INTEGER NOT NULL REFERENCES processing_run(run_id) ON DELETE CASCADE,
  product_code TEXT    NOT NULL,
  product_name TEXT,
  unit_label   TEXT,
  factor       TEXT    NOT NULL,
  PRIMARY KEY (run_id, product_code)
);

-- 自店購入の入力履歴（品名の部分一致検索の対象）
CREATE TABLE IF NOT EXISTS own_purchase_history (
  history_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  search_key   TEXT NOT NULL,
  category     TEXT,
  unit_price   TEXT,
  target_ym    TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_oph_search ON own_purchase_history (search_key);
CREATE INDEX IF NOT EXISTS ix_oph_ym ON own_purchase_history (target_ym);

-- 管理レポート値（縦持ち。指標追加でスキーマ変更が不要）
CREATE TABLE IF NOT EXISTS report_value (
  run_id             INTEGER NOT NULL REFERENCES processing_run(run_id) ON DELETE CASCADE,
  scope              TEXT    NOT NULL,
  category           TEXT    NOT NULL DEFAULT '',
  metric             TEXT    NOT NULL,
  value              TEXT,
  unavailable_reason TEXT,
  PRIMARY KEY (run_id, scope, category, metric)
);

-- 検証結果
CREATE TABLE IF NOT EXISTS validation_issue (
  issue_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES processing_run(run_id) ON DELETE CASCADE,
  level        TEXT    NOT NULL,
  code         TEXT    NOT NULL,
  title        TEXT,
  message      TEXT    NOT NULL,
  file_name    TEXT,
  sheet_name   TEXT,
  row_no       INTEGER,
  product_code TEXT,
  -- 1事象1メッセージにまとめた際の対象件数と内訳（v2 で追加）
  detail_count INTEGER NOT NULL DEFAULT 1,
  details_json TEXT,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_vi_run ON validation_issue (run_id);

-- 操作履歴（差分の確認操作を記録する。要件§7）
CREATE TABLE IF NOT EXISTS audit_log (
  log_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  detail_json TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_run ON audit_log (run_id);
`;

export const AUDIT_ACTIONS = [
  'UPLOAD',
  'MAPPING_CHANGE',
  'DIFF_REVIEW',
  'OPENING_APPROVE',
  'OWN_PURCHASE_EDIT',
  'CALCULATE',
  'EXPORT',
  'FINALIZE',
  'DB_RESTORE',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type RunState =
  | 'DRAFT'
  | 'IMPORTED'
  | 'REVIEWED'
  | 'CALCULATED'
  | 'EXPORTED'
  | 'INVALIDATED';
