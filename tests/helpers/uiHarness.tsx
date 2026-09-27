/**
 * 画面テスト（L5）の足場。
 *
 * 実ブラウザではなく happy-dom 上で本物の `<App />` を動かし、
 * ファイル選択からダウンロードまでを利用者と同じ操作で通す。
 * 取込・計算・出力はすべて本番のコードがそのまま動く（モックしない）ため、
 * 画面の状態遷移とボタンの活性制御を実際の結果に対して確認できる。
 *
 * docs/06_画面テスト手順書.md のケース M-01〜M-27 に対応する。
 */
import { fireEvent, render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { expect, vi } from 'vitest';
import App from '@/ui/App';
import { TARGET_YM, type TestFile } from './testdataSet';

/** 取込欄の並び（画面の①〜④）。 */
export const SLOTS = ['master', 'previous', 'orders', 'unitMaster'] as const;
export type SlotName = (typeof SLOTS)[number];

export interface CapturedDownload {
  fileName: string;
  /** Blob の読み出しは非同期なので Promise で持つ。`downloadedFile()` で待てる */
  bytes: Promise<Uint8Array>;
}

export interface Harness {
  user: UserEvent;
  rendered: RenderResult;
  /** 画面が発行したダウンロード。出力Excelの中身を検証するために保持する */
  downloads: CapturedDownload[];
}

function toFile(file: TestFile): File {
  // Uint8Array をそのまま渡すと happy-dom 側で ArrayBufferView 判定に落ちることがあるため、
  // ArrayBuffer に正規化してから File を作る。
  const buffer = file.bytes.slice().buffer as ArrayBuffer;
  return new File([buffer], file.name);
}

/**
 * `<App />` を描画し、ダウンロードを捕まえられる状態にする。
 *
 * localStorage は毎回消す。取込履歴が残っていると W008（同一ファイルの再取込）が
 * 出てケースごとの期待値が変わるため（手順書 §2.3 のリセットに相当）。
 */
export function setupApp(options: { keepHistory?: boolean } = {}): Harness {
  if (!options.keepHistory) localStorage.clear();

  // 1つのテストの中で cleanup() → setupApp() と描画し直すことがあるため、毎回張り直す
  vi.restoreAllMocks();

  const downloads: CapturedDownload[] = [];
  const blobs = new Map<string, Blob>();

  vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, obj as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

  // downloadBytes() は <a download> を作って click する。その click を拾って中身を残す。
  const originalClick = HTMLAnchorElement.prototype.click;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (this.download && blob) {
      downloads.push({
        fileName: this.download,
        bytes: blob.arrayBuffer().then((buf) => new Uint8Array(buf)),
      });
      return;
    }
    originalClick.call(this);
  });

  const user = userEvent.setup();
  const rendered = render(<App />);
  return { user, rendered, downloads };
}

/**
 * 画面を開き直す（ブラウザを再読込した状況）。
 * 取込履歴は localStorage に残るので、W008 の検証で「別のセッション」を作るのに使う。
 * cleanup() ではなく unmount() を使うのは、cleanup() が act の設定を戻してしまい
 * 以後の操作で警告が出るため。
 */
export function restartApp(h: Harness): Harness {
  h.rendered.unmount();
  return setupApp({ keepHistory: true });
}

// ---------------------------------------------------------------------------
// 画面の部品を取る
// ---------------------------------------------------------------------------

export function stepTabs(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.step-tab')];
}

export function fileInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('.file-slot input[type=file]')];
}

export function buttonByText(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.textContent?.includes(text) && !b.className.includes('step-tab'),
  );
  if (found.length === 0) throw new Error(`ボタンが見つかりません: ${text}`);
  return found[0]!;
}

export function findButton(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.includes(text) && !b.className.includes('step-tab'),
    ) ?? null
  );
}

/** 画面に出ている指摘。1件＝1メッセージ。 */
export interface ShownIssue {
  code: string;
  level: string;
  title: string;
  message: string;
  /** 内訳（折りたたみ）の行。2件以上まとめたときだけ出る */
  details: string[];
  detailSummary: string | null;
  /** 代表位置（ファイル名 / シート / 行 / 商品コード） */
  ref: string | null;
}

export function shownIssues(): ShownIssue[] {
  return [...document.querySelectorAll('.issue')].map((el) => {
    const head = el.querySelector('.issue-head')?.textContent ?? '';
    const m = /^\[(?<code>[EWI]\d{3})\]\s*(?<level>[^:]+):\s*(?<title>.*)$/.exec(head.trim());
    return {
      code: m?.groups?.['code'] ?? '',
      level: m?.groups?.['level']?.trim() ?? '',
      title: m?.groups?.['title']?.trim() ?? '',
      message: el.children[1]?.textContent ?? '',
      details: [...el.querySelectorAll('.issue-details li')].map((li) => li.textContent ?? ''),
      detailSummary: el.querySelector('.issue-details > summary')?.textContent ?? null,
      ref: el.querySelector(':scope > .issue-ref')?.textContent ?? null,
    };
  });
}

export function issuesOf(code: string): ShownIssue[] {
  return shownIssues().filter((i) => i.code === code);
}

