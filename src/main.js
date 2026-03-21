import './style.css';

const DATASET_URL = 'https://api.energidataservice.dk/dataset/DayAheadPrices';
const AREAS = ['DK1', 'DK2'];
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const AREA_LABELS = {
  DK1: 'Vest',
  DK2: 'Øst',
};

const app = document.querySelector('#app');

app.innerHTML = `
  <main class="page-shell">
    <section class="top-panel card">
      <div class="top-panel-main">
        <p class="eyebrow">Energi Data Service</p>
        <h1>Elpriser i Danmark</h1>
        <p class="hero-copy">
          Elpriser for <strong>Vest</strong> og <strong>Øst</strong>.
        </p>
      </div>
      <div class="top-panel-actions">
        <div class="top-panel-controls">
          <div class="area-picker" role="tablist" aria-label="Prisområde">
            ${AREAS.map(
              (area) => `
                <button class="area-button" id="area-${area}" type="button" role="tab" aria-selected="false">
                  ${AREA_LABELS[area]}
                </button>
              `,
            ).join('')}
          </div>
          <button class="refresh-button" id="refresh-button" type="button">
            Opdater data
          </button>
        </div>
        <p class="meta top-status" id="status-text">Henter elpriser...</p>
      </div>
    </section>

    <section class="summary-grid">
      <article class="card summary-card">
        <p class="label">Pris lige nu</p>
        <p class="value" id="current-price">-</p>
        <p class="hint" id="current-window">-</p>
      </article>
      <article class="card summary-card">
        <p class="label">Næste interval</p>
        <p class="value" id="next-price">-</p>
        <p class="hint" id="next-window">-</p>
      </article>
      <article class="card summary-card">
        <p class="label">Dagens gennemsnit</p>
        <p class="value" id="average-price">-</p>
        <p class="hint" id="average-window">Beregnet for valgt område</p>
      </article>
    </section>

    <section class="card table-card">
      <div class="table-header">
        <h2>Dagens prisoversigt</h2>
      </div>
      <div class="chart-wrap">
        <div class="chart-shell" id="prices-chart">
          <p class="meta">Henter data...</p>
        </div>
      </div>
    </section>
  </main>
`;

const state = {
  area: 'DK1',
  dataByArea: new Map(),
};

const elements = {
  refreshButton: document.querySelector('#refresh-button'),
  statusText: document.querySelector('#status-text'),
  currentPrice: document.querySelector('#current-price'),
  currentWindow: document.querySelector('#current-window'),
  nextPrice: document.querySelector('#next-price'),
  nextWindow: document.querySelector('#next-window'),
  averagePrice: document.querySelector('#average-price'),
  averageWindow: document.querySelector('#average-window'),
  pricesChart: document.querySelector('#prices-chart'),
  areaButtons: AREAS.reduce((buttons, area) => {
    buttons[area] = document.querySelector(`#area-${area}`);
    return buttons;
  }, {}),
};

for (const area of AREAS) {
  elements.areaButtons[area].addEventListener('click', () => {
    state.area = area;
    render();
  });
}

elements.refreshButton.addEventListener('click', () => {
  void loadPrices();
});

window.setInterval(() => {
  if (!document.hidden) {
    void loadPrices();
  }
}, AUTO_REFRESH_INTERVAL_MS);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    void loadPrices();
  }
});

void loadPrices();

async function loadPrices() {
  setLoadingState(true);

  try {
    const records = await fetchDayAheadPrices();
    const grouped = groupByArea(records);

    for (const area of AREAS) {
      if (!grouped.has(area) || grouped.get(area).length === 0) {
        throw new Error(`Ingen prisdata modtaget for ${area}.`);
      }
    }

    state.dataByArea = grouped;
    render();
    elements.statusText.textContent = `Senest opdateret ${formatTimestamp(new Date())}`;
  } catch (error) {
    console.error(error);
    renderError(error instanceof Error ? error.message : 'Ukendt fejl ved hentning af elpriser.');
  } finally {
    setLoadingState(false);
  }
}

