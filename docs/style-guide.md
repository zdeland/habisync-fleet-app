# HabiSync Dashboard Style Guide

Visual spec for the on-device dashboard (`handleDashboard()` in
`src/main.cpp`), extracted so the [fleet monitoring webapp](monitoring-webapp-plan.md)
can render matching cards, switches, gauges, and charts. Colors and markup
below are copied directly from the firmware's HTML/CSS/JS — not
reinterpreted — so treat this as ground truth over eyeballing a screenshot.

An interactive reference build of every component is published at the
artifact linked in this conversation; use it alongside this doc to
copy exact markup/CSS.

## 1. Palette

| Role | Hex | Used for |
|---|---|---|
| Page background | `#122333` | `body` |
| Card background | `#1D3A57` | `.card` |
| Primary text | `#eee` | body text, gauge value |
| Secondary text | `#B8C4D0` | labels, device names, hints |
| Tertiary text | `#93A8BD` | sub-hints, chart axis labels, target ranges |
| Accent (links, active) | `#4FD1C5` | links, checked switch track, temp chart line |
| Dark surface | `#141414` | nav tiles, status box, event rows |
| Dark surface hover | `#1f1f1f` | nav tile `:hover` |
| Good / on / normal | `#48BB78` | status dot: normal, healthy |
| Bad / alert | `#F56565` | status dot: too hot/humid, gauge red zone |
| Heating / warm | `#F6AD55` | status dot: heating |
| Cool / misting | `#4299E1` | status dot: misting, gauge cold zone, humidity chart line |
| Dry zone | `#C05621` | gauge low-humidity zone |
| Disabled / neutral | `#888` | status dot: automation disabled |
| Active badge border | `#6EC9E6` | device-icon badge, outlet is on |
| Switch track (off) | `#333` | `.slider` |
| Switch thumb (off) | `#ccc` | `.slider:before` |
| Switch thumb (on) | `#111` | checked `.slider:before` |
| Card shadow | `rgba(0,0,0,0.5)` | `0 0 10px` blur, all cards |

Dashboard is **dark-theme only** — there's no light variant to match; if the
webapp supports both, treat this palette as the dark-mode target.

## 2. Typography

- Font stack: `Arial, sans-serif` everywhere — no custom webfont.
- Body text centered by default; component-internal content (cards with
  lists/forms) switches to left-aligned via `text-align:left` on the card
  or a child wrapper.
- Sizes are all relative (`em`), no fixed px scale:
  - Section titles (card headers): `1.1em`
  - Gauge value (e.g. "72.4 °F"): `1.6em`, bold
  - Body/labels: default (`1em`) down to `0.85em`/`0.8em` for secondary
    labels, `0.75em` for the smallest sub-labels (event sensor readout)

## 3. Layout primitives

### Card

```css
.card { background:#1D3A57; border-radius:12px; padding:20px; margin:15px auto;
         width:80%; max-width:300px; box-shadow:0 0 10px rgba(0,0,0,0.5); }
.card.wide { max-width:420px; }
.card.extra-wide { max-width:900px; }
```

Three fixed widths only — pick whichever fits the content, don't interpolate:
- Default (300px) — single gauge/status/chart tile
- `.wide` (420px) — a form (Kasa/relay setup cards)
- `.extra-wide` (900px) — full-width sections (automation row, device
  history, setup nav)

### Row of cards

```css
.row-flex { display:flex; flex-wrap:wrap; justify-content:center; gap:15px; max-width:900px; margin:15px auto; }
.row-flex .card { margin:0; flex:1 1 260px; max-width:340px; }
```

Used to place the temp/humidity gauges, status checks, and charts
side-by-side, wrapping to stacked on narrow screens.

## 4. Toggle switch

A pill switch, not a native checkbox — used for every outlet, day/night
mode, and the climate-automation master toggle.

```css
.switch { position:relative; display:inline-block; width:50px; height:28px; flex-shrink:0; }
.switch input { opacity:0; width:0; height:0; }
.slider { position:absolute; inset:0; background:#333; border-radius:28px; cursor:pointer; transition:.2s; }
.slider:before { content:""; position:absolute; height:22px; width:22px; left:3px; bottom:3px; background:#ccc; border-radius:50%; transition:.2s; }
.switch input:checked + .slider { background:#4FD1C5; }
.switch input:checked + .slider:before { transform:translateX(22px); background:#111; }
.switch input:disabled + .slider { cursor:not-allowed; opacity:0.5; }
```

```html
<label class="switch">
  <input type="checkbox" checked>
  <span class="slider"></span>
</label>
```

**Pending state**: while a toggle's request is in flight, the firmware
swaps the switch for a small spinner rather than showing an optimistic or
disabled toggle — the switch never shows a state the server hasn't
confirmed:

```css
.switch .spinner { width:16px; height:16px; margin:6px auto; border:3px solid #333; border-top-color:#4FD1C5; border-radius:50%; animation:spin 0.7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
```
```html
<div class="switch"><div class="spinner"></div></div>
```

For a read-only monitoring app (per the webapp plan, no remote control),
you likely only need the static on/off rendering, not the pending spinner
or click handler — but keep the visual identical so a screenshot/state
snapshot looks like the real dashboard.

## 5. Device icon (outlet role)

Each outlet renders as an emoji icon + label, dimmed when off, with an
accent border around the icon when on:

```css
.device-icon-row { display:flex; flex-wrap:wrap; justify-content:center; gap:20px; margin-top:16px; }
.device-icon-col { display:flex; flex-direction:column; align-items:center; width:84px; }
.device-icon { font-size:2em; opacity:1; transition:opacity .2s; }
.device-icon.off { opacity:0.35; }
.device-icon-name { font-size:0.8em; color:#B8C4D0; margin-top:6px; text-align:center; }
.device-icon-badge { padding:8px; border-radius:10px; border:2px solid transparent; }
.device-icon-badge.on { border-color:#6EC9E6; }
```

```html
<div class="device-icon-col">
  <div class="device-icon-badge on">
    <div class="device-icon">🔥</div>
    <div class="device-icon-name">Heater</div>
  </div>
  <label class="switch">...</label>
</div>
```

Role → icon mapping (from `outletRoles()` in the dashboard JS):

| Role | Icon |
|---|---|
| Day Light | ☀️ |
| Heater | 🔥 |
| Mister | 💧 |
| Fan | 🌀 |
| UVB Light | 🔆 |
| Unassigned outlet (falls back to Kasa alias) | 🔌 |
| Night mode | 🌙 (shown instead of ☀️ when `nightMode` is true) |

An outlet with no role match displays its raw Kasa alias as the label
instead of a role name — worth preserving in the webapp's historical view
since older devices/log rows may only have the alias, not a role.

## 6. Gauge (temperature / humidity)

A semicircular SVG gauge with colored range zones, a needle, and a center
value readout — not a library, hand-drawn with `<path>` arcs. `viewBox="0
0 200 120"`, center `(100, 100)`, radius `80`, arc stroke width `16`.

```js
function polarToCartesian(cx, cy, r, angleDeg) {
  const a = (angleDeg - 180) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx, cy, r, a0, a1) {
  const p0 = polarToCartesian(cx, cy, r, a0);
  const p1 = polarToCartesian(cx, cy, r, a1);
  const largeArc = (a1 - a0) > 180 ? 1 : 0;
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${largeArc} 1 ${p1.x} ${p1.y}`;
}

