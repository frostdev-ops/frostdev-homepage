import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { wmoLabel, getForecast } from '../src/lib/weather.ts';

// No built-in town any more: the forecast needs a location before it fetches.
process.env.WEATHER_LAT = '40.93';
process.env.WEATHER_LON = '-74.13';

test('wmoLabel: known codes', () => {
  assert.equal(wmoLabel(0), 'Clear');
  assert.equal(wmoLabel(2), 'Partly cloudy');
  assert.equal(wmoLabel(61), 'Light rain');
  assert.equal(wmoLabel(95), 'Thunderstorm');
});

test('wmoLabel: unknown code falls back', () => {
  assert.equal(wmoLabel(42), 'Weather');
  assert.equal(wmoLabel(-1), 'Weather');
});

// getForecast caches successes module-wide under one key, so the failure test
// must run before the success test (failures cache nothing).

const realFetch = globalThis.fetch;

test('getForecast: failing fetch yields null (and caches nothing)', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  assert.equal(await getForecast(), null);

  globalThis.fetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
  assert.equal(await getForecast(), null);
});

test('getForecast: maps Open-Meteo JSON to the Forecast contract', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const canned = {
    current: { temperature_2m: 70.1, weather_code: 2, wind_speed_10m: 5.5, relative_humidity_2m: 40 },
    daily: {
      time: ['2026-08-30', '2026-08-31'],
      temperature_2m_max: [80, 82],
      temperature_2m_min: [60, 61],
      weather_code: [0, 61],
      precipitation_probability_max: [null, 20],
    },
    hourly: {
      time: ['2026-08-30T00:00', '2026-08-30T01:00'],
      temperature_2m: [65, 64],
      weather_code: [3, 0],
      precipitation_probability: [null, 10],
    },
  };
  let requestedUrl = '';
  globalThis.fetch = (async (url: string) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => canned };
  }) as unknown as typeof fetch;

  const fc = await getForecast();
  assert.ok(fc);
  assert.match(requestedUrl, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=/);
  assert.deepEqual(fc.current, { tempF: 70.1, condition: 'Partly cloudy', code: 2, windMph: 5.5, humidity: 40 });
  assert.equal(fc.daily.length, 2);
  assert.deepEqual(fc.daily[0], { date: '2026-08-30', hiF: 80, loF: 60, condition: 'Clear', code: 0, precipPct: 0 });
  assert.equal(fc.daily[1]!.precipPct, 20);
  assert.equal(fc.daily[1]!.condition, 'Light rain');
  assert.deepEqual(fc.hourly[0], { t: '2026-08-30T00:00', tempF: 65, code: 3, precipPct: 0 });
  assert.equal(fc.hourly[1]!.precipPct, 10);
});
