import './style.css';

const DATASET_URL = '/api/prices';
const AREAS = ['DK1', 'DK2'];
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const VAT_MULTIPLIER = 1.25;
const COPENHAGEN_TIME_ZONE = 'Europe/Copenhagen';
const REFRESH_HOUR = 14;
const REFRESH_MINUTE = 5;
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
        <h1>
          Elpriser i Danmark
          <span class="title-inline-note">Vest og Øst</span>
        </h1>
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
          <p class="meta top-status" id="status-text">Henter elpriser...</p>
        </div>
      </div>
    </section>

    <section class="summary-grid">
      <article class="card summary-card">
        <div class="summary-meta">
          <p class="label" id="current-label">Pris nu</p>
          <p class="hint" id="current-window">-</p>
        </div>
        <p class="value" id="current-price">-</p>
      </article>
      <article class="card summary-card">
        <div class="summary-meta">
          <p class="label" id="next-label">Næste</p>
          <p class="hint" id="next-window">-</p>
        </div>
        <p class="value" id="next-price">-</p>
      </article>
      <article class="card summary-card">
        <div class="summary-meta">
          <p class="label" id="average-label">Snit i dag</p>
          <p class="hint" id="average-window">Inkl. moms</p>
        </div>
        <p class="value" id="average-price">-</p>
      </article>
    </section>

    <section class="card table-card">
      <div class="table-header">
        <h2 id="table-heading">Dagens prisoversigt</h2>
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
  displayedDay: null,
  apiNextFetchAt: null,
  nextAutoRefreshAt: null,
  autoRefreshTimerId: null,
};

const elements = {
  refreshButton: document.querySelector('#refresh-button'),
  statusText: document.querySelector('#status-text'),
  currentPrice: document.querySelector('#current-price'),
  currentLabel: document.querySelector('#current-label'),
  currentWindow: document.querySelector('#current-window'),
  nextPrice: document.querySelector('#next-price'),
  nextLabel: document.querySelector('#next-label'),
  nextWindow: document.querySelector('#next-window'),
  averagePrice: document.querySelector('#average-price'),
  averageLabel: document.querySelector('#average-label'),
  averageWindow: document.querySelector('#average-window'),
  pricesChart: document.querySelector('#prices-chart'),
  tableHeading: document.querySelector('#table-heading'),
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

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && shouldRefreshNow()) {
    void loadPrices();
  }
});

void loadPrices();

async function loadPrices() {
  setLoadingState(true);

  try {
    const { records, displayedDay, apiNextFetchAt } = await fetchDayAheadPrices();
    const grouped = groupByArea(records);

    for (const area of AREAS) {
      if (!grouped.has(area) || grouped.get(area).length === 0) {
        throw new Error(`Ingen prisdata modtaget for ${area}.`);
      }
    }

    state.dataByArea = grouped;
    state.displayedDay = displayedDay;
    state.apiNextFetchAt = apiNextFetchAt;
    scheduleAutoRefresh(displayedDay);
    render();
    elements.statusText.textContent = getStatusText({
      displayedDay,
      updatedAt: new Date(),
    });
  } catch (error) {
    console.error(error);
    scheduleRetryRefresh();
    renderError(error instanceof Error ? error.message : 'Ukendt fejl ved hentning af elpriser.');
  } finally {
    setLoadingState(false);
  }
}

async function fetchDayAheadPrices() {
  const preferredRange = getPreferredDateRange(new Date());
  let payload = await requestDayAheadPrices(preferredRange);

  if ((!payload.records || payload.records.length === 0) && preferredRange.dayOffset === 1) {
    payload = await requestDayAheadPrices(getPreferredDateRange(new Date(), 0));
  }

  if (!payload.records || !Array.isArray(payload.records)) {
    throw new Error('API-svaret havde ikke det forventede format.');
  }

  if (payload.records.length === 0) {
    throw new Error('Der er endnu ikke offentliggjort elpriser for den valgte dag.');
  }

  const quarterHourRecords = payload.records.map((record) => ({
    area: record.PriceArea,
    startsAt: new Date(`${record.TimeUTC}Z`),
    localStartsAt: record.TimeDK,
    priceDkkPerMwh: record.DayAheadPriceDKK * VAT_MULTIPLIER,
    priceDkkPerKwh: (record.DayAheadPriceDKK * VAT_MULTIPLIER) / 1000,
  }));

  return {
    records: aggregateToHourly(quarterHourRecords),
    displayedDay: getRecordDateKey(quarterHourRecords[0].startsAt),
    apiNextFetchAt: payload.apiNextFetchAt,
  };
}

