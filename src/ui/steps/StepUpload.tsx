import { Panel, FileSlot, Note } from '../components';
import type { AppFiles, FileKind } from '../App';
import type { UploadedFile } from '../../app/pipeline';
import { previousYm } from '../format';

export function StepUpload({
  targetYm,
  files,
  onSetFile,
  onRun,
  running,
}: {
  targetYm: string;
  files: AppFiles;
  onSetFile: (kind: FileKind, file: UploadedFile | null) => void;
  onRun: () => void | Promise<void>;
  running: boolean;
}): JSX.Element {
  const select = async (kind: FileKind, file: File): Promise<void> => {
    onSetFile(kind, { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  };

  return (
    <Panel
      title="STEP 1　月次処理開始"
      hint="対象年月を選び、4種類のファイルをアップロードします。ファイル種別を取り違えないよう、それぞれ専用の欄に指定してください。"
    >
      <Note>
        対象年月は <strong>{targetYm}</strong>、前月比較の対象は <strong>{previousYm(targetYm)}</strong> です。
        当月本部マスタには、店舗が数えた期末在庫を入力済みのものを指定してください。
      </Note>

      <FileSlot
        title="① 当月本部マスタ棚卸表（必須）"
        description="当月の商品行・単価・仕入れ単位・期末在庫を含むファイル。出力Excelのテンプレートにもなります。"
        accept=".xlsx,.xlsm"
        file={files.master}
        onSelect={(f) => void select('master', f)}
        onClear={() => onSetFile('master', null)}
      />

      <FileSlot
        title="② 前月食品棚卸表"
        description="期首在庫の引継ぎ元、かつ前月比較の対象。未指定の場合は全商品が新規として扱われ、比較は行いません。"
        accept=".xlsx,.xlsm"
        file={files.previous}
        onSelect={(f) => void select('previous', f)}
        onClear={() => onSetFile('previous', null)}
      />

      <FileSlot
        title="③ 発注累計照会"
        description="期中仕入の元データ。CSV（Shift_JIS）をそのまま指定できます。ファイル内の納品日From/Toを対象年月と突合し、月違いを検出します。未指定の場合、期中仕入は0のままです。"
        accept=".csv,.xlsx,.xlsm"
        file={files.orders}
        onSelect={(f) => void select('orders', f)}
        onClear={() => onSetFile('orders', null)}
      />

      <FileSlot
        title="④ 単位計算マスタ（推奨）"
        description="期中仕入の換算係数（計算単位）の取得元です。未指定でも当月マスタの非表示列で代用できますが、その列は帳票上で確認できないため、本ファイルの指定を推奨します。"
        accept=".xlsx,.xlsm,.csv"
        file={files.unitMaster}
        onSelect={(f) => void select('unitMaster', f)}
        onClear={() => onSetFile('unitMaster', null)}
      />

      <div className="actions">
        <button type="button" className="primary" onClick={() => void onRun()} disabled={!files.master || running}>
          {running ? '取り込み中…' : '取り込んで次へ'}
        </button>
        {!files.master ? <span className="muted">当月本部マスタは必須です。</span> : null}
      </div>
    </Panel>
  );
}
