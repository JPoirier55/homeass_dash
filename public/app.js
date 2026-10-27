// HOMELAB dashboard: polls Home Assistant (via the local proxy) and renders the pixel UI.

const C = {
  panel: '#1a1c2c', edge: '#333c57', dim: '#566c86', yellow: '#ffcd75', green: '#a7f070',
  cyan: '#73eff7', blue: '#41a6f6', orange: '#ef7d57', red: '#b13e53',
};
const OFFLINE = new Set(['unavailable', 'unknown', '']);
const HISTORY_HOURS = 12;
const HISTORY_BUCKETS = 24;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const upper = (s) => String(s ?? '').toUpperCase();

let config = {};
let states = new Map();
let co2History = new Map();
let lightAreas = new Map();
let lightKey = '';
const pending = new Set();
const actionStatus = new Map(); // entity → 'running' | 'done' | 'error'

// ---------- API ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

const callService = (domain, service, entityIds) =>
  api(`/api/services/${domain}/${service}`, { method: 'POST', body: JSON.stringify({ entity_id: entityIds }) });

// ---------- Entity selection (explicit config or auto-discovery) ----------

const domainOf = (id) => id.split('.')[0];
const attr = (id, key) => states.get(id)?.attributes?.[key];
const friendly = (id) => attr(id, 'friendly_name') || id.split('.')[1].replace(/_/g, ' ');

