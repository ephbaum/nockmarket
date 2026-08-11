// /chart page: a stock selector backed by GET /api/trades?stock=, rendered
// with uPlot instead of jQuery + Highstock (S11 — Highcharts is not free
// for commercial use, and the old page loaded both it and jQuery 1.7.1
// over plain http:// CDNs). Also closes C12: this view previously had no
// route pointing at it at all.
import uPlot from '/vendor/uplot/uPlot.esm.js';

let chart;

function toUplotData(series) {
  // series is [[epochMs, price], ...] oldest-first; uPlot wants parallel
  // arrays with x in seconds.
  const timestamps = series.map(([ms]) => Math.floor(ms / 1000));
  const prices = series.map(([, price]) => price);
  return [timestamps, prices];
}

async function fetchSeries(stock) {
  const response = await fetch(`/api/trades?stock=${encodeURIComponent(stock)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to load trades for ${stock}`);
  }
  return response.json();
}

function clearContainer(container) {
  container.textContent = '';
}

async function renderChart(stock) {
  const container = document.getElementById('chart-container');
  const errorBox = document.getElementById('chart-error');
  if (!container) {
    return;
  }
  errorBox.textContent = '';

  let payload;
  try {
    payload = await fetchSeries(stock);
  } catch {
    errorBox.textContent = 'Could not load trade history.';
    return;
  }

  if (chart) {
    chart.destroy();
    chart = null;
  }
  clearContainer(container);

  if (payload.series.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = `No trades recorded yet for ${stock}.`;
    container.appendChild(empty);
    return;
  }

  chart = new uPlot(
    {
      title: `Trades — ${stock}`,
      width: container.clientWidth || 800,
      height: 400,
      series: [{}, { label: stock, stroke: '#3388ff', width: 2 }],
      scales: { x: { time: true } },
    },
    toUplotData(payload.series),
    container
  );
}

function init() {
  const select = document.getElementById('stock-select');
  if (!select) {
    return;
  }

  select.addEventListener('change', () => renderChart(select.value));
  renderChart(select.value);

  window.addEventListener('resize', () => {
    const container = document.getElementById('chart-container');
    if (chart && container) {
      chart.setSize({ width: container.clientWidth || 800, height: 400 });
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