async function fetchDayAheadPrices() {
  const today = new Date();
  const tomorrow = addDays(today, 1);

  const params = new URLSearchParams({
    start: formatApiDate(today),
    end: formatApiDate(tomorrow),
    sort: 'TimeDK ASC',
    limit: '500',
    filter: JSON.stringify({ PriceArea: AREAS }),
  });

  const response = await fetch(`${DATASET_URL}?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`API-kald fejlede med status ${response.status}.`);
  }

  const payload = await response.json();

  if (!payload.records || !Array.isArray(payload.records)) {
    throw new Error('API-svaret havde ikke det forventede format.');
  }

  const quarterHourRecords = payload.records.map((record) => ({
    area: record.PriceArea,
    startsAt: new Date(`${record.TimeUTC}Z`),
    localStartsAt: record.TimeDK,
    priceDkkPerMwh: record.DayAheadPriceDKK,
    priceDkkPerKwh: record.DayAheadPriceDKK / 1000,
  }));

  return aggregateToHourly(quarterHourRecords);
}

function groupByArea(records) {
  const grouped = new Map();

  for (const area of AREAS) {
    grouped.set(area, []);
  }

  for (const record of records) {
    if (!grouped.has(record.area)) {
      continue;
    }

    grouped.get(record.area).push(record);
  }

  for (const area of AREAS) {
    grouped.get(area).sort((left, right) => left.startsAt - right.startsAt);
  }

  return grouped;
}

function aggregateToHourly(records) {
  const grouped = new Map();

  for (const record of records) {
    const hourKey = record.localStartsAt.slice(0, 13);
    const groupKey = `${record.area}-${hourKey}`;

    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        area: record.area,
        startsAt: record.startsAt,
        points: [],
      });
    }

    grouped.get(groupKey).points.push(record);
  }

  return Array.from(grouped.values()).map((group) => {
    const totalMwh = group.points.reduce((sum, point) => sum + point.priceDkkPerMwh, 0);
    const averageMwh = totalMwh / group.points.length;

    return {
      area: group.area,
      startsAt: group.startsAt,
      endsAt: new Date(group.startsAt.getTime() + 60 * 60 * 1000),
      priceDkkPerMwh: averageMwh,
      priceDkkPerKwh: averageMwh / 1000,
    };
  });
}

function render() {
  for (const area of AREAS) {
    const isSelected = area === state.area;
    elements.areaButtons[area].classList.toggle('is-active', isSelected);
    elements.areaButtons[area].setAttribute('aria-selected', String(isSelected));
  }

  const selectedRecords = state.dataByArea.get(state.area) ?? [];

  if (selectedRecords.length === 0) {
    renderError(`Ingen prisdata klar til ${state.area}.`);
    return;
  }

  const now = new Date();
  const currentIndex = findCurrentIndex(selectedRecords, now);
  const currentRecord = currentIndex >= 0 ? selectedRecords[currentIndex] : selectedRecords[0];
  const nextRecord = currentIndex >= 0 ? selectedRecords[currentIndex + 1] : selectedRecords[1];
  const averagePrice =
    selectedRecords.reduce((sum, record) => sum + record.priceDkkPerKwh, 0) /
    selectedRecords.length;

  elements.currentPrice.textContent = formatPrice(currentRecord.priceDkkPerKwh);
  elements.currentWindow.textContent = formatWindow(currentRecord.startsAt);
  elements.nextPrice.textContent = nextRecord ? formatPrice(nextRecord.priceDkkPerKwh) : 'Ingen data';
  elements.nextWindow.textContent = nextRecord ? formatWindow(nextRecord.startsAt) : 'Ingen senere intervaller';
  elements.averagePrice.textContent = formatPrice(averagePrice);
  elements.pricesChart.innerHTML = renderChart(selectedRecords, currentRecord);
}

function renderError(message) {
  elements.statusText.textContent = message;
  elements.currentPrice.textContent = '-';
  elements.currentWindow.textContent = '-';
  elements.nextPrice.textContent = '-';
  elements.nextWindow.textContent = '-';
  elements.averagePrice.textContent = '-';
  elements.pricesChart.innerHTML = `<p class="meta">${message}</p>`;
}

function setLoadingState(isLoading) {
  elements.refreshButton.disabled = isLoading;
  elements.refreshButton.textContent = isLoading ? 'Opdaterer...' : 'Opdater data';
  if (isLoading) {
    elements.statusText.textContent = 'Henter elpriser...';
  }
}

function findCurrentIndex(records, now) {
  for (let index = 0; index < records.length; index += 1) {
    const current = records[index];

    if (now >= current.startsAt && now < current.endsAt) {
      return index;
    }
  }

  return -1;
}

function formatApiDate(date) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatTimestamp(date) {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  }).format(date);
}

function formatWindow(startDate) {
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit',
    minute: '2-digit',
  });

  return `${formatter.format(startDate)} - ${formatter.format(endDate)}`;
}

function formatPrice(price) {
  return `${price.toFixed(2).replace('.', ',')} kr/kWh`;
}

function renderChart(records, currentRecord) {
  const viewportWidth = window.innerWidth || 1024;
  const viewportHeight = window.innerHeight || 800;
  const isWideShortTablet = viewportWidth >= 1200 && viewportHeight <= 820;
  const width = 960;
  const height = isWideShortTablet ? 220 : viewportWidth <= 560 ? 240 : viewportWidth <= 900 ? 260 : 280;
  const padding =
    isWideShortTablet
      ? { top: 18, right: 20, bottom: 40, left: 62 }
      : viewportWidth <= 560
      ? { top: 24, right: 16, bottom: 44, left: 56 }
      : viewportWidth <= 900
        ? { top: 24, right: 20, bottom: 50, left: 64 }
      : { top: 24, right: 24, bottom: 56, left: 72 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxPrice = Math.max(...records.map((record) => record.priceDkkPerKwh), 0.01);
  const stepX = records.length > 1 ? innerWidth / (records.length - 1) : innerWidth;
  const preferredLabelCount = isWideShortTablet ? 10 : viewportWidth <= 420 ? 4 : viewportWidth <= 768 ? 6 : viewportWidth <= 900 ? 7 : 8;
  const labelStep = Math.max(1, Math.ceil(records.length / preferredLabelCount));
  const yTicks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => ({
    value: maxPrice * ratio,
    y: padding.top + innerHeight - innerHeight * ratio,
  }));

  const points = records.map((record, index) => {
    const x = padding.left + stepX * index;
    const y = padding.top + innerHeight - (record.priceDkkPerKwh / maxPrice) * innerHeight;

    return { record, x, y };
  });

  const polylinePoints = points.map((point) => `${point.x},${point.y}`).join(' ');
  const areaPoints = [
    `${padding.left},${height - padding.bottom}`,
    ...points.map((point) => `${point.x},${point.y}`),
    `${padding.left + innerWidth},${height - padding.bottom}`,
  ].join(' ');

  const labels = points
    .filter((_, index) => index === 0 || index === points.length - 1 || index % labelStep === 0)
    .map(
      (point) => `
        <div class="chart-label" style="left:${((point.x - padding.left) / innerWidth) * 100}%">
          ${formatHour(point.record.startsAt)}
        </div>
      `,
    )
    .join('');

  const yAxisMarkup = yTicks
    .map(
      (tick) => `
        <g>
          <line
            x1="${padding.left}"
            y1="${tick.y}"
            x2="${width - padding.right}"
            y2="${tick.y}"
            class="chart-grid-line"
          />
          <text
            x="${padding.left - 10}"
            y="${tick.y + 4}"
            text-anchor="end"
            class="chart-axis-label"
          >
            ${formatAxisPrice(tick.value)}
          </text>
        </g>
      `,
    )
    .join('');

  const pointsMarkup = points
    .map((point) => {
      const isCurrent = point.record.startsAt.getTime() === currentRecord.startsAt.getTime();

      return `
        <g>
          <circle
            cx="${point.x}"
            cy="${point.y}"
            r="${isCurrent ? 6 : 4}"
            class="${isCurrent ? 'chart-point is-current-point' : 'chart-point'}"
          />
          ${
            isCurrent
              ? `
                <text x="${point.x}" y="${point.y - 14}" text-anchor="middle" class="chart-value-label">
                  ${formatPrice(point.record.priceDkkPerKwh)}
                </text>
              `
              : ''
          }
        </g>
      `;
    })
    .join('');

  return `
    <div class="chart-metrics">
      <span>Højeste: ${formatPrice(maxPrice)}</span>
      <span>Aktuel: ${formatPrice(currentRecord.priceDkkPerKwh)}</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" class="price-chart" role="img" aria-label="Graf over dagens elpriser fra venstre mod højre">
      ${yAxisMarkup}
      <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" class="chart-axis" />
      <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" class="chart-axis" />
      <polygon points="${areaPoints}" class="chart-area" />
      <polyline points="${polylinePoints}" class="chart-line" />
      ${pointsMarkup}
    </svg>
    <div class="chart-labels">${labels}</div>
  `;
}

function formatHour(date) {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatAxisPrice(price) {
  return price.toFixed(2).replace('.', ',');
}

function addDays(date, days) {
  const clone = new Date(date);
  clone.setDate(clone.getDate() + days);
  return clone;
}
