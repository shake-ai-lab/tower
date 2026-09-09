import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { connectWs } from './ws';

connectWs();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