async function requestDayAheadPrices(range) {
  const params = new URLSearchParams({
    start: range.start,
    end: range.end,
    sort: 'TimeDK ASC',
    limit: '500',
    filter: JSON.stringify({ PriceArea: AREAS }),
  });

  let response;

  try {
    response = await fetch(`${DATASET_URL}?${params.toString()}`);
  } catch {
    throw new Error('Netvaerksfejl ved hentning af elpriser. Tjek forbindelsen og proev igen.');
  }

  if (!response.ok) {
    throw new Error(`API-kald fejlede med status ${response.status}.`);
  }

  const payload = await response.json();

  return {
    ...payload,
    apiNextFetchAt: response.headers.get('X-API-Next-Fetch-At'),
  };
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
  const isCurrentDay = state.displayedDay === getRecordDateKey(now);
  const primaryIndex = isCurrentDay && currentIndex >= 0 ? currentIndex : 0;
  const currentRecord = selectedRecords[primaryIndex] ?? selectedRecords[0];
  const nextRecord = selectedRecords[primaryIndex + 1];
  const averagePrice =
    selectedRecords.reduce((sum, record) => sum + record.priceDkkPerKwh, 0) /
    selectedRecords.length;
  const dayCopy = getDisplayedDayCopy(state.displayedDay);

  elements.currentLabel.textContent = isCurrentDay ? 'Pris nu' : 'Første';
  elements.nextLabel.textContent = isCurrentDay ? 'Næste' : 'Andet';
  elements.averageLabel.textContent = dayCopy.averageLabel;
  elements.tableHeading.textContent = `${dayCopy.heading} prisoversigt`;
  elements.currentPrice.textContent = formatPrice(currentRecord.priceDkkPerKwh);
  elements.currentWindow.textContent = formatWindow(currentRecord.startsAt);
  elements.nextPrice.textContent = nextRecord ? formatPrice(nextRecord.priceDkkPerKwh) : 'Ingen data';
  elements.nextWindow.textContent = nextRecord ? formatWindow(nextRecord.startsAt) : 'Ingen senere intervaller';
  elements.averagePrice.textContent = formatPrice(averagePrice);
  elements.pricesChart.innerHTML = renderChart(selectedRecords, currentRecord, isCurrentDay);
}