// config.exclude: entity IDs to skip during auto-discovery; `*` matches anything.
const excluded = (id) => (config.exclude || []).some((pat) =>
  new RegExp('^' + pat.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(id));
const discoverable = () => [...states.values()].filter((s) => !excluded(s.entity_id));

function climateEntries() {
  if (Array.isArray(config.climate)) return config.climate;
  const temps = discoverable().filter((s) =>
    s.entity_id.startsWith('sensor.') && s.attributes.device_class === 'temperature');
  return temps.map((s) => {
    const humid = s.entity_id.replace(/temperature/, 'humidity');
    return {
      name: friendly(s.entity_id).replace(/\s*temperature\s*/i, ' ').trim(),
      temperature: s.entity_id,
      humidity: humid !== s.entity_id && states.has(humid) ? humid : undefined,
    };
  });
}

function co2Entries() {
  if (Array.isArray(config.co2)) return config.co2;
  return discoverable()
    .filter((s) => s.attributes.device_class === 'carbon_dioxide')
    .map((s) => ({ name: friendly(s.entity_id).replace(/\s*(co2|carbon dioxide)\s*/i, ' ').trim(), entity: s.entity_id }));
}

function lightEntries() {
  if (Array.isArray(config.lights)) return config.lights;
  return discoverable()
    .filter((s) => s.entity_id.startsWith('light.'))
    .map((s) => ({ entity: s.entity_id, name: friendly(s.entity_id), room: lightAreas.get(s.entity_id) || '' }))
    .sort((a, b) => (a.room || '~').localeCompare(b.room || '~') || a.name.localeCompare(b.name));
}

async function loadLightAreas() {
  const ids = [...states.keys()].filter((id) => id.startsWith('light.'));
  if (!ids.length) return;
  try {
    // HA's template endpoint resolves each light's area name in one call.
    const out = await api('/api/template', {
      method: 'POST',
      body: JSON.stringify({ template: `{{ ${JSON.stringify(ids)} | map('area_name') | list | tojson }}` }),
    });
    const names = typeof out === 'string' ? JSON.parse(out) : out;
    ids.forEach((id, i) => names[i] && lightAreas.set(id, names[i]));
  } catch { /* rooms are optional */ }
}

// ---------- Helpers ----------

function numeric(id) {
  const s = states.get(id);
  if (!s || OFFLINE.has(s.state)) return null;
  const n = parseFloat(s.state);
  return Number.isFinite(n) ? n : null;
}

const toF = (v, unit) => (unit === '°C' ? v * 9 / 5 + 32 : v);
const fromF = (f, unit) => (unit === '°C' ? (f - 32) * 5 / 9 : f);
const tBand = (f) => f < 62 ? ['COLD', C.blue] : f < 68 ? ['COOL', C.cyan] : f < 75 ? ['COMFY', C.green] : f < 80 ? ['WARM', C.yellow] : ['HOT', C.orange];
const co2Color = (v) => v < 800 ? C.green : v < 1200 ? C.yellow : C.red;
const segs = (n, total, colorFor) =>
  Array.from({ length: total }, (_, i) => `<div style="background:${i < n ? colorFor(i) : 'var(--edge)'}"></div>`).join('');

// ---------- Render ----------

function renderClimate() {
  const entries = climateEntries();
  $('climateSection').hidden = !entries.length;
  $('climateSub').textContent = `${entries.length} ROOMS · TEMP + HUMIDITY`;
  $('climate').innerHTML = entries.map((e) => {
    const t = numeric(e.temperature);
    const unit = attr(e.temperature, 'unit_of_measurement') || '°F';
    const h = e.humidity ? numeric(e.humidity) : null;
    const [label, color] = t == null ? ['OFFLINE', C.dim] : tBand(toF(t, unit));
    const hColor = h != null && (h < 30 || h > 60) ? C.yellow : C.blue;
    return `
      <article class="card px-frame${t == null ? ' offline' : ''}">
        <div class="card-head">
          <h3>${esc(upper(e.name))}</h3>
          <span class="tag" style="background:${color}">${label}</span>
        </div>
        <div class="big" style="color:${color}">${t == null ? '--.-' : t.toFixed(1)}${esc(unit)}</div>
        ${e.humidity ? `
        <div class="meter">
          <div class="row"><span>HUMIDITY</span><b>${h == null ? '--' : Math.round(h)}%</b></div>
          <div class="segs" style="grid-template-columns:repeat(10,minmax(0,1fr))" role="img" aria-label="Humidity ${h ?? 'unknown'} percent">
            ${segs(h == null ? 0 : Math.round(h / 10), 10, () => hColor)}
          </div>
        </div>` : ''}
      </article>`;
  }).join('');
}

function renderCo2() {
  const entries = co2Entries();
  $('co2Section').hidden = !entries.length;
  $('board').classList.toggle('no-air', !entries.length);
  $('co2').innerHTML = entries.map((e) => {
    const ppm = numeric(e.entity);
    const color = ppm == null ? C.dim : co2Color(ppm);
    const label = ppm == null ? 'OFFLINE' : ppm < 800 ? 'GOOD' : ppm < 1200 ? 'OK' : 'POOR';
    const filled = ppm == null ? 0 : Math.max(0, Math.min(20, Math.round((ppm - 400) / 80)));
    const hist = co2History.get(e.entity) || [];
    const bars = hist.map((v) => v == null
      ? '<div style="height:4px;background:var(--panel-2)"></div>'
      : `<div style="height:${Math.round(Math.max(4, (v - 400) / 1600 * 52))}px;background:${co2Color(v)}"></div>`).join('');
    return `
      <article class="card co2-card px-frame${ppm == null ? ' offline' : ''}">
        <div class="card-head">
          <h3>${esc(upper(e.name))}</h3>
          <span class="tag" style="background:${color}">${label}</span>
        </div>
        <div class="ppm">
          <span class="big" style="color:${ppm != null && ppm >= 1200 ? C.orange : color}">${ppm == null ? '----' : Math.round(ppm)}</span>
          <span class="muted">PPM</span>
        </div>
        <div class="bars" role="img" aria-label="CO2 over the last ${HISTORY_HOURS} hours">${bars}</div>
        <div class="scale"><span>-${HISTORY_HOURS}H</span><span>NOW</span></div>
        <div class="meter">
          <div class="segs" style="grid-template-columns:repeat(20,minmax(0,1fr))" aria-hidden="true">
            ${segs(filled, 20, (i) => co2Color(400 + i * 80 + 40))}
          </div>
          <div class="scale"><span>400</span><span>800</span><span>1200</span><span>2000</span></div>
        </div>
      </article>`;
  }).join('');
}

const BULB = `
  <svg aria-hidden="true" width="36" height="36" viewBox="0 0 12 12" shape-rendering="crispEdges">
    <path class="glass" d="M4 0h4v1h2v1h1v3h-1v1h-1v1h-1v1h-4v-1h-1v-1h-1v-1h-1v-3h1v-1h2z"></path>
    <rect class="shine" x="3" y="2" width="1" height="2"></rect>
    <rect x="4" y="8" width="4" height="1" fill="#94b0c2"></rect>
    <rect x="4" y="9" width="4" height="1" fill="#566c86"></rect>
    <rect x="4" y="10" width="4" height="1" fill="#94b0c2"></rect>
    <rect x="5" y="11" width="2" height="1" fill="#566c86"></rect>
  </svg>`;

const SUN = `
  <svg aria-hidden="true" width="36" height="36" viewBox="0 0 12 12" shape-rendering="crispEdges">
    <path class="glass" d="M5 0h2v2h-2zM5 10h2v2h-2zM0 5h2v2h-2zM10 5h2v2h-2zM1 1h2v2h-2zM9 1h2v2h-2zM1 9h2v2h-2zM9 9h2v2h-2zM4 3h4v1h1v4h-1v1h-4v-1h-1v-4h1z"></path>
    <rect class="shine" x="4" y="4" width="1" height="2"></rect>
  </svg>`;

// config.buttons: automations/scripts/scenes shown as tiles beside the lights.
const ACTION_SERVICE = { automation: 'trigger', script: 'turn_on', scene: 'turn_on' };
const buttonEntries = () => (Array.isArray(config.buttons) ? config.buttons : [])
  .filter((b) => ACTION_SERVICE[domainOf(b.entity)]);

function renderLights() {
  const entries = lightEntries();
  const buttons = buttonEntries();
  $('lightsSection').hidden = !entries.length && !buttons.length;

  // Rebuild buttons only when the set of tiles changes, so focus survives polling.
  const key = [...buttons, ...entries].map((e) => e.entity).join('|');
  if (key !== lightKey) {
    lightKey = key;
    $('lights').innerHTML = buttons.map((b) => `
      <button type="button" class="light action" data-entity="${esc(b.entity)}">
        <div class="light-top">${SUN}<span class="state">RUN</span></div>
        <span class="name">${esc(upper(b.name || friendly(b.entity)))}</span>
        <span class="room">${esc(upper(b.room ?? domainOf(b.entity)))}</span>
      </button>`).join('') + entries.map((e) => `
      <button type="button" class="light" data-entity="${esc(e.entity)}" aria-pressed="false">
        <div class="light-top">${BULB}<span class="state">OFF</span></div>
        <span class="name">${esc(upper(e.name || friendly(e.entity)))}</span>
        <span class="room">${esc(upper(e.room || ''))}</span>
      </button>`).join('');
  }

  for (const btn of $('lights').querySelectorAll('.action')) {
    const s = states.get(btn.dataset.entity);
    const status = actionStatus.get(btn.dataset.entity);
    const offline = !s || OFFLINE.has(s.state);
    btn.classList.toggle('on', status === 'running' || status === 'done');
    btn.classList.toggle('offline', offline);
    btn.disabled = offline || status === 'running';
    btn.querySelector('.state').textContent =
      offline ? 'N/A' : { running: '...', done: 'DONE', error: 'FAIL' }[status] || 'RUN';
  }

  let on = 0;
  for (const btn of $('lights').querySelectorAll('.light:not(.action)')) {
    const s = states.get(btn.dataset.entity);
    const isOn = s?.state === 'on';
    const offline = !s || OFFLINE.has(s.state);
    if (isOn) on++;
    btn.classList.toggle('on', isOn);
    btn.classList.toggle('offline', offline);
    btn.classList.toggle('pending', pending.has(btn.dataset.entity));
    btn.disabled = offline;
    btn.setAttribute('aria-pressed', String(isOn));
    btn.querySelector('.state').textContent = offline ? 'N/A' : isOn ? 'ON' : 'OFF';
  }
  $('lightsSub').textContent = `${on} OF ${entries.length} ON`;
  $('lightCount').textContent = `${on}/${entries.length}`;
}

function renderHud(error) {
  const sensorIds = [
    ...climateEntries().flatMap((e) => [e.temperature, e.humidity].filter(Boolean)),
    ...co2Entries().map((e) => e.entity),
  ];
  const online = sensorIds.filter((id) => numeric(id) != null).length;
  $('sensorCount').textContent = `${online}/${sensorIds.length}`;

  const temps = climateEntries()
    .map((e) => ({ v: numeric(e.temperature), unit: attr(e.temperature, 'unit_of_measurement') || '°F' }))
    .filter((t) => t.v != null);
  if (temps.length) {
    const unit = temps[0].unit;
    const avgF = temps.reduce((a, t) => a + toF(t.v, t.unit), 0) / temps.length;
    $('avgTemp').textContent = fromF(avgF, unit).toFixed(1).replace(/\.0$/, '') + unit;
  } else {
    $('avgTemp').textContent = '--';
  }

  const status = $('status');
  const missing = sensorIds.length - online;
  if (error) {
    status.className = 'bad';
    status.textContent = 'CONNECTION LOST';
  } else if (missing) {
    status.className = 'warn';
    status.textContent = `${missing} SENSOR${missing > 1 ? 'S' : ''} OFFLINE`;
  } else {
    status.className = 'ok';
    status.textContent = 'ALL SYSTEMS NOMINAL';
  }
}

function render(error) {
  renderClimate();
  renderCo2();
  renderLights();
  renderHud(error);
}

// ---------- Data loading ----------

async function refreshStates() {
  try {
    const list = await api('/api/states');
    states = new Map(list.map((s) => [s.entity_id, s]));
    render(null);
    $('updated').textContent = `LAST SYNC ${new Date().toLocaleTimeString([], { hour12: false })}`;
  } catch (err) {
    console.error(err);
    renderHud(err);
    $('updated').textContent = `SYNC FAILED · ${upper(err.message).slice(0, 80)}`;
  }
}

async function refreshHistory() {
  const ids = co2Entries().map((e) => e.entity);
  if (!ids.length) return;
  const end = Date.now();
  const start = end - HISTORY_HOURS * 3600e3;
  const step = (end - start) / HISTORY_BUCKETS;
  try {
    const qs = new URLSearchParams({ filter_entity_id: ids.join(','), end_time: new Date(end).toISOString() });
    const data = await api(`/api/history/period/${new Date(start).toISOString()}?${qs}&minimal_response&no_attributes`);
    for (const series of data) {
      const id = series[0]?.entity_id;
      if (!id) continue;
      const points = series
        .map((p) => ({ t: Date.parse(p.last_changed || p.last_updated), v: parseFloat(p.state) }))
        .filter((p) => Number.isFinite(p.v))
        .sort((a, b) => a.t - b.t);
      // Each bar is the average of readings in its window, carrying the last value through gaps.
      const buckets = [];
      let last = null;
      let j = 0;
      for (let b = 0; b < HISTORY_BUCKETS; b++) {
        const until = start + step * (b + 1);
        let sum = 0, n = 0;
        while (j < points.length && points[j].t <= until) { sum += points[j].v; n++; j++; }
        if (n) last = sum / n;
        buckets.push(last);
      }
      co2History.set(id, buckets);
    }
    renderCo2();
  } catch (err) {
    console.error('history', err);
  }
}

// ---------- Controls ----------

async function toggleLight(id) {
  const s = states.get(id);
  if (!s) return;
  // Optimistic flip so the tile responds instantly.
  states.set(id, { ...s, state: s.state === 'on' ? 'off' : 'on' });
  pending.add(id);
  renderLights();
  try {
    await callService(domainOf(id), 'toggle', id);
  } catch (err) {
    console.error(err);
  } finally {
    pending.delete(id);
    setTimeout(refreshStates, 400);
  }
}

async function setAll(on) {
  const ids = lightEntries().map((e) => e.entity).filter((id) => states.has(id) && !OFFLINE.has(states.get(id).state));
  const byDomain = new Map();
  for (const id of ids) byDomain.set(domainOf(id), [...(byDomain.get(domainOf(id)) || []), id]);
  for (const id of ids) states.set(id, { ...states.get(id), state: on ? 'on' : 'off' });
  renderLights();
  $('allOn').disabled = $('allOff').disabled = true;
  try {
    await Promise.all([...byDomain].map(([d, list]) => callService(d, on ? 'turn_on' : 'turn_off', list)));
  } catch (err) {
    console.error(err);
  } finally {
    $('allOn').disabled = $('allOff').disabled = false;
    setTimeout(refreshStates, 400);
  }
}

async function runAction(id) {
  actionStatus.set(id, 'running');
  renderLights();
  try {
    await callService(domainOf(id), ACTION_SERVICE[domainOf(id)], id);
    actionStatus.set(id, 'done');
  } catch (err) {
    console.error(err);
    actionStatus.set(id, 'error');
  }
  renderLights();
  setTimeout(() => { actionStatus.delete(id); renderLights(); }, 2500);
}

$('lights').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button.light');
  if (!btn) return;
  if (btn.classList.contains('action')) runAction(btn.dataset.entity);
  else toggleLight(btn.dataset.entity);
});
$('allOn').addEventListener('click', () => setAll(true));
$('allOff').addEventListener('click', () => setAll(false));

