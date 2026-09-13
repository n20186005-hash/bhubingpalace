/**
 * Server-side weather + advisory layer for the Bhubing Palace visitor guide.
 *
 * Everything here runs on the server (Cloudflare Worker). The browser never
 * talks to a third party: the rendered outlook is delivered as part of the
 * page markup and refreshed on a schedule by the worker itself.
 *
 * Caching layers, cheapest first:
 *   1. in-isolate memo       -> survives for the lifetime of a warm worker
 *   2. Cloudflare edge cache -> shared by every visitor of a colo
 *   3. upstream request      -> only when 1 and 2 both miss
 */

/** Palace grounds, Doi Suthep, Chiang Mai. */
const LATITUDE = 18.8053;
const LONGITUDE = 98.8986;
/** Chiang Mai city centre, used for the "how much cooler is the summit" delta. */
const CITY_LATITUDE = 18.7883;
const CITY_LONGITUDE = 98.9853;
const TIMEZONE = 'Asia/Bangkok';

const FORECAST_UPSTREAM = 'https://api.open-meteo.com/v1/forecast';
const AIR_UPSTREAM = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const CACHE_KEY = 'https://cache.bhubingpalace.com/v2/weather';

/** Served straight from the memo without touching the network. */
const MEMO_TTL_MS = 15 * 60 * 1000;
/** How long the edge keeps a snapshot before asking upstream again. */
const EDGE_TTL_SECONDS = 30 * 60;
/** Report a week of outlook; the palace and the city sit in one valley. */
const FORECAST_DAYS = 7;

export type ConditionKey =
  | 'clear'
  | 'mostlyClear'
  | 'partlyCloudy'
  | 'overcast'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'freezingRain'
  | 'snow'
  | 'showers'
  | 'snowShowers'
  | 'thunderstorm'
  | 'unknown';

export const CONDITION_ICON: Record<ConditionKey, string> = {
  clear: '☀️',
  mostlyClear: '🌤️',
  partlyCloudy: '⛅',
  overcast: '☁️',
  fog: '🌫️',
  drizzle: '🌦️',
  rain: '🌧️',
  freezingRain: '🌨️',
  snow: '❄️',
  showers: '🌦️',
  snowShowers: '🌨️',
  thunderstorm: '⛈️',
  unknown: '🌥️',
};

export interface CurrentConditions {
  temperature: number;
  apparent: number;
  humidity: number;
  windSpeed: number;
  windGusts: number;
  visibility: number;
  precipitation: number;
  isDay: boolean;
  condition: ConditionKey;
  observedAt: string;
}

export interface DailyOutlook {
  date: string;
  condition: ConditionKey;
  tempMax: number;
  tempMin: number;
  apparentMax: number;
  apparentMin: number;
  humidityMean: number;
  precipProbability: number;
  precipitation: number;
  uvMax: number;
  windMax: number;
  windGustsMax: number;
  visibilityMin: number;
  thunderHours: number;
  sunrise: string;
  sunset: string;
  /** Valley mist / cloud-sea opportunity, estimated from humidity, wind and rain. */
  mistLikely: boolean;
}

export interface AirQuality {
  pm25: number;
  pm10: number;
  usAqi: number;
}

export interface WeatherSnapshot {
  fetchedAt: string;
  timezone: string;
  elevation: number;
  /** Difference in degrees between the summit and the city right now. */
  cityDelta: number | null;
  current: CurrentConditions | null;
  air: AirQuality | null;
  daily: DailyOutlook[];
}

export type AdvisoryLevel = 'info' | 'notice' | 'warning';

/**
 * A single triggered suggestion. `id` maps to a localised template under
 * `weather.rules` in the i18n catalogues; `params` fills its placeholders.
 */
export interface Advisory {
  id: string;
  level: AdvisoryLevel;
  params?: Record<string, string | number>;
}

