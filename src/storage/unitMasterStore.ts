/**
 * 単位計算マスタの登録（ブラウザの localStorage）。
 *
 * 毎月アップロードし直すのではなく、一度指定したものをこのPCに登録しておき、
 * 翌月以降はそれを使う。新しいマスタが届いた月だけ指定し直す（2026-10-26 運用変更）。
 * 保存先はこの店舗PCのブラウザだけで、外部へは送らない。
 */
const KEY = 'fis.unitMaster.v1';

export interface SavedUnitMaster {
  fileName: string;
  /** 登録した日時（ISO） */
  savedAt: string;
  bytes: Uint8Array;
}

interface Stored {
  fileName: string;
  savedAt: string;
  base64: string;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  // 一度に渡すと引数が多すぎて落ちる環境があるため分割する
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function loadUnitMaster(): SavedUnitMaster | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    if (!s.fileName || !s.base64) return null;
    return { fileName: s.fileName, savedAt: s.savedAt, bytes: fromBase64(s.base64) };
  } catch {
    return null;
  }
}

/** 登録する。保存できなければ null（その月はアップロードした内容で計算できる） */
export function saveUnitMaster(file: { fileName: string; bytes: Uint8Array }): SavedUnitMaster | null {
  const saved: SavedUnitMaster = { fileName: file.fileName, savedAt: new Date().toISOString(), bytes: file.bytes };
  try {
    const stored: Stored = { fileName: saved.fileName, savedAt: saved.savedAt, base64: toBase64(file.bytes) };
    localStorage.setItem(KEY, JSON.stringify(stored));
    return saved;
  } catch {
    return null;
  }
}

export function clearUnitMaster(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 消せなくても画面の操作は続けられる
  }
}
