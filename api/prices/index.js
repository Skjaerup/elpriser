const API_BASE_URL = 'https://api.energidataservice.dk/dataset/DayAheadPrices';
const DEFAULT_FILTER = JSON.stringify({ PriceArea: ['DK1', 'DK2'] });
const CACHE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
};
const COPENHAGEN_TIME_ZONE = 'Europe/Copenhagen';
const REFRESH_HOUR = 14;
const REFRESH_MINUTE = 5;

let cachedResponse = null;

module.exports = async function prices(context, req) {
  const upstreamUrl = buildUpstreamUrl(req);
  const cacheWindow = getCacheWindowKey(new Date());

  if (cachedResponse && cachedResponse.upstreamUrl === upstreamUrl && cachedResponse.cacheWindow === cacheWindow) {
    context.res = {
      status: 200,
      headers: {
        ...CACHE_HEADERS,
        'X-Cache': 'HIT',
      },
      body: cachedResponse.body,
    };
    return;
  }

  try {
    const response = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      context.res = {
        status: response.status,
        headers: CACHE_HEADERS,
        body: JSON.stringify({
          error: `Upstream API failed with status ${response.status}.`,
        }),
      };
      return;
    }

    const body = await response.text();

    cachedResponse = {
      upstreamUrl,
      cacheWindow,
      body,
      fetchedAt: new Date().toISOString(),
    };

    context.res = {
      status: 200,
      headers: {
        ...CACHE_HEADERS,
        'X-Cache': 'MISS',
      },
      body,
    };
  } catch (error) {
    context.log.error('Failed to fetch day-ahead prices', error);

    if (cachedResponse && cachedResponse.upstreamUrl === upstreamUrl) {
      context.res = {
        status: 200,
        headers: {
          ...CACHE_HEADERS,
          'X-Cache': 'STALE',
        },
        body: cachedResponse.body,
      };
      return;
    }

    context.res = {
      status: 502,
      headers: CACHE_HEADERS,
      body: JSON.stringify({
        error: 'Kunne ikke hente elpriser fra upstream API.',
      }),
    };
  }
};

function buildUpstreamUrl(req) {
  const query = new URLSearchParams(req.query || {});

  if (!query.has('start') || !query.has('end')) {
    const requestedRange = getPreferredDateRange(new Date());

    query.set('start', requestedRange.start);
    query.set('end', requestedRange.end);
  }

  if (!query.has('sort')) {
    query.set('sort', 'TimeDK ASC');
  }

  if (!query.has('limit')) {
    query.set('limit', '500');
  }

  if (!query.has('filter')) {
    query.set('filter', DEFAULT_FILTER);
  }

  return `${API_BASE_URL}?${query.toString()}`;
}

function getCacheWindowKey(date) {
  const parts = getCopenhagenParts(date);
  const bucket = isPastRefreshThreshold(parts) ? 'after-release' : 'before-release';

  return `${parts.year}-${parts.month}-${parts.day}-${bucket}`;
}

function getPreferredDateRange(date) {
  const dayOffset = isPastRefreshThreshold(getCopenhagenParts(date)) ? 1 : 0;
  const startDate = addDays(date, dayOffset);
  const endDate = addDays(startDate, 1);

  return {
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

function formatApiDate(date) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: COPENHAGEN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function addDays(date, days) {
  const clone = new Date(date);
  clone.setDate(clone.getDate() + days);
  return clone;
}