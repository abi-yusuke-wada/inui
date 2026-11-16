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
    // テストからの「描く」操作として、要素を1つ追加するイベントを受け付ける。
    const draw = () => {
      elements = [...elements, { id: `stub-${elements.length + 1}`, type: 'freedraw', version: 1 }];
      onChange?.(elements, appState, files);
    };
    window.addEventListener('inui-test-draw', draw);
    return () => window.removeEventListener('inui-test-draw', draw);
  }, []);
  return <div data-testid="excalidraw-stub">ホワイトボード（テスト用）</div>;
}
