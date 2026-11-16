import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
// 画面のJavaScriptは遅延読み込みし、CSSは小さいため最初の1ファイルへまとめる。
import '@inui/feature-markdown/styles.css';
import '@inui/feature-schedule/styles.css';
import '@inui/feature-tasks/styles.css';
import '@inui/feature-whiteboard/styles.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
