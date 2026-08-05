import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ALADHAN_BASE = 'https://api.aladhan.com/v1';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const PROFILE_FILE = path.join(__dirname, 'data', 'profiles.json');
const PRAYER_NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const MAX_FEED_DAYS = 180;
const CACHE_TTL_MS = 60 * 60 * 1000;
const useNetlifyBlobs = process.env.USE_NETLIFY_BLOBS === 'true';

const cache = new Map();
let profiles = new Map();
let profileWriteQueue = Promise.resolve();
let netlifyProfileStore;

async function getNetlifyProfileStore() {
  if (!netlifyProfileStore) {
    const { getStore } = await import('@netlify/blobs');
    netlifyProfileStore = getStore('salah-sync-profiles');
  }
  return netlifyProfileStore;
}

const methodNames = new Map([
  [1, 'University of Islamic Sciences, Karachi'],
  [2, 'Islamic Society of North America (ISNA)'],
  [3, 'Muslim World League'],
  [4, 'Umm Al-Qura University, Makkah'],
  [5, 'Egyptian General Authority of Survey'],
  [7, 'Institute of Geophysics, University of Tehran'],
  [8, 'Gulf Region'],
  [9, 'Kuwait'],
  [10, 'Qatar'],
  [11, 'Majlis Ugama Islam Singapura, Singapore'],
  [12, 'Union Organization islamic de France'],
  [13, 'Diyanet İşleri Başkanlığı, Turkey'],
  [14, 'Spiritual Administration of Muslims of Russia'],
  [15, 'Moonsighting Committee Worldwide'],
  [16, 'Dubai'],
  [17, 'JAKIM, Malaysia'],
  [18, 'Tunisia'],
  [19, 'Algeria'],
  [20, 'Kementerian Agama Republik Indonesia'],
  [21, 'Morocco'],
  [22, 'Portugal'],
  [23, 'Jordan']
]);

function loadProfiles() {
  if (useNetlifyBlobs) return;
  try {
    const raw = fs.readFileSync(PROFILE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      profiles = new Map(Object.entries(parsed));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not load profiles:', error.message);
  }
}

function persistProfiles() {
  if (useNetlifyBlobs) return Promise.resolve();
  const serializable = Object.fromEntries(profiles.entries());
  profileWriteQueue = profileWriteQueue
    .then(async () => {
      await fsPromises.mkdir(path.dirname(PROFILE_FILE), { recursive: true });
      await fsPromises.writeFile(PROFILE_FILE, JSON.stringify(serializable, null, 2));
    })
    .catch((error) => console.warn('Could not save profiles:', error.message));
  return profileWriteQueue;
}

loadProfiles();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Supports both Netlify's rewritten /api/* path and a direct
  // /.netlify/functions/api/* invocation during local testing.
  const functionPrefix = '/.netlify/functions/api';
  if (req.url === functionPrefix || req.url.startsWith(`${functionPrefix}/`)) {
    req.url = `/api${req.url.slice(functionPrefix.length) || ''}`;
  }
  next();
});

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateToIso(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(isoDate, amount) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return dateToIso(date);
}

function dateToAladhan(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}-${month}-${year}`;
}

function getDateInTimeZone(timeZone, instant = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function monthKey(isoDate) {
  return isoDate.slice(0, 7).split('-').map(Number);
}

function cleanTime(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s*\(.+?\)$/, '').trim().slice(0, 5);
}

function cleanTimings(timings = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(timings)) cleaned[key] = cleanTime(value);
  return cleaned;
}

function safeLabel(value, fallback = 'Prayer times') {
  const label = String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
  return label || fallback;
}

function numberInRange(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function integerInSet(value, allowed, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && allowed.includes(number) ? number : fallback;
}

const defaultSettings = {
  label: 'Srinagar, India',
  latitude: 34.0837,
  longitude: 74.7973,
  timeZone: 'Asia/Kolkata',
  method: 1,
  school: 1,
  highLats: 3,
  adjustment: 0,
  duration: 30
};

function normalizeSettings(input = {}, base = defaultSettings) {
  const source = { ...base, ...(input || {}) };
  const timeZone = String(source.timeZone || '').trim();
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid IANA time zone: ${timeZone || 'missing'}`);
  }
  const latitude = numberInRange(source.latitude, -90, 90, NaN);
  const longitude = numberInRange(source.longitude, -180, 180, NaN);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('A valid latitude and longitude are required.');
  }
  return {
    label: safeLabel(source.label, 'Selected location'),
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6)),
    timeZone,
    method: integerInSet(source.method, [...methodNames.keys()], defaultSettings.method),
    school: integerInSet(source.school, [0, 1], defaultSettings.school),
    highLats: integerInSet(source.highLats, [1, 2, 3], defaultSettings.highLats),
    adjustment: Math.round(numberInRange(source.adjustment, -2, 2, defaultSettings.adjustment)),
    duration: Math.round(numberInRange(source.duration, 5, 120, defaultSettings.duration))
  };
}

