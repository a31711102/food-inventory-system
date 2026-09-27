/**
 * 店舗PCのローカルファイルとの接続。
 *
 * File System Access API（Chrome / Edge）が使える環境では、一度フォルダ内の
 * inventory.db を選んでもらえば、以後はそのファイルを直接読み書きする。
 * ファイルハンドルは IndexedDB に保存されるため、ブラウザを再起動しても
 * 選び直しは不要（初回アクセス時に権限の再確認だけ入る）。
 *
 * 非対応環境では、ダウンロード／アップロードで同じ .db ファイルをやり取りする
 * フォールバックに切り替える。いずれの場合もデータは端末の外へ出ない。
 */

export const DB_FILE_NAME = 'inventory.db';

const IDB_NAME = 'food-inventory-system';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'database-file';

export type StorageMode = 'file-system-access' | 'download-fallback';

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
  );
}

export function detectStorageMode(): StorageMode {
  return isFileSystemAccessSupported() ? 'file-system-access' : 'download-fallback';
}

// ---------------------------------------------------------------------------
// IndexedDB（ファイルハンドルの保管のみに使う）
// ---------------------------------------------------------------------------

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openIdb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openIdb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openIdb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// File System Access API
// ---------------------------------------------------------------------------

interface FileSystemFileHandleLike {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: BufferSource): Promise<void>; close(): Promise<void> }>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

type PickerWindow = typeof globalThis & {
  showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandleLike>;
  showOpenFilePicker?: (options: unknown) => Promise<FileSystemFileHandleLike[]>;
};

const PICKER_OPTIONS = {
  suggestedName: DB_FILE_NAME,
  types: [{ description: '食品棚卸システムのデータベース', accept: { 'application/x-sqlite3': ['.db'] } }],
};

/** 新規作成または既存の .db を選ぶ（保存先の指定）。 */
export async function pickDatabaseForSave(): Promise<FileSystemFileHandleLike> {
  const picker = (globalThis as PickerWindow).showSaveFilePicker;
  if (!picker) throw new Error('この環境では File System Access API を利用できません。');
  const handle = await picker(PICKER_OPTIONS);
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

/** 既存の .db を開く。 */
export async function pickDatabaseForOpen(): Promise<FileSystemFileHandleLike> {
  const picker = (globalThis as PickerWindow).showOpenFilePicker;
  if (!picker) throw new Error('この環境では File System Access API を利用できません。');
  const [handle] = await picker({ ...PICKER_OPTIONS, multiple: false });
  if (!handle) throw new Error('ファイルが選択されませんでした。');
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

/** 前回選んだファイルを復元する。権限が失効していれば再確認する。 */
export async function restoreSavedHandle(): Promise<FileSystemFileHandleLike | null> {
  if (!isFileSystemAccessSupported()) return null;
  const handle = await idbGet<FileSystemFileHandleLike>(HANDLE_KEY);
  if (!handle) return null;

  const state = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
  if (state === 'granted') return handle;

  const requested = (await handle.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
  return requested === 'granted' ? handle : null;
}

export async function forgetSavedHandle(): Promise<void> {
  await idbDelete(HANDLE_KEY);
}

export async function readFromHandle(handle: FileSystemFileHandleLike): Promise<Uint8Array> {
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function writeToHandle(
  handle: FileSystemFileHandleLike,
  bytes: Uint8Array,
): Promise<void> {
  const writable = await handle.createWritable();
  // BufferSource として渡すため、ビューではなく実体のバッファを切り出す
  await writable.write(bytes.slice().buffer as ArrayBuffer);
  await writable.close();
}

// ---------------------------------------------------------------------------
// フォールバック（ダウンロード／アップロード）
// ---------------------------------------------------------------------------

export function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 解放は次のタスクで行う（Safari が即時 revoke でダウンロードを取りこぼすため）
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadDatabase(bytes: Uint8Array, fileName = DB_FILE_NAME): void {
  downloadBytes(bytes, fileName, 'application/x-sqlite3');
}

export function downloadWorkbook(bytes: Uint8Array, fileName: string): void {
  downloadBytes(
    bytes,
    fileName,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
}

export async function readUploadedFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** バックアップ用のファイル名（世代管理は運用手順で行う）。 */
export function backupFileName(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `inventory_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`
  );
}