// ---------- Seasonal themes ----------

const PUMPKIN = `
  <svg width="36" height="36" viewBox="0 0 12 12" shape-rendering="crispEdges">
    <rect x="5" y="0" width="2" height="2" fill="#38b764"></rect>
    <path fill="#ef7d57" d="M2 2h8v1h1v1h1v6h-1v1h-1v1h-8v-1h-1v-1h-1v-6h1v-1h1z"></path>
    <rect x="6" y="2" width="1" height="10" fill="#b13e53"></rect>
    <path fill="#ffcd75" d="M3 5h2v2h-2zM7 5h2v2h-2zM3 8h6v1h-1v1h-4v-1h-1z"></path>
  </svg>`;

const LEAF = `
  <svg width="36" height="36" viewBox="0 0 12 12" shape-rendering="crispEdges">
    <path fill="#ef7d57" d="M5 0h2v1h1v1h2v1h1v2h1v1h-1v1h-1v1h-1v1h-2v-1h-2v1h-2v-1h-1v-1h-1v-1h-1v-1h1v-2h1v-1h2v-1h1z"></path>
    <path fill="#b13e53" d="M5 2h1v7h-1zM3 5h2v1h-2zM6 5h3v1h-3z"></path>
    <rect x="5" y="9" width="1" height="3" fill="#5d275d"></rect>
  </svg>`;

