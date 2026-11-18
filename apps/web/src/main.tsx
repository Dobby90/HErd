import { createRoot } from 'react-dom/client';
import { SampleApp } from './sample-app.js';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<SampleApp />);
