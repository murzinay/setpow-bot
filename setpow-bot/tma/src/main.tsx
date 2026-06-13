import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  // Шаблон index.html всегда содержит #root — если его нет, что-то очень
  // не так с билдом. Лучше явный crash, чем тихий чёрный экран.
  throw new Error('Mount point #root missing in index.html');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
