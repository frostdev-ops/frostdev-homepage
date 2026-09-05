import { getSetting } from './settings.ts';
import { cached } from './cache.ts';

// Open-Meteo: keyless, no account. Forecast is decoration — any failure
// returns null and the ward says "unavailable".

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

export interface Forecast {
  current: { tempF: number; condition: string; code: number; windMph: number; humidity: number };
  daily: { date: string; hiF: number; loF: number; condition: string; code: number; precipPct: number }[];
  hourly: { t: string; tempF: number; code: number; precipPct: number }[];
}

function coords(): { lat: number; lon: number } {
  const lat = Number(getSetting('weather_lat') ?? process.env.WEATHER_LAT ?? '40.93');
  const lon = Number(getSetting('weather_lon') ?? process.env.WEATHER_LON ?? '-74.13');
  return { lat, lon };
}

/** Successes cache 30 min; failures reject inside cached() (nothing stored) and
 *  surface as null, so the next request retries instead of caching the outage. */
export function getForecast(): Promise<Forecast | null> {
  return cached('weather', 30 * 60_000, async (): Promise<Forecast> => {
    {
      const { lat, lon } = coords();
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
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
    }
  }).catch(() => null);
}
