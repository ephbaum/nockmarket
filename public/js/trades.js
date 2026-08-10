// Renders the live order-book ladder from the structured market payload:
//   { stock, lastTrade: {price, volume}|null,
//     bids: [{price, volume}] x5, asks: [{price, volume}] x5 }
// bids/asks are always exactly 5 entries, best-first, with empty levels as
// {price: null, volume: 0} — no defensive length-checking needed here.
import { socket } from './socket.js';

const LEVELS = 5;

function formatLevel(level) {
  return level.price === null ? '—' : `${level.price.toFixed(2)} × ${level.volume}`;
}

function buildRow(stock) {
  const tr = document.createElement('tr');
  tr.dataset.stock = stock;

  const stockCell = document.createElement('th');
  stockCell.scope = 'row';
  stockCell.textContent = stock;
  tr.appendChild(stockCell);

  const cells = {};

  // Bid columns run BID5..BID1 (furthest from the market first), matching
  // the table header, so level index 0 (best bid) lands in the rightmost
  // bid column, right next to Trade.
  for (let i = LEVELS - 1; i >= 0; i--) {
    const td = document.createElement('td');
    tr.appendChild(td);
    cells[`bid${i}`] = td;
  }

  const tradeCell = document.createElement('td');
  tradeCell.className = 'trade-cell';
  tradeCell.textContent = '—';
  tr.appendChild(tradeCell);
  cells.trade = tradeCell;

  for (let i = 0; i < LEVELS; i++) {
    const td = document.createElement('td');
    tr.appendChild(td);
    cells[`ask${i}`] = td;
  }

  return { tr, cells };
}

function flash(cell) {
  cell.classList.remove('flash');
  // Force a reflow so re-adding the class restarts the CSS animation even
  // if a previous flash on this cell hasn't finished fading yet.
  void cell.offsetWidth;
  cell.classList.add('flash');
}

function updateRow({ cells }, payload) {
  payload.bids.forEach((level, i) => {
    cells[`bid${i}`].textContent = formatLevel(level);
  });
  payload.asks.forEach((level, i) => {
    cells[`ask${i}`].textContent = formatLevel(level);
  });
  if (payload.lastTrade) {
    cells.trade.textContent = `${payload.lastTrade.price.toFixed(2)} × ${payload.lastTrade.volume}`;
    flash(cells.trade);
  }
}

export function initTrades() {
  const tbody = document.getElementById('market-body');
  if (!tbody) {
    return;
  }

  /** @type {Map<string, {tr: HTMLTableRowElement, cells: object}>} */
  const rows = new Map();

  function rowFor(stock) {
    let entry = rows.get(stock);
    if (!entry) {
      entry = buildRow(stock);
      rows.set(stock, entry);
      tbody.appendChild(entry.tr);
    }
    return entry;
  }

  socket.on('market:snapshot', ({ books }) => {
    for (const payload of books) {
      updateRow(rowFor(payload.stock), payload);
    }
  });

  socket.on('market:delta', (payload) => {
    updateRow(rowFor(payload.stock), payload);
  });

  // Snapshot is normally already pushed on connect, but a late-initialized
  // tab (or a reconnect) can miss it — asking again is always safe.
  socket.emit('market:request');
}
