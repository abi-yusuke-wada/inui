import { Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, ExcalidrawProps } from '@excalidraw/excalidraw/types';
import type { BoardScene } from './types.ts';

/** 要素の版の合計。追加・変更・削除で変わるため、未保存の変更の検出に使う。 */
export function sceneVersion(elements: readonly { version: number }[]): number {
  return elements.reduce((sum, element) => sum + element.version, 0);
}

/**
 * Excalidrawを表示する。ファイルの読み込み・上書き保存のメニューは使わず、保存はinuiの保存ボタンで行う。
 * 画像の書き出し（PNG・SVG）はExcalidrawのメニューから行える。
 * 開いた直後からドラッグで線を描けるよう、ペン（freedraw）を選んだ状態にする。他のツールはツールバーから選べる。
 */
export default function Canvas({ scene, onReady, onVersion }: {
  scene: BoardScene;
  onReady: (api: ExcalidrawImperativeAPI) => void;
  onVersion: (version: number) => void;
}) {
  // 保存した要素はExcalidrawの形式のまま渡し、Excalidrawがrestoreで検証・補正する。
  const initialData = {
    elements: scene.elements,
    files: scene.files,
    appState: { viewBackgroundColor: scene.appState.viewBackgroundColor ?? '#ffffff' },
  } as unknown as ExcalidrawProps['initialData'];
  const handleChange: NonNullable<ExcalidrawProps['onChange']> = (elements) => onVersion(sceneVersion(elements));
  const handleReady = (api: ExcalidrawImperativeAPI) => {
    api.setActiveTool({ type: 'freedraw' });
    onReady(api);
  };
  return <Excalidraw
    langCode="ja-JP"
    initialData={initialData}
    excalidrawAPI={handleReady}
    onChange={handleChange}
    UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
  />;
}
