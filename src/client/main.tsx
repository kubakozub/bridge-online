/**
 * Entry point.
 *
 * Stylesheet order is deliberate and load-bearing: `tokens.css` first so every custom property
 * exists before anything reads it, then the app shell, then the component sheets in the order they
 * layer on top of each other (cards under the table furniture, then the bidding surfaces, then the
 * panels that float above everything).
 *
 * Local preferences are applied *before* the first render so the page never flashes the dark felt
 * theme at someone who chose the daylight one.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/tokens.css';
import './styles/app.css';
import './styles/cards.css';
import './styles/table.css';
import './styles/bidding.css';
import './styles/panels.css';

import { App } from './App';
import { loadLocalPrefs } from './net/identity';

loadLocalPrefs();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Brak elementu #root - sprawdź index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
