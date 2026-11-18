import { useEffect, useRef } from 'react';

/**
 * 画面テスト用のExcalidrawの代わり。JSDOMではcanvasを描画できないため、
 * 保存・読み込みに使うAPIだけを、渡された初期データで再現する。実際の描画の確認ではない。
 */
type Element = { id: string; type: string; version: number; isDeleted?: boolean; fileId?: string };
declare global { interface Window { inuiTestActiveTool?: string } }
type Props = {
  initialData?: { elements?: Element[]; files?: Record<string, unknown>; appState?: { viewBackgroundColor?: string } };
  excalidrawAPI?: (api: unknown) => void;
  onChange?: (elements: Element[], appState: unknown, files: unknown) => void;
};

export function Excalidraw({ initialData, excalidrawAPI, onChange }: Props) {
  // 本物と同じく、初期データは最初の描画でだけ使う。
  const props = useRef({ initialData, excalidrawAPI, onChange });
  useEffect(() => {
    const { initialData, excalidrawAPI, onChange } = props.current;
    let elements = [...(initialData?.elements ?? [])];
    const appState = { viewBackgroundColor: initialData?.appState?.viewBackgroundColor ?? '#ffffff' };
    const files = initialData?.files ?? {};
    excalidrawAPI?.({
      setActiveTool: (tool: { type: string }) => { window.inuiTestActiveTool = tool.type; },
      getSceneElements: () => elements.filter((element) => !element.isDeleted),
      getFiles: () => files,
      getAppState: () => appState,
    });
    onChange?.(elements, appState, files);
    // テストからの操作として、要素を1つ追加する「描く」、背景色の変更、保存しない表示の変更（ズーム等）を受け付ける。
    const draw = () => {
      elements = [...elements, { id: `stub-${elements.length + 1}`, type: 'freedraw', version: 1 }];
      onChange?.(elements, appState, files);
    };
    const background = () => {
      appState.viewBackgroundColor = '#fff3bf';
      onChange?.(elements, appState, files);
    };
    const view = () => onChange?.(elements, appState, files);
    window.addEventListener('inui-test-draw', draw);
    window.addEventListener('inui-test-background', background);
    window.addEventListener('inui-test-view', view);
    return () => {
      window.removeEventListener('inui-test-draw', draw);
      window.removeEventListener('inui-test-background', background);
      window.removeEventListener('inui-test-view', view);
    };
  }, []);
  return <div data-testid="excalidraw-stub">ホワイトボード（テスト用）</div>;
}
