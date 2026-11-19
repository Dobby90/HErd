import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeTheme, ThemeProvider } from './theme.js';
import '@xyflow/react/dist/style.css';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
const Workspace = lazy(() => import('./workspace.js').then(module => ({ default: module.Workspace })));
const app = createRoot(root);
const loading = <p role="status">프로젝트 불러오는 중</p>;
initializeTheme();

app.render(<ThemeProvider><Suspense fallback={loading}><Workspace /></Suspense></ThemeProvider>);
