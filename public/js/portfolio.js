// Entry point for the /portfolio page: wires up the tab switcher, the
// add-stock form, the client-side filter, and the three socket-backed
// panels (market ladder, chat, account).
import { initTabs } from './tabs.js';
import { initTrades } from './trades.js';
import { initChat } from './chat.js';
import { initAccount } from './accounts.js';

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content ?? '';
}

function renderPortfolioRows(tbody, portfolio) {
  tbody.textContent = '';
  for (const holding of portfolio) {
    const tr = document.createElement('tr');
    tr.dataset.stock = holding.stock;

    const stockCell = document.createElement('th');
    stockCell.scope = 'row';
    stockCell.textContent = holding.stock;

    const volumeCell = document.createElement('td');
    volumeCell.textContent = String(holding.volume);

    const priceCell = document.createElement('td');
    priceCell.append(holding.price === null ? '—' : holding.price.toFixed(2));
    if (holding.stale) {
      const stale = document.createElement('small');
      stale.textContent = ' (stale)';
      priceCell.appendChild(stale);
    }

    tr.append(stockCell, volumeCell, priceCell);
    tbody.appendChild(tr);
  }
}

function renderErrors(container, errors) {
  if (!container) {
    return;
  }
  container.textContent = (errors ?? ['Something went wrong.']).join(' ');
}

function initAddStock() {
  const form = document.getElementById('add-stock-form');
  const tbody = document.getElementById('portfolio-body');
  if (!form || !tbody) {
    return;
  }
  const errorBox = document.getElementById('add-stock-errors');
  const stockInput = document.getElementById('stock-input');
  const volumeInput = document.getElementById('volume-input');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (errorBox) {
      errorBox.textContent = '';
    }

    const stock = stockInput.value.trim().toUpperCase();
    const volume = volumeInput.value ? Number(volumeInput.value) : 1;

    let response;
    try {
      response = await fetch('/api/add-stock', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'x-csrf-token': csrfToken(),
        },
        body: JSON.stringify({ stock, volume }),
      });
    } catch {
      renderErrors(errorBox, ['Could not reach the server.']);
      return;
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      renderErrors(errorBox, data.errors);
      return;
    }

    renderPortfolioRows(tbody, data.portfolio ?? []);
    stockInput.value = '';
    volumeInput.value = '1';
  });
}

function initFilter() {
  const filterInput = document.getElementById('filter-input');
  const tbody = document.getElementById('portfolio-body');
  if (!filterInput || !tbody) {
    return;
  }
  filterInput.addEventListener('input', () => {
    const needle = filterInput.value.trim().toLowerCase();
    for (const row of tbody.rows) {
      const stock = (row.dataset.stock ?? '').toLowerCase();
      row.hidden = needle.length > 0 && !stock.includes(needle);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initAddStock();
  initFilter();
  initTrades();
  initChat();
  initAccount();
});