// angle domain is 0–180° mapped linearly across [min, max]
function drawGauge(value, min, max, zones) {
  const cx = 100, cy = 100, r = 80;
  const clamped = Math.max(min, Math.min(max, value));
  const valueAngle = (clamped - min) / (max - min) * 180;
  // one <path> per zone, stroke = zone.color, stroke-width 16, fill none
  // needle: line from (cx,cy) to polarToCartesian(cx, cy, r-14, valueAngle), stroke #eee width 4, round cap
  // center dot: circle r=6 fill #eee
  // min/max labels: text at (16,114) and (184,114) fill #93A8BD font-size 12
}
```

Zone colors by gauge type (fixed 0–100 domain in both cases, zones
computed from the live climate targets):

**Temperature** — `{0→tempLowF: #4299E1 (cold/blue), tempLowF→tempHighF:
#48BB78 (good/green), tempHighF→100: #F56565 (hot/red)}`

**Humidity** — `{0→humLow: #C05621 (dry/orange), humLow→humHigh: #48BB78
(good/green), humHigh→100: #F56565 (too humid/red)}`

Value readout overlays the gauge (`position:absolute; top:62%`), bold,
`1.6em`, primary text color. Below the gauge: a plain-text label ("Current
Temperature") and, on a second line, the live target range ("Optimal
range: 68.0 – 82.0 °F") or "automation disabled" when climate automation
is off.

```css
.gauge-card { display:flex; flex-direction:column; align-items:center; }
.gauge-wrap { position:relative; width:100%; max-width:220px; }
.gauge { width:100%; height:auto; display:block; }
.gauge-value { position:absolute; left:0; right:0; top:62%; transform:translateY(-50%); font-size:1.6em; font-weight:bold; color:#eee; }
.gauge-label { margin-top:6px; color:#B8C4D0; font-size:0.9em; }
.gauge-target { margin-top:4px; color:#93A8BD; font-size:0.8em; }
```

For the webapp's playback/scrubber view, this is the exact component to
reuse for "gauge state at the scrubbed instant" — feed it the
reconstructed temp/hum value and the `profile_config` targets resolved for
that point in time (per the reducer in the webapp plan, §5).

## 7. Line chart (history sparkline)

Minimal hand-drawn polyline, not a charting library — reasonable for the
on-device dashboard's fixed "last hour" view, but the webapp's
timeline/zoom needs will likely outgrow this (a real charting lib is
already recommended in the webapp plan). Keep the same visual language
(colors, thin `2px` stroke, `#93A8BD` axis labels) even if you switch
implementations:

```js
function renderLineChart(values, color) {
  const w = 300, h = 100, pad = 10;
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max - min) || 1;
  const stepX = (w - 2 * pad) / (values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (h - 2 * pad) * (1 - (v - min) / range);
    return `${x},${y}`;
  }).join(' ');
  // <polyline points="..." fill="none" stroke={color} stroke-width="2"/>
  // min/max labels at (pad, h-2) and (pad, pad+10), fill #93A8BD font-size 10
}
```

Line colors: temperature `#4FD1C5` (accent teal), humidity `#4299E1` (blue)
— note this is a *different* teal/blue pairing than the gauge zone colors;
don't conflate the two.

```css
.chart-card { text-align:left; }
.chart-label { color:#B8C4D0; font-size:0.85em; margin-bottom:6px; }
.chart-svg { width:100%; height:auto; }
```

## 8. Status check row

A colored dot + one-line status text, used for the plain-English
"Temperature Control Check" / "Humidity Control Check" cards. This is
the most directly reusable component for the webapp's "Context panel at
the scrubbed instant" (per the webapp plan, §4.3).

```css
.status-box { display:flex; align-items:center; gap:10px; background:#141414; border-radius:8px; padding:12px; margin-top:8px; font-family:monospace; font-size:0.85em; }
.dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
```

Dot color + text by state (temperature side shown; humidity side mirrors
it with misting/too-humid wording):

| State | Dot color | Text |
|---|---|---|
| Automation disabled | `#888` | `AUTOMATION DISABLED` |
| Heating | `#F6AD55` | `HEATING — heat outlet ON` |
| Too hot (fan responding) | `#F56565` | `TOO HOT — fan ON` |
| Normal | `#48BB78` | `TEMP NORMAL — no action needed` |

## 9. Event log row

Used for the "Device History" feed — the closest existing analog to the
webapp's merged `logs`/`telemetry` timeline (per the webapp plan, §4.2).

```css
.event-list { display:flex; flex-direction:column; gap:10px; margin-top:6px; max-height:340px; overflow-y:auto; }
.event-row { display:flex; align-items:center; gap:12px; padding:10px 12px; background:#141414; border-radius:8px; }
.event-icon { flex-shrink:0; width:26px; font-size:1.3em; text-align:center; }
.event-time { flex-shrink:0; width:78px; font-size:0.8em; color:#93A8BD; }
.event-desc { flex:1; }
.event-sensor { font-size:0.75em; color:#93A8BD; margin-top:2px; }
```

```html
<div class="event-row">
  <div class="event-icon">🔥</div>
  <div class="event-time">14:12</div>
  <div class="event-desc">Heater ON — temperature below target range
    <div class="event-sensor">68.2°F / 41.0% RH</div>
  </div>
</div>
```

Time label is either a clock time (`14:12`) or a relative "N minutes/hours
ago" string when no absolute timestamp is available — same fallback logic
is worth keeping since the webapp will have the same
`device_time`-may-be-null situation described in the webapp plan (§5.5).

## 10. Nav tile

Icon-over-label button/link grid, used for the setup/tools section.
Useful in the webapp for a device's action/settings summary panel (even
though the webapp is read-only — these'd just link out or show
current values, not trigger anything).

```css
.nav-tile-row { display:flex; flex-wrap:wrap; justify-content:center; gap:14px; margin-top:14px; }
.nav-tile { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; width:120px; padding:16px 10px; background:#141414; border-radius:10px; border:none; text-decoration:none; color:#eee; font-family:inherit; font-size:1em; cursor:pointer; transition:background .15s, transform .15s; }
.nav-tile:hover { background:#1f1f1f; transform:translateY(-2px); }
.nav-tile.busy { opacity:0.6; cursor:default; pointer-events:none; }
.nav-tile-icon { font-size:1.8em; }
.nav-tile-label { font-size:0.85em; color:#B8C4D0; text-align:center; }
```

## 11. What to deliberately not carry over

- **No remote control** — the webapp is read-only (per the webapp plan,
  §6), so switches/toggles render as static on/off indicators, never
  interactive inputs. Keep the exact same visual (pill shape, colors,
  thumb position) but drop the `onchange` handler and the pending-spinner
  state entirely.
- **The hand-rolled SVG gauge/chart math above is a spec to match
  visually, not a mandate to hand-roll it again** — a real charting
  library (Observable Plot, uPlot, Recharts, or D3 directly) is already
  recommended in the webapp plan for the zoom/scrub/range-band features
  the on-device version doesn't need. Reproduce the zone colors, needle,
  and label styling; don't feel obligated to reuse the raw path-drawing
  functions.
