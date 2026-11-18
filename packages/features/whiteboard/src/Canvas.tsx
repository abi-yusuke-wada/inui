import { Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, ExcalidrawProps } from '@excalidraw/excalidraw/types';
import type { BoardScene } from './types.ts';

/**
 * 保存対象の描画内容の版。要素の版の合計（追加・変更・削除で変わる）と背景色を組み合わせ、未保存の変更の検出に使う。
 * ズームやスクロールなど、保存しない表示の変更では変わらない。
 */
export function sceneVersion(elements: readonly { version: number }[], background: string): string {
  return `${elements.reduce((sum, element) => sum + element.version, 0)}:${background}`;
}

/**
 * Excalidrawを表示する。ファイルの読み込み・上書き保存のメニューは使わず、保存はinuiの保存ボタンで行う。
 * 画像の書き出し（PNG・SVG）はExcalidrawのメニューから行える。
 * 開いた直後からドラッグで線を描けるよう、ペン（freedraw）を選んだ状態にする。他のツールはツールバーから選べる。
 * Excalidraw 0.18.1はAPIを渡した後の初期化でinitialDataのツールへ戻すため、APIのsetActiveToolではなくinitialDataで指定する。
 */
export default function Canvas({ scene, onReady, onVersion }: {
  scene: BoardScene;
  onReady: (api: ExcalidrawImperativeAPI) => void;
  onVersion: (version: string) => void;
}) {
  // 保存した要素はExcalidrawの形式のまま渡し、Excalidrawがrestoreで検証・補正する。
  const initialData = {
    elements: scene.elements,
    files: scene.files,
    appState: { viewBackgroundColor: scene.appState.viewBackgroundColor ?? '#ffffff', activeTool: { type: 'freedraw' } },
  } as unknown as ExcalidrawProps['initialData'];
  const handleChange: NonNullable<ExcalidrawProps['onChange']> = (elements, appState) =>
    onVersion(sceneVersion(elements, appState.viewBackgroundColor));
  return <Excalidraw
    langCode="ja-JP"
    initialData={initialData}
    excalidrawAPI={onReady}
    onChange={handleChange}
    UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
  />;
}