export function issueCodes(): string[] {
  return shownIssues().map((i) => i.code);
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

/** STEP 1 の欄にファイルを指定する。既に入っていれば「取り消す」を押してから入れ直す。 */
export async function selectFile(h: Harness, slot: SlotName, file: TestFile): Promise<void> {
  // 取込後は STEP 2 以降を表示しているので、利用者と同じように STEP 1 へ戻る
  if (document.querySelectorAll('.file-slot').length === 0) await goToStep(h, 1);

  const index = SLOTS.indexOf(slot);
  const slotEl = document.querySelectorAll('.file-slot')[index];
  if (!slotEl) throw new Error(`取込欄が見つかりません: ${slot}`);

  const clear = within(slotEl as HTMLElement).queryByRole('button', { name: '取り消す' });
  if (clear) await h.user.click(clear);

  const input = (slotEl as HTMLElement).querySelector<HTMLInputElement>('input[type=file]');
  if (!input) throw new Error(`ファイル選択欄が見つかりません: ${slot}`);
  await h.user.upload(input, toFile(file));
  await waitFor(() => {
    expect((slotEl as HTMLElement).querySelector('.slot-file')?.textContent).toContain(file.name);
  });
}

export async function clearFile(h: Harness, slot: SlotName): Promise<void> {
  const slotEl = document.querySelectorAll('.file-slot')[SLOTS.indexOf(slot)];
  const clear = within(slotEl as HTMLElement).queryByRole('button', { name: '取り消す' });
  if (clear) await h.user.click(clear);
}

/**
 * 対象年月を設定する。
 * 既定値は「前月」（画面を開いた月の1つ前）なので、テストデータの 2026-09 を使うには
 * 必ず指定し直す必要がある。指定しないと発注累計の集計期間と食い違い E004 になる。
 *
 * 入力欄は STEP 1 にしかない。別のステップから呼ばれたらヘッダの
 * 「STEP 1 で変更」を押して戻る（実際の操作と同じ経路）。
 * `<input type="month">` は制御コンポーネントなので、change を直接発火させる。
 */
export async function setTargetYm(h: Harness, ym: string): Promise<void> {
  if (!document.querySelector('input[type=month]')) {
    const back = screen.queryByRole('button', { name: 'STEP 1 で変更' });
    if (back) await h.user.click(back);
  }
  const input = document.querySelector<HTMLInputElement>('input[type=month]');
  if (!input) throw new Error('対象年月の入力欄が見つかりません');
  fireEvent.change(input, { target: { value: ym } });
  await waitFor(() => expect(input.value).toBe(ym));
}

/**
 * 非同期の再計算を伴うクリック。
 *
 * パイプラインは Promise で状態を更新するため、クリック直後に読むと
 * 更新前の画面を見てしまう。Testing Library の waitFor は内部で act を張るので、
 * ここで一度待つことで更新を act の内側に収める（警告も出なくなる）。
 */
export async function clickAndSettle(h: Harness, button: HTMLButtonElement): Promise<void> {
  await h.user.click(button);
  await waitFor(() => {
    expect(document.body).toBeTruthy();
  });
}

/** 「取り込んで次へ」を押し、STEP 2 が出るまで待つ。 */
export async function runImport(h: Harness): Promise<void> {
  await clickAndSettle(h, buttonByText('取り込んで次へ'));
  await waitFor(
    () => {
      expect(document.body.textContent).toContain('STEP 2　列設定と取込結果');
    },
    { timeout: 20000 },
  );
}

export async function goToStep(h: Harness, step: 1 | 2 | 3 | 4 | 5): Promise<void> {
  const tab = stepTabs()[step - 1];
  if (!tab) throw new Error(`STEPタブが見つかりません: ${step}`);
  await h.user.click(tab);
  await waitFor(() => expect(document.body.textContent).toContain(`STEP ${step}　`));
}

/** STEP 3 → STEP 4 → STEP 5 と進める（途中で再計算が走る）。 */
export async function advanceToAnalyze(h: Harness): Promise<void> {
  await goToStep(h, 3);
  await clickAndSettle(h, buttonByText('自店購入入力へ'));
  await waitFor(() => expect(document.body.textContent).toContain('STEP 4　自店購入入力'));
  await clickAndSettle(h, buttonByText('計算して分析へ'));
  await waitFor(
    () => {
      expect(document.body.textContent).toContain('STEP 5　分析・出力');
      expect(findButton('完成Excelをダウンロード')).not.toBeNull();
    },
    { timeout: 20000 },
  );
}

/** 正常系4ファイルを指定して取り込む（多くのケースの共通前処理）。 */
export async function importNormalSet(
  h: Harness,
  set: Record<SlotName, TestFile>,
  overrides: Partial<Record<SlotName, TestFile>> = {},
): Promise<void> {
  await setTargetYm(h, TARGET_YM);
  for (const slot of SLOTS) {
    await selectFile(h, slot, overrides[slot] ?? set[slot]);
  }
  await runImport(h);
}

/**
 * 「完成Excelをダウンロード」を押し、出力されたファイルの中身を返す。
 * 実ブラウザで保存したものと同じバイト列なので、Excel で開く代わりに
 * ここで数式・書式・書き戻し値を検証できる（M-23・M-24）。
 */
export async function downloadWorkbook(h: Harness): Promise<CapturedDownload & { data: Uint8Array }> {
  const before = h.downloads.length;
  await clickAndSettle(h, buttonByText('完成Excelをダウンロード'));
  await waitFor(() => expect(h.downloads.length).toBe(before + 1), { timeout: 20000 });

  const entry = h.downloads[h.downloads.length - 1]!;
  return { ...entry, data: await entry.bytes };
}

/** 画面のバッジ（エラーN件・警告N件・情報N件）を数値で返す。 */
export function badgeCounts(): { blocking: number; warning: number; info: number } {
  const text = document.body.textContent ?? '';
  const pick = (label: string): number => Number(new RegExp(`${label} (\\d+) 件`).exec(text)?.[1] ?? -1);
  return { blocking: pick('エラー'), warning: pick('警告'), info: pick('情報') };
}

export { fireEvent, screen, waitFor, within };