const TREE = `
  <svg width="36" height="36" viewBox="0 0 12 12" shape-rendering="crispEdges">
    <rect x="5" y="0" width="2" height="1" fill="#ffcd75"></rect>
    <path fill="#38b764" d="M5 1h2v1h1v1h1v1h-1v1h1v1h1v1h-1v1h1v1h1v1h-10v-1h1v-1h1v-1h-1v-1h1v-1h1v-1h-1v-1h1v-1h1z"></path>
    <path fill="#b13e53" d="M5 3h1v1h-1zM7 6h1v1h-1zM3 8h1v1h-1z"></path>
    <path fill="#73eff7" d="M6 5h1v1h-1zM4 6h1v1h-1zM8 8h1v1h-1z"></path>
    <rect x="5" y="10" width="2" height="2" fill="#5d275d"></rect>
  </svg>`;

// Pixel cobweb for the screen corners: radial threads with sagging rings, drawn
// from the top-left on an n×n grid (CSS mirrors it for the other corner).
function cobweb(n = 22) {
  const px = new Set();
  const plot = (x, y) => x >= 0 && y >= 0 && x < n && y < n && px.add(`${x},${y}`);
  const line = (x0, y0, x1, y1) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++) plot(Math.round(x0 + (x1 - x0) * i / steps), Math.round(y0 + (y1 - y0) * i / steps));
  };
  const angles = [0, 0.38, 0.79, 1.19, Math.PI / 2];
  for (const a of angles) {
    const len = (n - 1) / Math.max(Math.cos(a), Math.sin(a));
    line(0, 0, Math.cos(a) * len, Math.sin(a) * len);
  }
  for (const r of [5, 10, 15, 20]) {
    for (let i = 0; i < angles.length - 1; i++) {
      const [a, b] = [angles[i], angles[i + 1]];
      const mid = (a + b) / 2;
      const sag = r * 0.82; // ring threads dip toward the corner between radials
      const [x0, y0] = [Math.cos(a) * r, Math.sin(a) * r];
      const [xm, ym] = [Math.cos(mid) * sag, Math.sin(mid) * sag];
      const [x1, y1] = [Math.cos(b) * r, Math.sin(b) * r];
      line(x0, y0, xm, ym);
      line(xm, ym, x1, y1);
    }
  }
  const d = [...px].map((p) => { const [x, y] = p.split(','); return `M${x} ${y}h1v1h-1z`; }).join('');
  return `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path fill="#b9a3cc" d="${d}"></path></svg>`;
}

