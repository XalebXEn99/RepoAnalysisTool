import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyAppearance, readAppearance } from './lib/appearance';
import './styles/global.css';

applyAppearance(readAppearance());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
