/** 保存したボードの一覧に表示する項目。 */
export interface BoardSummary {
  id: string;
  name: string;
  updatedAt: string;
}

/**
 * Excalidrawの描画内容。要素と画像はExcalidrawの形式のまま保存し、表示時にExcalidrawのrestoreで検証させる。
 * 背景色など、保存しておく表示設定だけをappStateに持つ。
 */
export interface BoardScene {
  elements: unknown[];
  files: Record<string, unknown>;
  appState: { viewBackgroundColor?: string };
}

export interface Board extends BoardSummary {
  scene: BoardScene;
}

export const MAX_NAME_LENGTH = 100;
export const MAX_ELEMENTS = 20_000;
/** 画像を貼り付けたボードも保存できるよう、保存1回の本文を8MBまでにする。 */
export const MAX_SCENE_BYTES = 8 * 1024 * 1024;
export const EMPTY_SCENE: BoardScene = { elements: [], files: {}, appState: {} };