const SPIDER = `
  <svg viewBox="0 0 7 30" shape-rendering="crispEdges">
    <rect x="3" y="0" width="1" height="25" fill="#b9a3cc" opacity="0.6"></rect>
    <path fill="#07040a" d="M1 25h1v1h-1zM5 25h1v1h-1zM0 26h1v1h-1zM2 26h3v1h-3zM6 26h1v1h-1zM1 27h5v1h-5zM0 28h1v1h-1zM2 28h3v1h-3zM6 28h1v1h-1zM1 29h1v1h-1zM5 29h1v1h-1z"></path>
    <path fill="#ef7d57" d="M2 27h1v1h-1zM4 27h1v1h-1z"></path>
  </svg>`;

let websDrawn = false;

function showWebs(on) {
  const el = $('webs');
  if (on && !websDrawn) {
    const web = cobweb();
    el.innerHTML = `<div class="web left">${web}</div><div class="web right">${web}</div><div class="spider">${SPIDER}</div>`;
    websDrawn = true;
  }
  el.hidden = !on;
}

// Falling overlays, drawn on a fixed canvas above the board (clicks pass through).
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const LEAF_FRAMES = [
  ['..#..', '.###.', '#####', '.###.', '..s..'],
  ['...##', '..###', '.###.', '###..', 's....'],
  ['##...', '###..', '.###.', '..###', '....s'],
];
const LEAF_CYCLE = [0, 1, 0, 2]; // rocks side to side as it falls

