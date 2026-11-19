import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from './editor.js';
import { initializeTheme, ThemeProvider } from './theme.js';
import '@xyflow/react/dist/style.css';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
const Workspace = lazy(() => import('./workspace.js').then(module => ({ default: module.Workspace })));
const app = createRoot(root);
const parameters = new URLSearchParams(window.location.search);
const loading = <p role="status">프로젝트 불러오는 중</p>;
initializeTheme();

async function openHome() {
  const workspace = parameters.has('workspace') || (!parameters.has('local') && await fetch('/api/me', {
    cache: 'no-store', signal: AbortSignal.timeout(3000),
  }).then(async response => response.ok && (await response.json()).auth?.local === true).catch(() => false));
  app.render(<ThemeProvider>{workspace ? <Suspense fallback={loading}><Workspace /></Suspense>
    : <Editor topActions={<a className="workspace-link" href="/?workspace=1">프로젝트</a>} />}</ThemeProvider>);
}

app.render(loading);
void openHome();