export interface WeatherAdvice {
  /** Safety-first block; empty when nothing notable is expected. */
  alerts: Advisory[];
  outfit: Advisory[];
  plan: Advisory[];
  pack: Advisory[];
}

/** WMO weather interpretation codes condensed into presentational buckets. */
export function conditionFromCode(code: number | null | undefined): ConditionKey {
  if (code === null || code === undefined || Number.isNaN(code)) return 'unknown';
  if (code === 0) return 'clear';
  if (code === 1) return 'mostlyClear';
  if (code === 2) return 'partlyCloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code === 65 || code === 82) return 'rain';
  if (code >= 61 && code <= 64) return 'rain';
  if (code === 66 || code === 67) return 'freezingRain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code === 80 || code === 81) return 'showers';
  if (code === 85 || code === 86) return 'snowShowers';
  if (code >= 95) return 'thunderstorm';
  return 'unknown';
}

/** Beaufort-style band from a wind speed in m/s. */
export function windScale(ms: number): number {
  const thresholds = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  let level = 0;
  for (const t of thresholds) {
    if (ms >= t) level += 1;
  }
  return level;
}

/* ------------------------------------------------------------------ fetch */

let memo: { at: number; data: WeatherSnapshot } | null = null;

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : fallback;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function pick(series: Record<string, unknown[]> | undefined, key: string, index: number): unknown {
  return series?.[key]?.[index];
}

async function readEdgeCache(): Promise<WeatherSnapshot | null> {
  try {
    const store = (globalThis as { caches?: CacheStorage }).caches;
    if (!store || typeof store.default?.match !== 'function') return null;
    const hit = await store.default.match(new Request(CACHE_KEY));
    if (!hit) return null;
    return (await hit.json()) as WeatherSnapshot;
  } catch {
    return null;
  }
}