const FALLING = {
  snow: {
    area: 9000, // one particle per this many square px
    spawn: () => ({ size: pick([2, 3, 3, 4, 5]), speed: 18 + Math.random() * 30, drift: 6 + Math.random() * 12, rate: 1 }),
    draw(ctx, f, x, y) {
      ctx.fillStyle = f.size > 3 ? 'rgba(244,244,244,0.9)' : 'rgba(244,244,244,0.55)';
      ctx.fillRect(x, y, f.size, f.size);
    },
  },
  leaves: {
    area: 32000,
    spawn: () => ({
      size: pick([2, 3, 3]) * 5, speed: 22 + Math.random() * 22, drift: 18 + Math.random() * 28, rate: 0.6 + Math.random() * 0.6,
      color: pick(['#ef7d57', '#b13e53', '#ffcd75', '#a1452e']),
    }),
    draw(ctx, f, x, y) {
      const scale = f.size / 5;
      const frame = LEAF_FRAMES[LEAF_CYCLE[Math.floor(f.sway * 1.5) % 4]];
      frame.forEach((row, ry) => [...row].forEach((c, rx) => {
        if (c === '.') return;
        ctx.fillStyle = c === 's' ? '#5d275d' : f.color;
        ctx.fillRect(x + rx * scale, y + ry * scale, scale, scale);
      }));
    },
  },
};

let falling = { kind: null, frame: 0, cleanup: null };

