/**
 * File System Access API のテスト用スタブ。
 *
 * 店舗PCでは Chrome / Edge の File System Access API で .db を直接読み書きする。
 * happy-dom にはこのAPIも IndexedDB も無いため、**保存先だけ**をメモリ上に差し替える。
 * SQLite の読み書き・スキーマ・保存内容は本物の sql.js がそのまま動く。
 *
 * 差し替えるのはブラウザ側のAPIだけで、アプリのコードには手を入れない。
 */
import 'fake-indexeddb/auto';
import { forgetSavedHandle } from '@/storage/fileSystem';

export interface StubFile {
  name: string;
  bytes: Uint8Array;
}

export interface FileSystemStub {
  /** 「保存先」として選ばれたファイルの中身。実ファイルの代わり */
  files: Map<string, StubFile>;
  /** ピッカーで選ばれることになるファイル名 */
  nextName: string;
  /** ピッカーが呼ばれた回数 */
  saveCalls: number;
  openCalls: number;
  restore(): void;
}

/**
 * テスト用のファイルハンドル。
 *
 * メソッドは**プロトタイプ側**に置く。本物の FileSystemFileHandle は
 * IndexedDB に structuredClone で保存できるが、メソッドを自身のプロパティとして
 * 持つオブジェクトは clone できず「could not be cloned」で落ちるため。
 */
class StubFileHandle {
  constructor(
    readonly name: string,
    private readonly store: Map<string, StubFile>,
  ) {}

  async getFile(): Promise<File> {
    const stored = this.store.get(this.name);
    const bytes = stored ? stored.bytes : new Uint8Array(0);
    return new File([bytes.slice().buffer as ArrayBuffer], this.name);
  }

  async createWritable(): Promise<{
    write(data: BufferSource): Promise<void>;
    close(): Promise<void>;
  }> {
    const chunks: Uint8Array[] = [];
    const store = this.store;
    const name = this.name;
    return {
      async write(data: BufferSource) {
        chunks.push(
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array((data as ArrayBufferView).buffer),
        );
      },
      async close() {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          merged.set(c, at);
          at += c.length;
        }
        store.set(name, { name, bytes: merged });
      },
    };
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }
}

/**
 * `showSaveFilePicker` / `showOpenFilePicker` を仕込む。
 * これを呼ばない限り画面はダウンロード方式（フォールバック）で動く。
 */
export function installFileSystemStub(initial: StubFile[] = []): FileSystemStub {
  const g = globalThis as Record<string, unknown>;
  const previousSave = g['showSaveFilePicker'];
  const previousOpen = g['showOpenFilePicker'];

  const stub: FileSystemStub = {
    files: new Map(initial.map((f) => [f.name, f])),
    nextName: initial[0]?.name ?? 'inventory.db',
    saveCalls: 0,
    openCalls: 0,
    restore() {
      g['showSaveFilePicker'] = previousSave;
      g['showOpenFilePicker'] = previousOpen;
    },
  };

  const handleFor = (name: string): StubFileHandle => new StubFileHandle(name, stub.files);

  g['showSaveFilePicker'] = async (): Promise<StubFileHandle> => {
    stub.saveCalls += 1;
    return handleFor(stub.nextName);
  };
  g['showOpenFilePicker'] = async (): Promise<StubFileHandle[]> => {
    stub.openCalls += 1;
    return [handleFor(stub.nextName)];
  };

  return stub;
}

/**
 * 保存済みのファイルハンドルを消す（前のテストの接続を引き継がないため）。
 *
 * `indexedDB.deleteDatabase()` は使わない。アプリは IndexedDB の接続を開いたままにするので
 * 削除がブロックされ、待ち続けてしまう。アプリ自身の後片付け用APIを使う。
 */
export async function clearHandleStore(): Promise<void> {
  await forgetSavedHandle();
}