async function writeEdgeCache(snapshot: WeatherSnapshot): Promise<void> {
  try {
    const store = (globalThis as { caches?: CacheStorage }).caches;
    if (!store || typeof store.default?.put !== 'function') return;
    await store.default.put(
      new Request(CACHE_KEY),
      new Response(JSON.stringify(snapshot), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${EDGE_TTL_SECONDS}`,
        },
      }),
    );
  } catch {
    /* caching is best-effort only */
  }
}

function buildForecastUrl(): string {
  const params = new URLSearchParams({
    latitude: `${LATITUDE},${CITY_LATITUDE}`,
    longitude: `${LONGITUDE},${CITY_LONGITUDE}`,
    current: [
      'temperature_2m',
      'relative_humidity_2m',
      'apparent_temperature',
      'is_day',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'wind_gusts_10m',
    ].join(','),
    hourly: [
      'temperature_2m',
      'relative_humidity_2m',
      'apparent_temperature',
      'precipitation_probability',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'wind_gusts_10m',
      'visibility',
      'cloud_cover',
    ].join(','),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'apparent_temperature_max',
      'apparent_temperature_min',
      'sunrise',
      'sunset',
      'uv_index_max',
      'precipitation_sum',
      'precipitation_probability_max',
    ].join(','),
    wind_speed_unit: 'ms',
    timezone: TIMEZONE,
    forecast_days: String(FORECAST_DAYS),
  });
  return `${FORECAST_UPSTREAM}?${params.toString()}`;
}

function buildAirUrl(): string {
  const params = new URLSearchParams({
    latitude: String(LATITUDE),
    longitude: String(LONGITUDE),
    current: 'pm2_5,pm10,us_aqi',
    timezone: TIMEZONE,
  });
  return `${AIR_UPSTREAM}?${params.toString()}`;
}

interface UpstreamLocation {
  timezone?: string;
  elevation?: number;
  current?: Record<string, unknown>;
  hourly?: Record<string, unknown[]>;
  daily?: Record<string, unknown[]>;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function aggregateDaily(payload: UpstreamLocation): DailyOutlook[] {
  const daily = payload.daily ?? {};
  const hourly = payload.hourly ?? {};
  const dates = (daily.time ?? []) as string[];
  const hours = (hourly.time ?? []) as string[];

  return dates.map((date, index) => {
    const inDay = hours
      .map((stamp, h) => ({ stamp, h }))
      .filter((entry) => entry.stamp.startsWith(date))
      .map((entry) => entry.h);

    const humidity = inDay.map((h) => num(pick(hourly, 'relative_humidity_2m', h)));
    const wind = inDay.map((h) => num(pick(hourly, 'wind_speed_10m', h)));
    const visibility = inDay
      .map((h) => num(pick(hourly, 'visibility', h), 20000))
      .filter((v) => v > 0);
    const codes = inDay.map((h) => Number(pick(hourly, 'weather_code', h)));
    const cloud = inDay.map((h) => num(pick(hourly, 'cloud_cover', h)));

    const humidityMean = Math.round(mean(humidity));
    const windMax = Math.max(0, ...wind);
    const precipProbability = num(pick(daily, 'precipitation_probability_max', index));
    const precipitation = num(pick(daily, 'precipitation_sum', index));
    const visibilityMin = visibility.length > 0 ? Math.min(...visibility) : 20000;
    const thunderHours = codes.filter((c) => c >= 95).length;

    // Overnight humidity that stays high while the wind drops and the sky is
    // partly clear is the classic recipe for a valley cloud sea below the ridge.
    const mistLikely =
      humidityMean >= 85 &&
      windMax <= 11 &&
      precipProbability <= 50 &&
      mean(cloud) <= 70 &&
      visibilityMin < 12000;

    return {
      date,
      condition: conditionFromCode(Number(pick(daily, 'weather_code', index))),
      tempMax: num(pick(daily, 'temperature_2m_max', index)),
      tempMin: num(pick(daily, 'temperature_2m_min', index)),
      apparentMax: num(pick(daily, 'apparent_temperature_max', index)),
      apparentMin: num(pick(daily, 'apparent_temperature_min', index)),
      humidityMean,
      precipProbability,
      precipitation,
      uvMax: num(pick(daily, 'uv_index_max', index)),
      windMax,
      windGustsMax: Math.max(0, ...inDay.map((h) => num(pick(hourly, 'wind_gusts_10m', h)))),
      visibilityMin,
      thunderHours,
      sunrise: text(pick(daily, 'sunrise', index)),
      sunset: text(pick(daily, 'sunset', index)),
      mistLikely,
    };
  });
}

function parseForecast(payload: UpstreamLocation | UpstreamLocation[]): WeatherSnapshot {
  const [summit, city] = Array.isArray(payload) ? payload : [payload, undefined];

  const current = summit?.current;
  const hourly = summit?.hourly ?? {};
  const hours = (hourly.time ?? []) as string[];
  const nowStamp = text(current?.time);
  const nowIndex = Math.max(0, hours.findIndex((stamp) => stamp >= nowStamp));

  return {
    fetchedAt: new Date().toISOString(),
    timezone: text(summit?.timezone, TIMEZONE),
    elevation: num(summit?.elevation),
    cityDelta:
      current && city?.current
        ? Math.round((num(current.temperature_2m) - num(city.current.temperature_2m)) * 10) / 10
        : null,
    current: current
      ? {
          temperature: num(current.temperature_2m),
          apparent: num(current.apparent_temperature),
          humidity: num(current.relative_humidity_2m),
          windSpeed: num(current.wind_speed_10m),
          windGusts: num(current.wind_gusts_10m),
          visibility: num(pick(hourly, 'visibility', nowIndex), 20000),
          precipitation: num(current.precipitation),
          isDay: Number(current.is_day) === 1,
          condition: conditionFromCode(Number(current.weather_code)),
          observedAt: nowStamp,
        }
      : null,
    air: null,
    daily: summit ? aggregateDaily(summit) : [],
  };
}

async function fetchForecast(): Promise<WeatherSnapshot | null> {
  try {
    const response = await fetch(buildForecastUrl(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return null;
    return parseForecast((await response.json()) as UpstreamLocation | UpstreamLocation[]);
  } catch {
    return null;
  }
}

async function fetchAir(snapshot: WeatherSnapshot): Promise<WeatherSnapshot> {
  try {
    const response = await fetch(buildAirUrl(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return snapshot;
    const payload = (await response.json()) as { current?: Record<string, unknown> };
    const current = payload.current;
    if (!current) return snapshot;
    return {
      ...snapshot,
      air: {
        pm25: num(current.pm2_5),
        pm10: num(current.pm10),
        usAqi: num(current.us_aqi),
      },
    };
  } catch {
    return snapshot;
  }
}

function isFresh(snapshot: WeatherSnapshot, ttlMs: number): boolean {
  const stamped = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(stamped) && Date.now() - stamped < ttlMs;
}

/**
 * Resolve the current outlook. Never throws: on total failure the caller
 * receives `null` and renders its own static fallback copy.
 */
export async function getWeather(): Promise<WeatherSnapshot | null> {
  if (memo && isFresh(memo.data, MEMO_TTL_MS)) return memo.data;

  const cached = await readEdgeCache();
  if (cached && isFresh(cached, EDGE_TTL_SECONDS * 1000)) {
    memo = { at: Date.now(), data: cached };
    return cached;
  }

  const forecast = await fetchForecast();
  if (forecast) {
    const snapshot = await fetchAir(forecast);
    memo = { at: Date.now(), data: snapshot };
    await writeEdgeCache(snapshot);
    return snapshot;
  }

  // Upstream is unreachable: a slightly stale reading beats no reading.
  return cached ?? memo?.data ?? null;
}

/* --------------------------------------------------------------- advisories */

function add(list: Advisory[], id: string, level: AdvisoryLevel, params?: Record<string, string | number>) {
  list.push(params ? { id, level, params } : { id, level });
}

/**
 * Turn a snapshot into concrete, actionable guidance. Rules are intentionally
 * few and mutually exclusive inside a group, so the copy never contradicts
 * itself and never shows a suggestion the day does not actually need.
 */
export function buildAdvice(snapshot: WeatherSnapshot | null): WeatherAdvice {
  const advice: WeatherAdvice = { alerts: [], outfit: [], plan: [], pack: [] };
  const today = snapshot?.daily?.[0];

  if (!snapshot || !today) {
    add(advice.plan, 'planGood', 'info');
    add(advice.outfit, 'outfitCool', 'info', { d: 6 });
    return advice;
  }

  const { current, air } = snapshot;
  const rain = today.precipitation;
  const probability = today.precipProbability;
  const gust = today.windGustsMax;
  const wind = today.windMax;
  const range = Math.round((today.tempMax - today.tempMin) * 10) / 10;
  const weekRain = snapshot.daily.reduce((sum, d) => sum + d.precipitation, 0);
  const thunder = today.thunderHours > 0 || today.condition === 'thunderstorm';
  const wet = rain >= 0.2 || thunder;

  /* -- risk notices, highest priority ---------------------------------- */
  if (thunder) add(advice.alerts, 'alertThunder', 'warning');
  if (rain >= 50) add(advice.alerts, 'alertFlood', 'warning', { mm: Math.round(rain) });
  else if (rain >= 10) add(advice.alerts, 'alertRainHeavy', 'warning', { mm: Math.round(rain) });
  if (gust >= 13.9) add(advice.alerts, 'alertWindStrong', 'warning', { level: windScale(gust) });
  if (today.visibilityMin < 600 || today.condition === 'fog')
    add(advice.alerts, 'alertFog', 'notice', { m: Math.round(today.visibilityMin) });
  if (today.tempMax >= 35) add(advice.alerts, 'alertHeat', 'notice', { t: today.tempMax });
  if (today.tempMax <= 10) add(advice.alerts, 'alertCold', 'notice', { t: today.tempMax });
  if (today.uvMax >= 8) add(advice.alerts, 'alertUv', 'notice', { uv: today.uvMax });
  if (air && air.pm25 >= 75)
    add(advice.alerts, 'alertSmoke', 'warning', { pm: Math.round(air.pm25) });
  if (weekRain < 1 && today.humidityMean < 55 && today.precipProbability < 20)
    add(advice.alerts, 'alertFireRisk', 'notice');

  /* -- what to wear ---------------------------------------------------- */
  if (today.tempMax <= 10) add(advice.outfit, 'outfitCold', 'notice');
  else if (today.tempMax >= 32) add(advice.outfit, 'outfitHot', 'notice', { t: today.tempMax });
  else if (wet) add(advice.outfit, 'outfitRainShell', 'notice');
  else if (range >= 8) add(advice.outfit, 'outfitLayers', 'notice', { d: Math.round(range) });
  else add(advice.outfit, 'outfitCool', 'info', { d: snapshot.cityDelta ? Math.abs(snapshot.cityDelta) : 6 });

  if (wind >= 8 && today.tempMax > 10) add(advice.outfit, 'outfitWindy', 'notice', { level: windScale(wind) });

  /* -- how to spend the day ------------------------------------------- */
  if (thunder) add(advice.plan, 'planThunder', 'warning');
  else if (rain >= 10) add(advice.plan, 'planHeavyRain', 'warning');
  else if (probability >= 60) add(advice.plan, 'planRainLikely', 'notice', { p: probability });
  else if (wet) add(advice.plan, 'planLightRain', 'notice');

  if (today.tempMax >= 32 && !thunder) add(advice.plan, 'planAvoidNoon', 'notice', { t: today.tempMax });
  if (!wet && today.condition === 'clear') add(advice.plan, 'planSunny', 'info');
  else if (!wet && (today.condition === 'overcast' || today.condition === 'partlyCloudy'))
    add(advice.plan, 'planOvercast', 'info');
  if (wet || today.visibilityMin < 2000) add(advice.plan, 'planMountainRoad', 'notice');
  if (gust >= 13.9) add(advice.plan, 'planWindy', 'notice', { level: windScale(gust) });
  if (today.mistLikely) add(advice.plan, 'planCloudSea', 'info');

  /* -- what to bring --------------------------------------------------- */
  if (probability >= 60) add(advice.pack, 'packUmbrella', 'info', { p: probability });
  if (rain >= 10) add(advice.pack, 'packRaincoat', 'notice');
  else if (wet) add(advice.pack, 'packGrip', 'info');
  if (today.uvMax >= 5) add(advice.pack, 'packSun', 'info', { uv: today.uvMax });
  if (today.tempMax >= 32) add(advice.pack, 'packWater', 'info', { t: today.tempMax });
  if (today.tempMax <= 10) add(advice.pack, 'packWarm', 'notice');
  else if (range >= 8) add(advice.pack, 'packLayer', 'info', { d: Math.round(range) });
  else add(advice.pack, 'packLayer', 'info', { d: 6 });
  if ((air && air.pm25 >= 55) || today.visibilityMin < 1000)
    add(advice.pack, 'packMask', 'notice');
  const month = Number(today.date.slice(5, 7));
  if (month >= 5 && month <= 10) add(advice.pack, 'packRepellent', 'info');

  return advice;
}

/** Every advisory present in a snapshot, for structured-data emission. */
export function flattenAdvice(advice: WeatherAdvice): Advisory[] {
  return [...advice.alerts, ...advice.outfit, ...advice.plan, ...advice.pack];
}

/** Compact "HH:MM" view of an ISO timestamp coming from upstream. */
export function clockTime(iso: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[1]}:${match[2]}` : '--:--';
}

/** Weekday index (0=Sunday) of an upstream "YYYY-MM-DD" date string. */
export function weekdayIndex(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? new Date(parsed).getUTCDay() : 0;
}

/** Fill `{name}` placeholders inside a localised template. */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!template) return '';
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}