function startFalling(kind) {
  if (kind === falling.kind) return;
  stopFalling();
  if (!kind || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const fx = FALLING[kind];
  const canvas = $('falling');
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, items = [];
  const spawn = (y) => ({ x: Math.random() * w, y, sway: Math.random() * Math.PI * 2, ...fx.spawn() });
  const resize = () => {
    w = canvas.width = innerWidth;
    h = canvas.height = innerHeight;
    items = Array.from({ length: Math.round(w * h / fx.area) }, () => spawn(Math.random() * h));
  };
  resize();
  addEventListener('resize', resize);
  canvas.hidden = false;

  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, w, h);
    for (const f of items) {
      f.y += f.speed * dt;
      f.sway += dt * f.rate;
      if (f.y > h) Object.assign(f, spawn(-f.size));
      // Whole-pixel positions keep everything crisp like the rest of the UI.
      fx.draw(ctx, f, Math.round(f.x + Math.sin(f.sway) * f.drift), Math.round(f.y));
    }
    falling.frame = requestAnimationFrame(step);
  };
  falling = {
    kind,
    frame: requestAnimationFrame(step),
    cleanup: () => { removeEventListener('resize', resize); ctx.clearRect(0, 0, w, h); },
  };
}

function stopFalling() {
  if (!falling.kind) return;
  cancelAnimationFrame(falling.frame);
  falling.cleanup();
  falling = { kind: null, frame: 0, cleanup: null };
  $('falling').hidden = true;
}

const SEASONS = {
  halloween: { decor: PUMPKIN, footer: 'TRICK OR TREAT', webs: true },
  fall: { decor: LEAF, footer: 'GIVE THANKS', falling: 'leaves' },
  christmas: { decor: TREE, footer: 'HAPPY HOLIDAYS', falling: 'snow' },
};
const DEFAULT_FOOTER = 'PRESS START TO CONTINUE';

// Day of November that Thanksgiving (4th Thursday) falls on.
const thanksgiving = (year) => 1 + (4 - new Date(year, 10, 1).getDay() + 7) % 7 + 21;

// October → Halloween; November through Thanksgiving → fall; from the day after → Christmas.
function seasonFor(d) {
  const month = d.getMonth();
  if (month === 9) return 'halloween';
  if (month === 10) return d.getDate() <= thanksgiving(d.getFullYear()) ? 'fall' : 'christmas';
  if (month === 11) return 'christmas';
  return '';
}

let season = null;

// Precedence: ?theme= in the URL (for previewing), then config.theme, then the calendar.
function applySeason() {
  const forced = new URLSearchParams(location.search).get('theme') || config.theme;
  const name = forced && forced !== 'auto' ? (SEASONS[forced] ? forced : '') : seasonFor(new Date());
  if (name === season) return;
  season = name;
  const theme = SEASONS[name] || {};
  if (name) document.documentElement.dataset.season = name;
  else delete document.documentElement.dataset.season;
  $('seasonDecor').innerHTML = theme.decor || '';
  $('footMsg').textContent = theme.footer || DEFAULT_FOOTER;
  const effects = config.effects !== false;
  startFalling(effects && theme.falling);
  showWebs(effects && !!theme.webs);
}

function tickClock() {
  const d = new Date();
  applySeason();
  $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- Boot ----------

async function boot() {
  try {
    config = await api('/config.json');
  } catch {
    config = {}; // no config.json: auto-discover everything
  }
  if (config.title) {
    $('title').textContent = upper(config.title);
    document.title = `${config.title} Dashboard`;
  }
  if (config.scanlines === false) document.querySelector('.scanlines').hidden = true;

  tickClock();
  setInterval(tickClock, 1000);

  await refreshStates();
  if (!Array.isArray(config.lights)) {
    await loadLightAreas();
    lightKey = '';
    renderLights();
  }
  refreshHistory();
  setInterval(refreshStates, (config.refreshSeconds || 5) * 1000);
  setInterval(refreshHistory, (config.historyRefreshMinutes || 5) * 60e3);
}

boot();
