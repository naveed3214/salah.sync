(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const prayerOrder = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
  const calendarPrayerOrder = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
  const prayerIcons = { Fajr: '◒', Sunrise: '☼', Dhuhr: '◉', Asr: '◌', Maghrib: '◒', Isha: '☽' };
  const commonTimeZones = [
    'Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Karachi', 'Asia/Dhaka',
    'Asia/Jakarta', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Tokyo',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Istanbul',
    'Africa/Cairo', 'Africa/Casablanca', 'Africa/Johannesburg',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Toronto', 'America/Vancouver', 'Australia/Sydney', 'Pacific/Auckland', 'UTC'
  ];

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

  const state = {
    profileId: null,
    settings: { ...defaultSettings },
    location: { ...defaultSettings },
    currentDate: null,
    followToday: true,
    day: null,
    forecast: [],
    clock12: readStorage('salah-clock') !== '24',
    loading: false,
    searchTimer: null,
    toastTimer: null,
    requestToken: 0
  };

  function readStorage(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private browsing can block storage */ }
  }

  function makeProfileId() {
    try {
      return crypto.randomUUID().replace(/-/g, '');
    } catch {
      return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    }
  }

  function getProfileId() {
    const stored = readStorage('salah-profile-id');
    if (stored && /^[a-zA-Z0-9_-]{12,80}$/.test(stored)) return stored;
    const id = makeProfileId();
    writeStorage('salah-profile-id', id);
    return id;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  }

  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '');
  }

  function pad(value, size = 2) { return String(value).padStart(size, '0'); }

  function dateInTimeZone(timeZone, instant = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function addDays(isoDate, amount) {
    const date = new Date(`${isoDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function getOffsetMinutes(date, timeZone) {
    try {
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
    } catch {
      return 0;
    }
  }

  // Convert a clock reading in an IANA zone into an instant. This keeps countdowns
  // correct even when the device running the browser is in another time zone.
  function wallTimeToDate(isoDate, hhmm, timeZone) {
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

  function formatTime(isoDate, time) {
    if (!/^\d{1,2}:\d{2}$/.test(time || '')) return '—';
    const date = wallTimeToDate(isoDate, time, state.settings.timeZone);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: state.settings.timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: state.clock12
    }).format(date);
  }

  function formatShortDate(isoDate) {
    const date = new Date(`${isoDate}T12:00:00Z`);
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(date);
  }

  function formatLongDate(instant = new Date()) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: state.settings.timeZone,
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    }).format(instant);
  }

  function formatZoneOffset(timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date());
      return parts.find((part) => part.type === 'timeZoneName')?.value?.replace('GMT', 'UTC') || timeZone;
    } catch { return timeZone; }
  }

  function getLocationTitle(label) {
    const value = String(label || 'Selected location').split(',')[0].trim();
    return value.length > 28 ? `${value.slice(0, 27)}…` : value;
  }

  function apiUrl(path, params = {}) {
    const url = new URL(path, window.location.origin);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    });
    return url.toString();
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    let body = null;
    try { body = await response.json(); } catch { /* handled below */ }
    if (!response.ok) {
      const error = new Error(body?.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function showToast(message, type = 'success') {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show${type === 'error' ? ' error' : ''}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.className = 'toast'; }, 4300);
  }

  function setFormStatus(message, type = '') {
    const node = $('#formStatus');
    node.textContent = message || '';
    node.className = `form-status${type ? ` ${type}` : ''}`;
  }

  function populateTimeZones() {
    const datalist = $('#timezoneOptions');
    if (!datalist) return;
    let zones = commonTimeZones;
    try {
      zones = [...new Set([...commonTimeZones, ...Intl.supportedValuesOf('timeZone')])].sort();
    } catch { /* older browsers still get the curated list */ }
    datalist.innerHTML = zones.map((zone) => `<option value="${escapeHtml(zone)}"></option>`).join('');
  }

  function applySettingsToForm() {
    const settings = state.settings;
    $('#locationInput').value = settings.label;
    $('#locationCoordinates').textContent = `${Math.abs(settings.latitude).toFixed(4)}° ${settings.latitude >= 0 ? 'N' : 'S'} · ${Math.abs(settings.longitude).toFixed(4)}° ${settings.longitude >= 0 ? 'E' : 'W'}`;
    $('#methodSelect').value = String(settings.method);
    $('#schoolSelect').value = String(settings.school);
    $('#timezoneInput').value = settings.timeZone;
    $('#highLatsSelect').value = String(settings.highLats);
    $('#hijriAdjustment').value = String(settings.adjustment);
    $('#durationInput').value = String(settings.duration);
    $('#timezoneHint').textContent = `${formatZoneOffset(settings.timeZone)} · The selected zone controls every clock and calendar event.`;
    $('#heroTimezone').textContent = settings.timeZone;
    $('#forecastZone').textContent = settings.timeZone;
    $('#nextPrayerZone').textContent = settings.timeZone;
    $('#boardLocation').textContent = getLocationTitle(settings.label);
    $('#hijriLocation').textContent = `Local to ${getLocationTitle(settings.label)}`;
    $('#topbarDate').textContent = formatLongDate();
    state.location = { ...settings };
  }

  function validateTimeZone(timeZone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format();
      return true;
    } catch { return false; }
  }

  function readFormSettings() {
    const timeZone = $('#timezoneInput').value.trim();
    if (!validateTimeZone(timeZone)) throw new Error('Enter a valid IANA time zone, for example Asia/Kolkata or Europe/London.');
    if (!state.location || !Number.isFinite(Number(state.location.latitude)) || !Number.isFinite(Number(state.location.longitude))) {
      throw new Error('Choose a location from the search suggestions first.');
    }
    const duration = Number($('#durationInput').value);
    if (!Number.isFinite(duration) || duration < 5 || duration > 120) throw new Error('Calendar duration must be between 5 and 120 minutes.');
    return {
      label: $('#locationInput').value.trim() || state.location.label,
      latitude: Number(state.location.latitude),
      longitude: Number(state.location.longitude),
      timeZone,
      method: Number($('#methodSelect').value),
      school: Number($('#schoolSelect').value),
      highLats: Number($('#highLatsSelect').value),
      adjustment: Number($('#hijriAdjustment').value),
      duration: Math.round(duration)
    };
  }

  function getFeedUrl(download = false) {
    if (!state.profileId) return '';
    const url = new URL(`/api/feed/${encodeURIComponent(state.profileId)}.ics`, window.location.origin);
    url.searchParams.set('days', '180');
    url.searchParams.set('download', download ? '1' : '0');
    return url.toString();
  }

  function updateFeedUi() {
    const displayUrl = getFeedUrl(false);
    const downloadUrl = getFeedUrl(true);
    $('#feedUrl').textContent = displayUrl || 'Creating your stable feed…';
    $('#downloadButton').href = downloadUrl || '#';
    $('#downloadButton').setAttribute('download', `salah-sync-${getLocationTitle(state.settings.label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ics`);
  }

  async function ensureProfile() {
    state.profileId = getProfileId();
    try {
      const result = await requestJson(`/api/profile/${encodeURIComponent(state.profileId)}`);
      state.settings = { ...defaultSettings, ...result.settings };
    } catch (error) {
      // A new browser gets a private profile id. Create it with the local default.
      if (error.status !== 404) throw error;
      const result = await requestJson(`/api/profile/${encodeURIComponent(state.profileId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(defaultSettings)
      });
      state.settings = { ...defaultSettings, ...result.settings };
    }
    state.currentDate = dateInTimeZone(state.settings.timeZone);
    state.followToday = true;
    applySettingsToForm();
    $('#datePicker').value = state.currentDate;
    updateFeedUi();
  }

  async function saveAndRefresh(event) {
    event?.preventDefault();
    if (state.loading) return;
    try {
      const nextSettings = readFormSettings();
      const zoneChanged = nextSettings.timeZone !== state.settings.timeZone;
      setFormStatus('Saving your feed settings…');
      $('#updateButton').disabled = true;
      const result = await requestJson(`/api/profile/${encodeURIComponent(state.profileId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nextSettings)
      });
      state.settings = { ...defaultSettings, ...result.settings };
      state.location = { ...state.settings };
      if (zoneChanged) state.currentDate = dateInTimeZone(state.settings.timeZone);
      state.followToday = true;
      applySettingsToForm();
      $('#datePicker').value = state.currentDate;
      updateFeedUi();
      setFormStatus('Saved · refreshing the prayer board', 'success');
      await loadData(false);
      showToast('Prayer times and the live feed are updated.');
    } catch (error) {
      setFormStatus(error.message || 'Could not save these settings.');
      showToast(error.message || 'Could not save these settings.', 'error');
    } finally {
      $('#updateButton').disabled = false;
    }
  }

  function hideSuggestions() {
    const node = $('#locationSuggestions');
    node.hidden = true;
    node.innerHTML = '';
  }

  function renderSuggestions(results) {
    const node = $('#locationSuggestions');
    if (!results.length) {
      node.innerHTML = '<div class="location-suggestion" style="color:#92a19e">No places found. Try a city and country.</div>';
      node.hidden = false;
      return;
    }
    node.innerHTML = results.map((result, index) => `<button type="button" class="location-suggestion" data-location-index="${index}" role="option">${escapeHtml(getLocationTitle(result.label))}<small>${escapeHtml(result.label)}</small></button>`).join('');
    node.hidden = false;
    node.querySelectorAll('[data-location-index]').forEach((button) => {
      button.addEventListener('click', () => selectLocation(results[Number(button.dataset.locationIndex)]));
    });
  }

  async function searchLocations() {
    const query = $('#locationInput').value.trim();
    if (query.length < 2) { hideSuggestions(); return; }
    try {
      const result = await requestJson(apiUrl('/api/search', { q: query }));
      renderSuggestions(result.results || []);
    } catch (error) {
      hideSuggestions();
      setFormStatus(`Location search: ${error.message}`);
    }
  }

  async function resolveLocationTimeZone(latitude, longitude) {
    const result = await requestJson(apiUrl('/api/resolve', { latitude, longitude }));
    return result.timeZone;
  }

  async function selectLocation(result, options = {}) {
    hideSuggestions();
    state.location = { ...result, label: result.label };
    $('#locationInput').value = result.label;
    $('#locationCoordinates').textContent = `${Math.abs(result.latitude).toFixed(4)}° ${result.latitude >= 0 ? 'N' : 'S'} · ${Math.abs(result.longitude).toFixed(4)}° ${result.longitude >= 0 ? 'E' : 'W'}`;
    setFormStatus('Location selected · checking its time zone…');
    try {
      const timeZone = options.timeZone || await resolveLocationTimeZone(result.latitude, result.longitude);
      $('#timezoneInput').value = timeZone;
      $('#timezoneHint').textContent = `${formatZoneOffset(timeZone)} · Auto-detected from this location. Press Auto any time to detect again.`;
      setFormStatus('Location selected · review settings, then update prayer times.', 'success');
    } catch (error) {
      setFormStatus(`Location selected, but time zone lookup failed: ${error.message}`);
    }
  }

  async function useMyLocation() {
    if (!navigator.geolocation) { showToast('Location access is not available in this browser.', 'error'); return; }
    const button = $('#useMyLocation');
    button.disabled = true;
    setFormStatus('Requesting your location…');
    navigator.geolocation.getCurrentPosition(async (position) => {
      const { latitude, longitude } = position.coords;
      try {
        const [reverse, timeZone] = await Promise.all([
          requestJson(apiUrl('/api/reverse', { latitude, longitude })),
          resolveLocationTimeZone(latitude, longitude)
        ]);
        await selectLocation({ label: reverse.label, latitude, longitude }, { timeZone });
        showToast('Your current location is ready to review.');
      } catch (error) {
        setFormStatus(error.message || 'Could not resolve your location.');
        showToast(error.message || 'Could not resolve your location.', 'error');
      } finally { button.disabled = false; }
    }, (error) => {
      button.disabled = false;
      const reason = error.code === 1 ? 'Location permission was denied.' : 'Your location could not be read.';
      setFormStatus(reason);
      showToast(reason, 'error');
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  }

  async function autoDetectTimeZone() {
    try {
      const timeZone = await resolveLocationTimeZone(state.location.latitude, state.location.longitude);
      $('#timezoneInput').value = timeZone;
      $('#timezoneHint').textContent = `${formatZoneOffset(timeZone)} · Auto-detected from this location. Press Update prayer times to apply it.`;
      setFormStatus('Time zone detected · press Update prayer times to apply it.', 'success');
    } catch (error) {
      setFormStatus(`Time zone lookup failed: ${error.message}`);
      showToast(error.message, 'error');
    }
  }

  function showLoading() {
    $('#prayerGrid').innerHTML = '<div class="loading-card shimmer"></div><div class="loading-card shimmer"></div><div class="loading-card shimmer"></div><div class="loading-card shimmer"></div><div class="loading-card shimmer"></div><div class="loading-card shimmer"></div>';
    $('#forecastBody').innerHTML = '<tr><td colspan="6"><div class="table-loading shimmer"></div></td></tr>';
    $('#nextPrayerName').textContent = 'Loading…';
    $('#nextPrayerTime').textContent = '—';
    $('#countdown').textContent = '—';
    $('#countdownSub').textContent = 'Fetching today’s times';
  }

  function showDataError(error) {
    const message = escapeHtml(error.message || 'The prayer time service is unavailable.');
    $('#prayerGrid').innerHTML = `<div class="data-error" style="grid-column:1/-1"><b>We could not load these prayer times.</b><span>${message}</span><button type="button" id="retryInline">Try again</button></div>`;
    $('#forecastBody').innerHTML = `<tr><td colspan="6" class="table-error">${message}</td></tr>`;
    $('#nextPrayerName').textContent = 'Unavailable';
    $('#nextPrayerTime').textContent = '—';
    $('#countdown').textContent = '—';
    $('#countdownSub').textContent = 'Tap refresh to try again';
    $('#retryInline')?.addEventListener('click', () => loadData(true));
  }

  async function loadData(force = false) {
    const token = ++state.requestToken;
    state.loading = true;
    $('#refreshButton').classList.add('spinning');
    if (!state.day) showLoading();
    const params = { profile: state.profileId, date: state.currentDate };
    if (force) params.refresh = Date.now();
    try {
      const [dayResponse, forecastResponse] = await Promise.all([
        requestJson(apiUrl('/api/prayer', params)),
        requestJson(apiUrl('/api/forecast', { profile: state.profileId, start: state.currentDate, days: 7, ...(force ? { refresh: Date.now() } : {}) }))
      ]);
      if (token !== state.requestToken) return;
      state.day = dayResponse.data;
      state.forecast = forecastResponse.data || [];
      renderBoard();
      $('#settingsSaved').textContent = 'Saved';
      setFormStatus('');
    } catch (error) {
      if (token === state.requestToken) {
        showDataError(error);
        setFormStatus(error.message || 'Prayer times could not be loaded.');
      }
    } finally {
      if (token === state.requestToken) {
        state.loading = false;
        $('#refreshButton').classList.remove('spinning');
      }
    }
  }

  function getPrayerInstant(name, time, date = state.currentDate) {
    return wallTimeToDate(date, time, state.settings.timeZone);
  }

  function getNextPrayer() {
    if (!state.day) return null;
    const now = new Date();
    const today = dateInTimeZone(state.settings.timeZone, now);
    if (state.currentDate !== today) {
      const first = calendarPrayerOrder.find((name) => /^\d{1,2}:\d{2}$/.test(state.day.timings?.[name] || ''));
      return first ? { name: first, time: state.day.timings[first], instant: getPrayerInstant(first, state.day.timings[first]), selectedDate: true } : null;
    }
    for (const name of calendarPrayerOrder) {
      const time = state.day.timings?.[name];
      if (!/^\d{1,2}:\d{2}$/.test(time || '')) continue;
      const instant = getPrayerInstant(name, time);
      if (instant.getTime() > now.getTime()) return { name, time, instant, selectedDate: false };
    }
    return null;
  }

  function relativeDuration(milliseconds) {
    const totalMinutes = Math.max(0, Math.round(milliseconds / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${pad(minutes)}m`;
    return `${minutes}m`;
  }

  function timeStatus(name, time) {
    if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return { label: 'Not available', state: 'past' };
    const today = dateInTimeZone(state.settings.timeZone);
    if (state.currentDate !== today) return { label: 'Scheduled', state: '' };
    const instant = getPrayerInstant(name, time);
    const difference = instant.getTime() - Date.now();
    if (difference > 0) return { label: `in ${relativeDuration(difference)}`, state: '' };
    return { label: 'Passed', state: 'past' };
  }

  function googleDateStamp(isoDate, time, durationMinutes = 30) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const [hour, minute] = String(time).split(':').map(Number);
    const start = new Date(Date.UTC(year, month - 1, day, hour, minute || 0, 0));
    const end = new Date(start.getTime() + durationMinutes * 60000);
    const stamp = (date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00`;
    return `${stamp(start)}/${stamp(end)}`;
  }

  function googleEventUrl(name, time) {
    const dates = googleDateStamp(state.currentDate, time, state.settings.duration);
    const url = new URL('https://calendar.google.com/calendar/render');
    url.searchParams.set('action', 'TEMPLATE');
    url.searchParams.set('text', `${name} · ${state.settings.label}`);
    url.searchParams.set('dates', dates);
    url.searchParams.set('ctz', state.settings.timeZone);
    url.searchParams.set('location', state.settings.label);
    url.searchParams.set('details', `Prayer time for ${state.settings.label}.\nTime zone: ${state.settings.timeZone}.\nSalah Sync live board.`);
    return url.toString();
  }

  function renderPrayerCards() {
    const next = getNextPrayer();
    const now = Date.now();
    const cards = prayerOrder.map((name) => {
      const time = state.day?.timings?.[name] || '';
      const status = timeStatus(name, time);
      const instant = /^\d{1,2}:\d{2}$/.test(time) ? getPrayerInstant(name, time) : null;
      const isNext = Boolean(next && next.name === name && !next.selectedDate);
      const isSunrise = name === 'Sunrise';
      const classes = ['prayer-card', isSunrise ? 'sunrise' : '', isNext ? 'next' : '', instant && instant.getTime() < now && state.currentDate === dateInTimeZone(state.settings.timeZone) ? 'past' : ''].filter(Boolean).join(' ');
      const addButton = isSunrise ? '<span></span>' : `<button class="prayer-add" type="button" data-add-prayer="${name}" title="Add ${name} to Google Calendar" aria-label="Add ${name} to Google Calendar"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 4.8h12A1.2 1.2 0 0 1 19.2 6v13.2H4.8V6A1.2 1.2 0 0 1 6 4.8Z" stroke="currentColor" stroke-width="1.6"/><path d="M8 3v3.5M16 3v3.5M4.8 9.1h14M12 12v5M9.5 14.5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>`;
      return `<article class="${classes}">
        <div class="prayer-top"><span class="prayer-icon" aria-hidden="true">${prayerIcons[name]}</span><span class="prayer-name">${name}</span>${addButton}</div>
        <div class="prayer-time">${formatTime(state.currentDate, time)}</div>
        <div class="prayer-meta"><span class="meta-dot"></span>${status.label}</div>
      </article>`;
    }).join('');
    $('#prayerGrid').innerHTML = cards;
    $$('#prayerGrid [data-add-prayer]').forEach((button) => {
      button.addEventListener('click', () => {
        const name = button.dataset.addPrayer;
        const time = state.day?.timings?.[name];
        if (!time) return;
        window.open(googleEventUrl(name, time), '_blank', 'noopener,noreferrer');
        showToast(`${name} is ready to add in Google Calendar.`);
      });
    });
  }

  function renderNext() {
    const next = getNextPrayer();
    if (!next) {
      $('#nextPrayerName').textContent = 'All prayers complete';
      $('#nextPrayerTime').textContent = '—';
      $('#countdown').textContent = 'Mā shā’ Allāh';
      $('#countdownSub').textContent = 'The next day will begin with Fajr';
      return;
    }
    $('#nextPrayerName').textContent = next.name;
    $('#nextPrayerTime').textContent = formatTime(state.currentDate, next.time);
    $('#nextPrayerZone').textContent = state.settings.timeZone;
    if (next.selectedDate) {
      $('#countdown').textContent = 'Selected day';
      $('#countdownSub').textContent = 'Use the arrows to return to today';
    } else {
      $('#countdown').textContent = relativeDuration(next.instant.getTime() - Date.now());
      $('#countdownSub').textContent = `at ${formatZoneOffset(state.settings.timeZone)} local time`;
    }
  }

  function renderHijri() {
    const hijri = state.day?.hijri;
    if (!hijri) { $('#hijriDate').textContent = 'Not available'; return; }
    const month = hijri.month?.en || hijri.month?.ar || '';
    $('#hijriDate').textContent = `${hijri.day} ${month} ${hijri.year} AH`;
    $('#hijriNote').textContent = `${hijri.weekday?.en ? `${hijri.weekday.en} · ` : ''}corresponding to ${formatShortDate(state.currentDate)}.`;
  }

  function renderForecast() {
    const rows = state.forecast.map((item) => {
      const todayClass = item.date === state.currentDate ? ' class="selected-day"' : '';
      const dateButton = `<button type="button" class="forecast-date" data-forecast-date="${item.date}">${escapeHtml(formatShortDate(item.date))}</button>`;
      return `<tr${todayClass}><td>${dateButton}</td>${calendarPrayerOrder.map((name) => `<td>${escapeHtml(formatTime(item.date, item.timings?.[name] || ''))}</td>`).join('')}</tr>`;
    }).join('');
    $('#forecastBody').innerHTML = rows || '<tr><td colspan="6" class="table-error">No forecast available.</td></tr>';
    $$('#forecastBody [data-forecast-date]').forEach((button) => button.addEventListener('click', () => {
      state.followToday = false;
      state.currentDate = button.dataset.forecastDate;
      $('#datePicker').value = state.currentDate;
      loadData(false);
    }));
  }

  function renderBoard() {
    const isToday = state.currentDate === dateInTimeZone(state.settings.timeZone);
    $('#boardDateLabel').textContent = isToday ? 'Today' : formatShortDate(state.currentDate);
    $('#boardLocation').textContent = getLocationTitle(state.settings.label);
    $('#datePicker').value = state.currentDate;
    $('#topbarDate').textContent = formatLongDate();
    renderPrayerCards();
    renderNext();
    renderForecast();
    renderHijri();
  }

  async function copyFeedUrl() {
    const url = getFeedUrl(false);
    try {
      await navigator.clipboard.writeText(url);
      $('#copyFeedButton').innerHTML = '✓ Copied';
      setTimeout(() => {
        $('#copyFeedButton').innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="10" height="11" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-8A1.5 1.5 0 0 0 5 5.5v10A1.5 1.5 0 0 0 6.5 17H8" stroke="currentColor" stroke-width="1.6"/></svg> Copy';
      }, 1700);
      showToast('Feed URL copied to your clipboard.');
    } catch {
      showToast('Select and copy the feed URL from the box.', 'error');
    }
  }

  function subscribeGoogleCalendar() {
    const url = getFeedUrl(false);
    if (!url) return;
    const googleUrl = `https://calendar.google.com/calendar/u/0/r/settings/addbyurl?url=${encodeURIComponent(url)}`;
    window.open(googleUrl, '_blank', 'noopener,noreferrer');
    showToast('Google Calendar is opening the subscription screen.');
  }

  function bindEvents() {
    $('#settingsForm').addEventListener('submit', saveAndRefresh);
    $('#locationInput').addEventListener('input', () => {
      state.location = { label: '', latitude: NaN, longitude: NaN };
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(searchLocations, 270);
    });
    $('#locationInput').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideSuggestions();
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.location-group')) hideSuggestions();
    });
    $('#useMyLocation').addEventListener('click', useMyLocation);
    $('#autoTimezone').addEventListener('click', autoDetectTimeZone);
    $$('.clock-option').forEach((button) => button.addEventListener('click', () => {
      state.clock12 = button.dataset.clock === '12';
      writeStorage('salah-clock', state.clock12 ? '12' : '24');
      $$('.clock-option').forEach((item) => item.classList.toggle('active', item === button));
      if (state.day) renderBoard();
    }));
    $('#previousDay').addEventListener('click', () => { state.followToday = false; state.currentDate = addDays(state.currentDate, -1); loadData(false); });
    $('#nextDay').addEventListener('click', () => { state.followToday = false; state.currentDate = addDays(state.currentDate, 1); loadData(false); });
    $('#datePicker').addEventListener('change', (event) => { if (validDate(event.target.value)) { state.followToday = false; state.currentDate = event.target.value; loadData(false); } });
    $('#refreshButton').addEventListener('click', () => loadData(true));
    $('#subscribeButton').addEventListener('click', subscribeGoogleCalendar);
    $('#copyFeedButton').addEventListener('click', copyFeedUrl);
    $('#timezoneInput').addEventListener('change', () => {
      if (validateTimeZone($('#timezoneInput').value.trim())) $('#timezoneHint').textContent = `${formatZoneOffset($('#timezoneInput').value.trim())} · Press Update prayer times to apply this zone.`;
    });
  }

  function updateLiveUi() {
    $('#topbarDate').textContent = formatLongDate();
    const today = dateInTimeZone(state.settings.timeZone);
    if (state.followToday && state.currentDate && state.currentDate !== today && !state.loading) {
      state.currentDate = today;
      $('#datePicker').value = today;
      loadData(false);
      return;
    }
    if (state.day && !state.loading) {
      renderNext();
      // Keep the small status lines current without hitting the prayer service.
      $$('#prayerGrid .prayer-card').forEach((card, index) => {
        const name = prayerOrder[index];
        const meta = card.querySelector('.prayer-meta');
        if (meta && state.day.timings?.[name]) {
          const status = timeStatus(name, state.day.timings[name]);
          meta.innerHTML = `<span class="meta-dot"></span>${status.label}`;
          card.classList.toggle('past', status.state === 'past');
        }
      });
    }
  }

  async function init() {
    populateTimeZones();
    bindEvents();
    $$('.clock-option').forEach((button) => button.classList.toggle('active', (button.dataset.clock === '12') === state.clock12));
    try {
      await ensureProfile();
      await loadData(false);
    } catch (error) {
      showDataError(error);
      setFormStatus(error.message || 'The app could not initialize.');
    }
    setInterval(updateLiveUi, 1000);
    // Prayer services and subscribed feeds are cached upstream for a short period;
    // keep an open board fresh without making a request every second.
    setInterval(() => { if (!state.loading) loadData(true); }, 15 * 60 * 1000);
  }

  init();
})();
