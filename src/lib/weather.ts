import { getSetting } from './settings.ts';
import { cached } from './cache.ts';
import { getDashboard } from './dashboard.ts';

// Open-Meteo: keyless, no account. Forecast is decoration — any failure
// returns null and the ward says "unavailable". The place is the weather
// ward's own config (lib/wards.ts validateConfig 'weather'); everything that
// asks without naming a ward (a chart, a leyline condition, the agent) gets
// the first weather ward on the board that has one.

const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ hail',
};

export function wmoLabel(code: number): string {
  return WMO[code] ?? 'Weather';
}

export interface Location {
  lat: number;
  lon: number;
  name?: string;
}

export interface Forecast {
  current: { tempF: number; condition: string; code: number; windMph: number; humidity: number };
  daily: { date: string; hiF: number; loF: number; condition: string; code: number; precipPct: number }[];
  hourly: { t: string; tempF: number; code: number; precipPct: number }[];
}

/** The instance-wide fallback older installs set (WEATHER_LAT/LON in .env, or
 *  the weather_lat/lon settings): what a weather ward without a place of its
 *  own still uses. An empty value is unset, not 0°,0°. */
export function coords(): Location | null {
  const read = (setting: string, env: string): number => {
    const raw = (getSetting(setting) ?? process.env[env] ?? '').trim();
    return raw ? Number(raw) : NaN;
  };
  const lat = read('weather_lat', 'WEATHER_LAT');
  const lon = read('weather_lon', 'WEATHER_LON');
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

const placeOf = (w: { config?: Record<string, unknown> }): Location | null => {
  const c = w.config ?? {};
  if (typeof c.lat !== 'number' || typeof c.lon !== 'number') return null;
  return { lat: c.lat, lon: c.lon, ...(typeof c.name === 'string' && c.name ? { name: c.name } : {}) };
};

/** Where to look: the named ward's own place, else the fallback; with no ward
 *  named, the first weather ward on the board that has a place, else the fallback. */
export function wardLocation(userId: number, ward?: string): Location | null {
  const wards = getDashboard(userId).filter((w) => w.type === 'weather');
  const own = ward ? wards.find((w) => w.i === ward) : undefined;
  if (own) return placeOf(own) ?? coords();
  return wards.map(placeOf).find((p) => p !== null) ?? coords();
}

export function forecastFor(userId: number, ward?: string): Promise<Forecast | null> {
  const at = wardLocation(userId, ward);
  return at ? getForecast(at) : Promise.resolve(null);
}

/** Successes cache 30 min per place; failures reject inside cached() (nothing
 *  stored) and surface as null, so the next request retries instead of caching
 *  the outage. */
export function getForecast(at: { lat: number; lon: number }): Promise<Forecast | null> {
  return cached(`weather:${at.lat.toFixed(2)},${at.lon.toFixed(2)}`, 30 * 60_000, async (): Promise<Forecast> => {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${at.lat}&longitude=${at.lon}` +
      '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m' +
      '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
      '&hourly=temperature_2m,weather_code,precipitation_probability' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7&forecast_hours=24';
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const data = (await res.json()) as {
      current: { temperature_2m: number; weather_code: number; wind_speed_10m: number; relative_humidity_2m: number };
      daily: {
        time: string[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        weather_code: number[];
        precipitation_probability_max: (number | null)[];
      };
      hourly: { time: string[]; temperature_2m: number[]; weather_code: number[]; precipitation_probability: (number | null)[] };
    };
    return {
      current: {
        tempF: data.current.temperature_2m,
        code: data.current.weather_code,
        condition: wmoLabel(data.current.weather_code),
        windMph: data.current.wind_speed_10m,
        humidity: data.current.relative_humidity_2m,
      },
      daily: data.daily.time.map((date, i) => ({
        date,
        hiF: data.daily.temperature_2m_max[i]!,
        loF: data.daily.temperature_2m_min[i]!,
        code: data.daily.weather_code[i]!,
        condition: wmoLabel(data.daily.weather_code[i]!),
        precipPct: data.daily.precipitation_probability_max[i] ?? 0,
      })),
      hourly: data.hourly.time.map((t, i) => ({
        t,
        tempF: data.hourly.temperature_2m[i]!,
        code: data.hourly.weather_code[i]!,
        precipPct: data.hourly.precipitation_probability[i] ?? 0,
      })),
    } satisfies Forecast;
  }).catch(() => null);
}

export interface Place {
  name: string;
  region: string;
  lat: number;
  lon: number;
}

/** Open-Meteo's geocoder, for the ward's Configure dialog. Null = unavailable. */
export function geocode(q: string): Promise<Place[] | null> {
  const query = q.trim().slice(0, 80);
  if (query.length < 2) return Promise.resolve([]);
  return cached(`geocode:${query.toLowerCase()}`, 60 * 60_000, async (): Promise<Place[]> => {
    const p = new URLSearchParams({ name: query, count: '6', language: 'en', format: 'json' });
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${p}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`geocoding ${res.status}`);
    const data = (await res.json()) as {
      results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[];
    };
    return (data.results ?? []).map((r) => ({
      name: r.name,
      region: [r.admin1, r.country].filter(Boolean).join(', '),
      lat: r.latitude,
      lon: r.longitude,
    }));
  }).catch(() => null);
}