function profileIdIsValid(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{12,80}$/.test(id);
}

async function getProfile(id) {
  if (!profileIdIsValid(id)) return null;
  let raw;
  if (useNetlifyBlobs) {
    const store = await getNetlifyProfileStore();
    raw = await store.get(id, { type: 'json' });
  } else {
    raw = profiles.get(id);
  }
  if (!raw) return null;
  try {
    return normalizeSettings(raw);
  } catch {
    return null;
  }
}

async function saveProfile(id, settings) {
  if (useNetlifyBlobs) {
    const store = await getNetlifyProfileStore();
    await store.setJSON(id, settings);
    return;
  }
  profiles.set(id, settings);
  await persistProfiles();
}

function settingsFromQuery(query) {
  return normalizeSettings({
    label: query.label,
    latitude: query.latitude ?? query.lat,
    longitude: query.longitude ?? query.lon ?? query.lng,
    timeZone: query.timeZone ?? query.timezone ?? query.tz,
    method: query.method,
    school: query.school,
    highLats: query.highLats ?? query.highlats,
    adjustment: query.adjustment,
    duration: query.duration
  });
}

async function settingsFromRequest(req) {
  if (req.query.profile) {
    const profile = await getProfile(req.query.profile);
    if (!profile) throw new Error('That sync profile no longer exists. Save your settings again.');
    return profile;
  }
  return settingsFromQuery(req.query);
}

function commonAladhanParams(settings) {
  const params = new URLSearchParams({
    latitude: String(settings.latitude),
    longitude: String(settings.longitude),
    method: String(settings.method),
    school: String(settings.school),
    latitudeAdjustmentMethod: String(settings.highLats),
    adjustment: String(settings.adjustment),
    midnightMode: '0'
  });
  if (settings.timeZone) params.set('timezonestring', settings.timeZone);
  return params;
}

async function fetchExternalJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'SalahSync/1.0 (timezone-aware prayer calendar)',
      ...headers
    },
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Upstream returned an unexpected response (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(data?.message || `Upstream request failed (${response.status}).`);
  }
  return data;
}

async function cached(key, ttl, loader) {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value;
  const value = await loader();
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

async function fetchDay(settings, isoDate, force = false) {
  const cacheKey = `day:${JSON.stringify(settings)}:${isoDate}`;
  if (force) cache.delete(cacheKey);
  return cached(cacheKey, 15 * 60 * 1000, async () => {
    const params = commonAladhanParams(settings);
    const url = `${ALADHAN_BASE}/timings/${dateToAladhan(isoDate)}?${params}`;
    const response = await fetchExternalJson(url);
    if (response.code !== 200 || !response.data) throw new Error(response.status || 'Prayer time service returned no data.');
    return {
      date: isoDate,
      readable: response.data.date?.readable || isoDate,
      timings: cleanTimings(response.data.timings),
      hijri: response.data.date?.hijri || null,
      meta: response.data.meta || null
    };
  });
}

async function fetchMonth(settings, year, month, force = false) {
  const cacheKey = `month:${JSON.stringify(settings)}:${year}-${pad(month)}`;
  if (force) cache.delete(cacheKey);
  return cached(cacheKey, CACHE_TTL_MS, async () => {
    const params = commonAladhanParams(settings);
    params.set('month', String(month));
    params.set('year', String(year));
    const url = `${ALADHAN_BASE}/calendar?${params}`;
    const response = await fetchExternalJson(url);
    if (response.code !== 200 || !Array.isArray(response.data)) throw new Error(response.status || 'Prayer calendar service returned no data.');
    return response.data.map((item) => {
      const [day, itemMonth, itemYear] = String(item.date?.gregorian?.date || '').split('-');
      const iso = itemYear && itemMonth && day ? `${itemYear}-${itemMonth}-${day}` : null;
      return {
        date: iso,
        readable: item.date?.readable || iso,
        timings: cleanTimings(item.timings),
        hijri: item.date?.hijri || null,
        meta: item.meta || null
      };
    }).filter((item) => item.date);
  });
}

async function fetchRange(settings, start, days, force = false) {
  const safeDays = Math.max(1, Math.min(Number(days) || 7, MAX_FEED_DAYS));
  const dates = Array.from({ length: safeDays }, (_, index) => addDays(start, index));
  const groups = new Map();
  for (const date of dates) {
    const [year, month] = monthKey(date);
    const key = `${year}-${month}`;
    if (!groups.has(key)) groups.set(key, { year, month });
  }
  const months = await Promise.all([...groups.values()].map(({ year, month }) => fetchMonth(settings, year, month, force)));
  const index = new Map(months.flat().map((item) => [item.date, item]));
  const missing = dates.filter((date) => !index.has(date));
  if (missing.length) {
    const fallback = await Promise.all(missing.map((date) => fetchDay(settings, date, force)));
    for (const item of fallback) index.set(item.date, item);
  }
  return dates.map((date) => index.get(date)).filter(Boolean);
}

function getOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const zone = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  if (zone === 'GMT' || zone === 'UTC') return 0;
  const match = zone.match(/(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return match[1] === '-' ? -minutes : minutes;
}

function wallTimeToUtc(isoDate, hhmm, timeZone) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const [hour, minute] = String(hhmm).split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute || 0, 0);
  let offset = getOffsetMinutes(new Date(naive), timeZone);
  let utc = naive - offset * 60 * 1000;
  for (let index = 0; index < 2; index += 1) {
    offset = getOffsetMinutes(new Date(utc), timeZone);
    utc = naive - offset * 60 * 1000;
  }
  return new Date(utc);
}

