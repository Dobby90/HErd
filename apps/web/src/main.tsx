import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from './editor.js';
import '@xyflow/react/dist/style.css';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
const Workspace = lazy(() => import('./workspace.js').then(module => ({ default: module.Workspace })));
const workspace = new URLSearchParams(window.location.search).has('workspace');
createRoot(root).render(workspace
  ? <Suspense fallback={<p role="status">프로젝트 불러오는 중</p>}><Workspace /></Suspense>
  : <Editor topActions={<a className="workspace-link" href="/?workspace=1">프로젝트</a>} />);