function renderError(message) {
  const nextCheckText = getNextRefreshText('Nyt automatisk tjek');
  elements.statusText.textContent = nextCheckText ? `${message}. ${nextCheckText}` : message;
  elements.currentLabel.textContent = 'Pris nu';
  elements.nextLabel.textContent = 'Næste';
  elements.averageLabel.textContent = 'Snit i dag';
  elements.tableHeading.textContent = 'Dagens prisoversigt';
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

function renderChart(records, currentRecord, isCurrentDay) {
  const viewportWidth = window.innerWidth || 1024;
  const viewportHeight = window.innerHeight || 800;
  const isWideShortTablet = viewportWidth >= 1200 && viewportHeight <= 820;
  const width = 960;
  const height = isWideShortTablet ? 220 : viewportWidth <= 560 ? 240 : viewportWidth <= 900 ? 260 : 280;
  const padding =
    isWideShortTablet
      ? { top: 18, right: 20, bottom: 24, left: 62 }
      : viewportWidth <= 560
      ? { top: 24, right: 16, bottom: 26, left: 56 }
      : viewportWidth <= 900
        ? { top: 24, right: 20, bottom: 30, left: 64 }
      : { top: 24, right: 24, bottom: 32, left: 72 };
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
      (point) => {
        return `
        <div class="chart-label" style="left:${(point.x / width) * 100}%">
          ${formatHour(point.record.startsAt)}
        </div>
      `;
      },
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
      <span>${isCurrentDay ? 'Aktuel' : 'Første'}: ${formatPrice(currentRecord.priceDkkPerKwh)}</span>
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

function scheduleAutoRefresh(displayedDay) {
  const now = new Date();
  const todayKey = getRecordDateKey(now);
  const tomorrowKey = getRecordDateKey(addDays(now, 1));

  if (displayedDay === tomorrowKey) {
    setNextAutoRefreshAt(getNextReleaseDate(now));
    return;
  }

  if (displayedDay === todayKey && !isPastRefreshThreshold(getCopenhagenParts(now))) {
    setNextAutoRefreshAt(getNextReleaseDate(now));
    return;
  }

  setNextAutoRefreshAt(new Date(now.getTime() + AUTO_REFRESH_INTERVAL_MS));
}

function scheduleRetryRefresh() {
  setNextAutoRefreshAt(new Date(Date.now() + AUTO_REFRESH_INTERVAL_MS));
}

function setNextAutoRefreshAt(nextRefreshAt) {
  state.nextAutoRefreshAt = nextRefreshAt;

  if (state.autoRefreshTimerId) {
    window.clearTimeout(state.autoRefreshTimerId);
  }

  const delayMs = Math.max(0, nextRefreshAt.getTime() - Date.now());
  state.autoRefreshTimerId = window.setTimeout(() => {
    state.autoRefreshTimerId = null;

    if (document.hidden) {
      return;
    }

    void loadPrices();
  }, delayMs);
}

function shouldRefreshNow() {
  return !state.nextAutoRefreshAt || Date.now() >= state.nextAutoRefreshAt.getTime();
}

function getPreferredDateRange(date, forcedDayOffset = null) {
  const dayOffset = forcedDayOffset ?? (isPastRefreshThreshold(getCopenhagenParts(date)) ? 1 : 0);
  const startDate = addDays(date, dayOffset);
  const endDate = addDays(startDate, 1);

  return {
    dayOffset,
    start: formatApiDate(startDate),
    end: formatApiDate(endDate),
  };
}

function isPastRefreshThreshold(parts) {
  return parts.hour > REFRESH_HOUR || (parts.hour === REFRESH_HOUR && parts.minute >= REFRESH_MINUTE);
}

function getCopenhagenParts(date) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: COPENHAGEN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function getRecordDateKey(date) {
  const parts = getCopenhagenParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDisplayedDaySummary(dayKey) {
  const copy = getDisplayedDayCopy(dayKey);
  return copy.summary === 'i dag' || copy.summary === 'i morgen'
    ? capitalizeFirstLetter(copy.summary)
    : copy.summary;
}

function getStatusText({ displayedDay, updatedAt }) {
  const parts = [
    getDisplayedDaySummary(displayedDay),
    `Opd. ${formatCompactTimestamp(updatedAt)}`,
  ];
  const nextCheckText = getApiNextFetchText();

  if (nextCheckText) {
    parts.push(nextCheckText);
  }

  return parts.join(' | ');
}

function getDisplayedDayCopy(dayKey) {
  if (!dayKey) {
    return {
      heading: 'Dagens',
      averageLabel: 'Snit i dag',
      summary: 'i dag',
    };
  }

  const todayKey = getRecordDateKey(new Date());
  const tomorrowKey = getRecordDateKey(addDays(new Date(), 1));

  if (dayKey === todayKey) {
    return {
      heading: 'Dagens',
      averageLabel: 'Snit i dag',
      summary: 'i dag',
    };
  }

  if (dayKey === tomorrowKey) {
    return {
      heading: 'Morgendagens',
      averageLabel: 'Snit i morgen',
      summary: 'i morgen',
    };
  }

  return {
    heading: 'Valgte dags',
    averageLabel: 'Snit',
    summary: formatDayLabel(dayKey),
  };
}

function formatDayLabel(dayKey) {
  const [year, month, day] = dayKey.split('-');
  return `${day}/${month}/${year}`;
}

function getNextRefreshText(prefix) {
  if (!state.nextAutoRefreshAt) {
    return '';
  }

  return `${prefix} ${formatCompactTimestamp(state.nextAutoRefreshAt)}`;
}

function getApiNextFetchText() {
  if (!state.apiNextFetchAt) {
    return getNextRefreshText('Naeste');
  }

  return `API nyt ${formatCompactTimestamp(new Date(state.apiNextFetchAt))}`;
}

function formatCompactTimestamp(date) {
  const sameDay = getRecordDateKey(date) === getRecordDateKey(new Date());

  if (sameDay) {
    return new Intl.DateTimeFormat('da-DK', {
      timeZone: COPENHAGEN_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  return new Intl.DateTimeFormat('da-DK', {
    timeZone: COPENHAGEN_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date).replace(',', '');
}

function capitalizeFirstLetter(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getNextReleaseDate(date) {
  const parts = getCopenhagenParts(date);
  const nextReleaseLocalDay = isPastRefreshThreshold(parts) ? addDays(date, 1) : date;
  const releaseParts = getCopenhagenParts(nextReleaseLocalDay);
  const releaseUtcGuess = new Date(Date.UTC(
    Number(releaseParts.year),
    Number(releaseParts.month) - 1,
    Number(releaseParts.day),
    REFRESH_HOUR,
    REFRESH_MINUTE,
    0,
    0,
  ));
  const correctedOffsetMinutes = getTimeZoneOffsetMinutes(releaseUtcGuess, COPENHAGEN_TIME_ZONE);

  return new Date(releaseUtcGuess.getTime() - correctedOffsetMinutes * 60 * 1000);
}

function getTimeZoneOffsetMinutes(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return (asUtc - date.getTime()) / 60000;
}