function formatUtcForIcs(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\n');
}

function slugify(value) {
  return String(value || 'prayer-times').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'prayer-times';
}

function buildIcs(items, settings, feedKey) {
  const now = formatUtcForIcs(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Salah Sync//Prayer Times//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(`Salah Sync · ${settings.label}`)}`,
    `X-WR-TIMEZONE:${settings.timeZone}`,
    'X-PUBLISHED-TTL:PT6H'
  ];
  for (const item of items) {
    for (const prayer of PRAYER_NAMES) {
      const time = item.timings?.[prayer];
      if (!/^\d{1,2}:\d{2}$/.test(time || '')) continue;
      const start = wallTimeToUtc(item.date, time, settings.timeZone);
      const end = new Date(start.getTime() + settings.duration * 60 * 1000);
      const uidSeed = `${feedKey}:${item.date}:${prayer}`;
      const uid = `${crypto.createHash('sha1').update(uidSeed).digest('hex')}@salah-sync.local`;
      const methodLabel = methodNames.get(settings.method) || 'Selected method';
      lines.push(
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${now}`,
        `DTSTART:${formatUtcForIcs(start)}`,
        `DTEND:${formatUtcForIcs(end)}`,
        `SUMMARY:${icsEscape(`${prayer} · ${settings.label}`)}`,
        `LOCATION:${icsEscape(settings.label)}`,
        `DESCRIPTION:${icsEscape(`Prayer time calculated for ${settings.label}.\nTime zone: ${settings.timeZone}.\nMethod: ${methodLabel}.\nThis event is maintained by the Salah Sync live feed.`)}`,
        'CATEGORIES:PRAYER',
        'END:VEVENT'
      );
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

function jsonError(res, error, status = 400) {
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'salah-sync', now: new Date().toISOString() });
});

app.get('/api/profile/:id', async (req, res) => {
  try {
    const settings = await getProfile(req.params.id);
    if (!settings) return jsonError(res, new Error('Profile not found.'), 404);
    res.json({ id: req.params.id, settings, feedPath: `/api/feed/${req.params.id}.ics` });
  } catch (error) {
    jsonError(res, error, 500);
  }
});

app.put('/api/profile/:id', async (req, res) => {
  if (!profileIdIsValid(req.params.id)) return jsonError(res, new Error('Invalid sync profile id.'), 400);
  try {
    const settings = normalizeSettings(req.body || {});
    await saveProfile(req.params.id, settings);
    res.json({ id: req.params.id, settings, feedPath: `/api/feed/${req.params.id}.ics` });
  } catch (error) {
    jsonError(res, error, 400);
  }
});

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json({ results: [] });
  try {
    const url = new URL(`${NOMINATIM_BASE}/search`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '8');
    url.searchParams.set('q', query);
    url.searchParams.set('accept-language', 'en');
    const data = await cached(`search:${query.toLowerCase()}`, 10 * 60 * 1000, () => fetchExternalJson(url.toString(), { 'Accept-Language': 'en' }));
    const results = Array.isArray(data) ? data.map((item) => ({
      label: item.display_name,
      latitude: Number(item.lat),
      longitude: Number(item.lon),
      type: item.type,
      address: item.address || {}
    })).filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) : [];
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ results });
  } catch (error) {
    jsonError(res, error, 502);
  }
});

app.get('/api/reverse', async (req, res) => {
  const latitude = numberInRange(req.query.latitude ?? req.query.lat, -90, 90, NaN);
  const longitude = numberInRange(req.query.longitude ?? req.query.lon ?? req.query.lng, -180, 180, NaN);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return jsonError(res, new Error('Valid coordinates are required.'));
  try {
    const url = new URL(`${NOMINATIM_BASE}/reverse`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(latitude));
    url.searchParams.set('lon', String(longitude));
    url.searchParams.set('zoom', '10');
    url.searchParams.set('accept-language', 'en');
    const data = await fetchExternalJson(url.toString(), { 'Accept-Language': 'en' });
    res.json({ label: data.display_name || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, address: data.address || {} });
  } catch (error) {
    jsonError(res, error, 502);
  }
});

app.get('/api/resolve', async (req, res) => {
  const latitude = numberInRange(req.query.latitude ?? req.query.lat, -90, 90, NaN);
  const longitude = numberInRange(req.query.longitude ?? req.query.lon ?? req.query.lng, -180, 180, NaN);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return jsonError(res, new Error('Valid coordinates are required.'));
  try {
    const params = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), method: '1', school: '0' });
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetchExternalJson(`${ALADHAN_BASE}/timings/${timestamp}?${params}`);
    const timeZone = response.data?.meta?.timezone;
    if (!timeZone || !isValidTimeZone(timeZone)) throw new Error('The prayer service could not determine a time zone for that location.');
    res.json({ timeZone, meta: response.data.meta });
  } catch (error) {
    jsonError(res, error, 502);
  }
});

app.get('/api/prayer', async (req, res) => {
  try {
    const settings = await settingsFromRequest(req);
    const date = isIsoDate(req.query.date) ? req.query.date : getDateInTimeZone(settings.timeZone);
    const data = await fetchDay(settings, date, Boolean(req.query.refresh));
    res.set('Cache-Control', 'public, max-age=900');
    res.json({ settings, data, fetchedAt: new Date().toISOString() });
  } catch (error) {
    jsonError(res, error, 502);
  }
});

app.get('/api/forecast', async (req, res) => {
  try {
    const settings = await settingsFromRequest(req);
    const start = isIsoDate(req.query.start) ? req.query.start : getDateInTimeZone(settings.timeZone);
    const days = Math.max(1, Math.min(Number(req.query.days) || 7, 31));
    const data = await fetchRange(settings, start, days, Boolean(req.query.refresh));
    res.set('Cache-Control', 'public, max-age=1800');
    res.json({ settings, start, days, data, fetchedAt: new Date().toISOString() });
  } catch (error) {
    jsonError(res, error, 502);
  }
});

async function serveFeed(settings, feedKey, req, res) {
  const start = isIsoDate(req.query.start) ? req.query.start : getDateInTimeZone(settings.timeZone);
  const days = Math.max(1, Math.min(Number(req.query.days) || MAX_FEED_DAYS, MAX_FEED_DAYS));
  const data = await fetchRange(settings, start, days);
  const ics = buildIcs(data, settings, feedKey);
  res.status(200);
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  const disposition = req.query.download === '0' ? 'inline' : 'attachment';
  res.set('Content-Disposition', `${disposition}; filename="salah-sync-${slugify(settings.label)}.ics"`);
  res.send(ics);
}

app.get('/api/feed/:id.ics', async (req, res) => {
  try {
    const settings = await getProfile(req.params.id);
    if (!settings) return res.status(404).type('text').send('This sync profile was not found. Save the settings again in Salah Sync.');
    await serveFeed(settings, req.params.id, req, res);
  } catch (error) {
    jsonError(res, error, 502);
  }
});

// A query-string feed is useful for sharing a one-off calendar without creating a profile.
app.get('/api/feed.ics', async (req, res) => {
  try {
    const settings = settingsFromQuery(req.query);
    await serveFeed(settings, `${settings.latitude}:${settings.longitude}:${settings.timeZone}`, req, res);
  } catch (error) {
    jsonError(res, error, 502);
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (!res.headersSent) res.status(500).json({ error: 'Unexpected server error.' });
});

export default app;

const runningAsNetlifyFunction = process.env.NETLIFY_FUNCTIONS === 'true'
  || process.env.NETLIFY === 'true'
  || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

if (!runningAsNetlifyFunction) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Salah Sync running on http://0.0.0.0:${PORT}`);
    console.log(`${useNetlifyBlobs ? 'Profiles stored in Netlify Blobs' : `Profiles stored in ${PROFILE_FILE}`}`);
  });
}
