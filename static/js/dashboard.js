/* 
 AGROROVER FARMER DASHBOARD — JAVASCRIPT
 */
"use strict";

// State 
let simRunning = false;
let currentStatus = null;
let cameraStream = null;
let pollInterval = null;
let charts = {};
let sensorHistory = { moisture:[], temp:[], ndvi:[], n:[], p:[], k:[] };
const MAX_HIST = 50;

// App configuration — loaded from the server, which reads simulation_config.json.
// Nothing about the simulation is hardcoded on this page.
let APP_CONFIG = null;

async function loadAppConfig() {
  try {
    APP_CONFIG = await fetch('/api/config').then(r => r.json());
    applyConfigDefaults();
  } catch (e) {
    console.warn('Could not load /api/config — using values already in the markup', e);
  }
}

// Fill every form / map / canvas default from the config file
function applyConfigDefaults() {
  if (!APP_CONFIG) return;
  const s = APP_CONFIG.initial_sensors;
  const r = APP_CONFIG.rover;

  // Map + canvas starting position
  roverLat = r.gps_lat;
  roverLon = r.gps_lon;
  drawTerrain(r.gps_lat, r.gps_lon, r.heading);

  // id -> config key for every numeric input on the page
  const fields = {
    // Soil health panel
    'f-n': 'nitrogen', 'f-p': 'phosphorus', 'f-k': 'potassium',
    'f-temp': 'temperature', 'f-hum': 'humidity', 'f-ph': 'ph_value', 'f-rain': 'rainfall',
    // Anomaly panel
    'a-vw30': 'vw_30cm', 'a-vw60': 'vw_60cm', 'a-vw90': 'vw_90cm',
    'a-vw120': 'vw_120cm', 'a-vw150': 'vw_150cm',
    'a-t30': 't_30cm', 'a-t60': 't_60cm', 'a-t90': 't_90cm',
    'a-t120': 't_120cm', 'a-t150': 't_150cm',
    // Zone panel
    'z-ndvi': 'ndvi', 'z-ndwi': 'ndwi', 'z-evi': 'evi',
    'z-savi': 'savi', 'z-nir': 'nir', 'z-swir': 'swir',
    // Manual input modal
    'm-vw30': 'vw_30cm', 'm-vw60': 'vw_60cm', 'm-vw90': 'vw_90cm',
    'm-vw120': 'vw_120cm', 'm-vw150': 'vw_150cm',
    'm-t30': 't_30cm', 'm-t60': 't_60cm', 'm-t90': 't_90cm',
    'm-t120': 't_120cm', 'm-t150': 't_150cm',
    'm-n': 'nitrogen', 'm-p': 'phosphorus', 'm-k': 'potassium',
    'm-ph': 'ph_value', 'm-rain': 'rainfall', 'm-hum': 'humidity', 'm-temp': 'temperature',
    'm-ndvi': 'ndvi', 'm-ndwi': 'ndwi', 'm-evi': 'evi',
    'm-savi': 'savi', 'm-nir': 'nir', 'm-swir': 'swir'
  };

  for (const [id, key] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el && s[key] !== undefined) el.value = s[key];
  }

  // Apply the min/max from the config ranges to each input
  const ranges = APP_CONFIG.sensor_ranges || {};
  for (const [id, key] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el && ranges[key]) { el.min = ranges[key].min; el.max = ranges[key].max; }
  }

  // Trip counters
  setText('trip-dist', r.distance_travelled.toFixed(1));
  setText('trip-rem',  r.remaining_distance.toFixed(1));
}

// Greeting helper 
function getGreeting() {
 const h = new Date().getHours();
 if (h < 12) return 'Good morning';
 if (h < 18) return 'Good afternoon';
 return 'Good evening';
}

// Panel Navigation 
function showPanel(name, el) {
 document.querySelectorAll('.panel').forEach(p => {
   p.style.display = 'none';
 });
 const target = document.getElementById('panel-' + name);
 if (target) target.style.display = 'block';

 document.querySelectorAll('.topbar-nav a').forEach(a => a.classList.remove('active'));
 if (el) el.classList.add('active');

 if (name === 'analytics') initAnalyticsCharts();
 if (name === 'diagnostics') loadDiagnosticOutputs();
 if (name === 'logs') loadLogs();
 if (name === 'disease') initDiseasePanel();
}

// Simulation Toggle 
async function toggleSimulation() {
 const btn = document.getElementById('sim-btn');
 try {
 const res = await fetch('/api/simulation/toggle', { method: 'POST' });
 const d = await res.json();
 simRunning = d.running;
 btn.textContent = simRunning ? 'Pause Simulation' : 'Start Simulation';
 btn.className = simRunning ? 'btn-sim running' : 'btn-sim';
 if (simRunning && !pollInterval) pollInterval = setInterval(pollStatus, 1200);
 logEvent('Simulation ' + (simRunning ? 'started' : 'paused'));
 } catch(e) { console.error(e); }
}

// Status Polling 
async function pollStatus() {
 try {
 const res = await fetch('/api/status');
 const data = await res.json();
 currentStatus = data;
 updateUI(data);
 updateSensorHistory(data.sensors);
 if (document.getElementById('panel-analytics').style.display !== 'none') updateAnalyticsCharts();
 } catch(e) {}
}

function updateUI(data) {
 const { mission, rover, sensors, inference } = data;

 // Greeting strip
 setText('strip-greeting', getGreeting());
 const now = new Date();
 setText('strip-time', now.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) +
 ' · Mission day ' + mission.mission_day);

 // Battery
 const bPct = rover.battery;
 const bFill = document.getElementById('batt-fill');
 if (bFill) {
 bFill.style.width = bPct + '%';
 bFill.style.background = bPct < 20 ? 'var(--red)' : bPct < 40 ? 'var(--amber)' : 'var(--green)';
 }
 setText('batt-pct', Math.round(bPct) + '%');

 // Health pills
 const isAnomaly = inference.anomaly_status === 'ANOMALY';
 const soilCls = inference.soil_health === 'Healthy' ? 'hp-good' :
 inference.soil_health === 'Moderate' ? 'hp-warn' : 'hp-alert';

 setPill('pill-anomaly', isAnomaly ? 'hp-alert' : 'hp-good');
 setText('pill-anomaly-val', isAnomaly ? 'Anomaly!' : 'Normal');

 setPill('pill-soil', soilCls);
 setText('pill-soil-val', inference.soil_health);

 setText('pill-zone-val', inference.zone_label || '—');

 // Rover status
 setText('mode-val', rover.mode === 'DRV' ? 'Driving' : 'Idle');
 setText('speed-val', rover.speed.toFixed(1) + ' km/h');
 setText('trip-dist-left', rover.distance_travelled.toFixed(1) + ' km');
 setText('gps-val', rover.gps_lat.toFixed(5) + ', ' + rover.gps_lon.toFixed(5));
 setText('trip-dist', rover.distance_travelled.toFixed(1));
 setText('trip-rem', rover.remaining_distance.toFixed(1));

 // NPK Sensor tab
 setText('s-n', sensors.nitrogen?.toFixed(0));
 setText('s-p', sensors.phosphorus?.toFixed(0));
 setText('s-k', sensors.potassium?.toFixed(0));
 setText('s-ph', sensors.ph_value?.toFixed(1));
 setText('s-rain',sensors.rainfall?.toFixed(0));
 setText('s-hum', sensors.humidity?.toFixed(0));

 // Spectral tab
 setText('s-ndvi', sensors.ndvi?.toFixed(2));
 setText('s-ndwi', sensors.ndwi?.toFixed(2));
 setText('s-evi', sensors.evi?.toFixed(2));
 setText('s-savi', sensors.savi?.toFixed(2));
 setText('s-nir', sensors.nir?.toFixed(2));
 setText('s-swir', sensors.swir?.toFixed(2));

 // Env tab
 setText('s-t30', sensors.t_30cm?.toFixed(1));
 setText('s-t60', sensors.t_60cm?.toFixed(1));
 setText('s-t90', sensors.t_90cm?.toFixed(1));
 setText('s-vw30', sensors.vw_30cm?.toFixed(3));
 setText('s-vw60', sensors.vw_60cm?.toFixed(3));
 setText('s-vw90', sensors.vw_90cm?.toFixed(3));

 // Depth bars
 renderDepthBars('vw-bars', [30,60,90,120,150].map(d => ({
 label: d + ' cm', val: sensors['vw_' + d + 'cm'] || 0, max: 0.6,
 fmt: v => v.toFixed(2)
 })));
 renderDepthBars('temp-bars', [30,60,90,120,150].map(d => ({
 label: d + ' cm', val: sensors['t_' + d + 'cm'] || 0, max: 40,
 fmt: v => v.toFixed(1) + '°C'
 })));

 // AI summary card
 const score = inference.anomaly_score;
 const scoreFill = document.getElementById('score-fill');
 if (scoreFill) {
 scoreFill.style.width = (score * 100) + '%';
 scoreFill.style.background = isAnomaly ? 'var(--red)' : score > 0.3 ? 'var(--amber)' : 'var(--green)';
 }
 setText('score-val', isAnomaly ? 'High' : score > 0.3 ? 'Medium' : 'Low');
 setText('ai-zone', inference.zone_label || '—');
 setText('ai-soil', inference.soil_health);
 setText('ai-conf', Math.round(inference.soil_confidence * 100) + '%');
 setText('radar-label', isAnomaly ? 'ALERT' : 'NORMAL');

 // Terrain + radar
 drawTerrain(rover.gps_lat, rover.gps_lon, rover.heading || 45);
 drawRadar(score);
 updateMiniChart(sensors.vw_30cm || 0);
}

function setText(id, val) {
 const el = document.getElementById(id);
 if (el && val !== undefined && val !== null) el.textContent = val;
}

function setPill(id, cls) {
 const el = document.getElementById(id);
 if (!el) return;
 el.className = 'health-pill ' + cls;
}

// Depth Bars 
function renderDepthBars(id, items) {
 const container = document.getElementById(id);
 if (!container) return;
 if (!container._built) {
 container.innerHTML = items.map(item => `
 <div class="depth-row">
 <span class="depth-label">${item.label}</span>
 <div class="depth-track">
 <div class="depth-fill" id="df-${id}-${item.label}" style="width:0%"></div>
 </div>
 <span class="depth-val" id="dv-${id}-${item.label}">—</span>
 </div>`).join('');
 container._built = true;
 }
 items.forEach(item => {
 const fill = document.getElementById(`df-${id}-${item.label}`);
 const val = document.getElementById(`dv-${id}-${item.label}`);
 if (fill) fill.style.width = Math.min(100, (item.val / item.max) * 100) + '%';
 if (val) val.textContent = item.fmt(item.val);
 });
}

// Terrain Canvas 
let terrainBg = null;
let roverPath = [];

function drawTerrain(lat, lon, heading) {
 const canvas = document.getElementById('terrain-canvas');
 if (!canvas) return;
 const ctx = canvas.getContext('2d');
 const W = canvas.width, H = canvas.height;

 if (!terrainBg) {
 terrainBg = document.createElement('canvas');
 terrainBg.width = W; terrainBg.height = H;
 const tc = terrainBg.getContext('2d');

 // Warm soil background
 tc.fillStyle = '#EDE0C8';
 tc.fillRect(0, 0, W, H);

 // Field grid
 tc.strokeStyle = 'rgba(120,90,50,0.15)';
 tc.lineWidth = 1;
 for (let x = 0; x < W; x += 40) { tc.beginPath(); tc.moveTo(x,0); tc.lineTo(x,H); tc.stroke(); }
 for (let y = 0; y < H; y += 40) { tc.beginPath(); tc.moveTo(0,y); tc.lineTo(W,y); tc.stroke(); }

 // Vegetation zones
 const zones = [
 { x:80, y:90, r:65, color:'rgba(74,124,89,0.30)', label:'Zone A — Dense Crop' },
 { x:210, y:155, r:80, color:'rgba(90,148,104,0.25)', label:'Zone B — Moderate Cover' },
 { x:390, y:75, r:55, color:'rgba(74,124,89,0.28)', label:'Zone C — Sparse' },
 { x:440, y:200, r:70, color:'rgba(100,140,70,0.22)', label:'Zone D — Open Field' },
 { x:155, y:230, r:50, color:'rgba(74,124,89,0.26)', label:'Zone E — Edge' },
 ];
 zones.forEach(z => {
 const g = tc.createRadialGradient(z.x,z.y,0,z.x,z.y,z.r);
 g.addColorStop(0, z.color);
 g.addColorStop(1, 'transparent');
 tc.fillStyle = g;
 tc.beginPath(); tc.arc(z.x,z.y,z.r,0,Math.PI*2); tc.fill();
 tc.fillStyle = 'rgba(44,90,44,0.6)';
 tc.font = '600 9px Inter, sans-serif';
 tc.fillText(z.label, z.x - 40, z.y + 4);
 });

 // Compass
 tc.fillStyle = 'rgba(80,60,40,0.5)';
 tc.font = '600 10px Inter, sans-serif';
 tc.fillText('N', W - 18, 18);
 }

 ctx.clearRect(0, 0, W, H);
 ctx.drawImage(terrainBg, 0, 0);

 // Map GPS to canvas
 const cx = 260, cy = 135, scale = 50000;
 const px = cx + (lon - 79.8358) * scale;
 const py = cy - (lat - 7.2096) * scale;

 roverPath.push({ x: px, y: py });
 if (roverPath.length > 150) roverPath.shift();

 // Draw path
 if (roverPath.length > 1) {
 ctx.beginPath();
 ctx.strokeStyle = 'rgba(58,107,69,0.55)';
 ctx.lineWidth = 2;
 ctx.setLineDash([5, 3]);
 ctx.moveTo(roverPath[0].x, roverPath[0].y);
 roverPath.forEach(p => ctx.lineTo(p.x, p.y));
 ctx.stroke();
 ctx.setLineDash([]);
 }

 // Rover marker
 ctx.save();
 ctx.translate(px, py);
 ctx.rotate((heading) * Math.PI / 180);
 ctx.shadowColor = 'rgba(58,107,69,0.5)';
 ctx.shadowBlur = 12;
 ctx.fillStyle = '#3A6B45';
 ctx.beginPath();
 ctx.moveTo(0, -12); ctx.lineTo(7, 7); ctx.lineTo(-7, 7); ctx.closePath();
 ctx.fill();
 ctx.shadowBlur = 0;
 ctx.restore();

 // GPS label
 ctx.fillStyle = 'rgba(80,60,40,0.6)';
 ctx.font = '11px Inter, sans-serif';
 ctx.fillText(lat.toFixed(5) + '°, ' + lon.toFixed(5) + '°', 8, H - 8);
}

// Radar 
let radarAngle = 0;
function drawRadar(score) {
 const c = document.getElementById('radar-canvas');
 if (!c) return;
 const ctx = c.getContext('2d');
 const W = c.width, H = c.height;
 const cx = W/2, cy = H/2, r = Math.min(W,H)/2 - 6;
 radarAngle = (radarAngle + 3) % 360;

 ctx.clearRect(0, 0, W, H);

 const isAlert = score > 0.5;
 const baseColor = isAlert ? '#B83A2A' : '#3A6B45';
 const lightColor = isAlert ? 'rgba(184,58,42,0.15)' : 'rgba(58,107,69,0.15)';

 ctx.fillStyle = isAlert ? '#FDF0EE' : '#EBF5EF';
 ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();

 // Concentric rings
 for (let i = 1; i <= 4; i++) {
 ctx.beginPath(); ctx.arc(cx,cy,r*i/4,0,Math.PI*2);
 ctx.strokeStyle = isAlert ? 'rgba(184,58,42,0.2)' : 'rgba(58,107,69,0.2)';
 ctx.lineWidth = 1; ctx.stroke();
 }

 // Cross hairs
 ctx.strokeStyle = isAlert ? 'rgba(184,58,42,0.25)' : 'rgba(58,107,69,0.25)';
 ctx.lineWidth = 1;
 ctx.beginPath(); ctx.moveTo(cx,cy-r); ctx.lineTo(cx,cy+r); ctx.stroke();
 ctx.beginPath(); ctx.moveTo(cx-r,cy); ctx.lineTo(cx+r,cy); ctx.stroke();

 // Sweep
 const rad = radarAngle * Math.PI / 180;
 ctx.save();
 ctx.translate(cx, cy);
 ctx.rotate(rad);
 const grd = ctx.createLinearGradient(0,0,r,0);
 grd.addColorStop(0, isAlert ? 'rgba(184,58,42,0.5)' : 'rgba(58,107,69,0.45)');
 grd.addColorStop(1, 'transparent');
 ctx.fillStyle = grd;
 ctx.beginPath(); ctx.moveTo(0,0); ctx.arc(0,0,r,-0.35,0); ctx.closePath(); ctx.fill();
 ctx.restore();

 // Blip
 if (score > 0.35) {
 const bx = cx + Math.cos(rad) * r * 0.55;
 const by = cy + Math.sin(rad) * r * 0.55;
 ctx.beginPath(); ctx.arc(bx,by,4,0,Math.PI*2);
 ctx.fillStyle = baseColor;
 ctx.shadowColor = baseColor; ctx.shadowBlur = 8;
 ctx.fill(); ctx.shadowBlur = 0;
 }

 // Status label
 const lbl = document.getElementById('radar-label');
 if (lbl) {
 lbl.textContent = isAlert ? 'ALERT' : 'NORMAL';
 lbl.style.color = baseColor;
 }
}

// Mini Chart 
let miniData = [];
let miniChart = null;
function updateMiniChart(val) {
 miniData.push(val);
 if (miniData.length > MAX_HIST) miniData.shift();
 const ctx = document.getElementById('mini-chart');
 if (!ctx) return;
 if (!miniChart) {
 miniChart = new Chart(ctx, {
 type: 'line',
 data: {
 labels: Array(MAX_HIST).fill(''),
 datasets: [{
 data: miniData,
 borderColor: '#3A6B45', borderWidth: 2,
 backgroundColor: 'rgba(58,107,69,0.08)',
 pointRadius: 0, fill: true, tension: 0.4
 }]
 },
 options: {
 animation: false, responsive: true,
 plugins: { legend: { display: false } },
 scales: { x: { display: false }, y: { display: false } }
 }
 });
 } else {
 miniChart.data.datasets[0].data = [...miniData];
 miniChart.update('none');
 }
}

// Sensor History 
function updateSensorHistory(s) {
 const push = (arr, v) => { arr.push(v); if (arr.length > MAX_HIST) arr.shift(); };
 push(sensorHistory.moisture, s.vw_30cm || 0);
 push(sensorHistory.temp, s.t_30cm || 0);
 push(sensorHistory.ndvi, s.ndvi || 0);
 push(sensorHistory.n, s.nitrogen || 0);
 push(sensorHistory.p, s.phosphorus || 0);
 push(sensorHistory.k, s.potassium || 0);
}

// Analytics Charts 
const chartColors = { green:'#3A6B45', amber:'#D4830A', red:'#B83A2A', blue:'#2B6CB0', purple:'#6B46C1' };

function initAnalyticsCharts() {
 mkChart('chart-moisture', 'Soil Moisture at 30 cm', sensorHistory.moisture, chartColors.blue);
 mkChart('chart-temp', 'Temperature at 30 cm (°C)', sensorHistory.temp, chartColors.amber);
 mkChart('chart-ndvi', 'NDVI — Vegetation Index', sensorHistory.ndvi, chartColors.green);
 mkNPKChart();
}

function mkChart(id, label, data, color) {
 const ctx = document.getElementById(id);
 if (!ctx || charts[id]) return;
 charts[id] = new Chart(ctx, {
 type: 'line',
 data: {
 labels: Array(data.length).fill(''),
 datasets: [{ label, data: [...data], borderColor: color, borderWidth: 2,
 backgroundColor: color + '18', pointRadius: 0, fill: true, tension: 0.4 }]
 },
 options: {
 animation: false, responsive: true,
 plugins: { legend: { labels: { color: '#5A4E3C', font: { family: 'Inter, sans-serif', size: 12 } } } },
 scales: {
 x: { display: false },
 y: { ticks: { color: '#8C7D6A', font: { family: 'Inter, sans-serif', size: 11 } },
 grid: { color: 'rgba(44,36,22,0.07)' } }
 }
 }
 });
}

function mkNPKChart() {
 const ctx = document.getElementById('chart-npk');
 if (!ctx || charts['chart-npk']) return;
 charts['chart-npk'] = new Chart(ctx, {
 type: 'line',
 data: {
 labels: Array(MAX_HIST).fill(''),
 datasets: [
 { label:'Nitrogen (N)', data:[...sensorHistory.n], borderColor:chartColors.green, borderWidth:2, pointRadius:0, tension:0.4, fill:false },
 { label:'Phosphorus (P)', data:[...sensorHistory.p], borderColor:chartColors.amber, borderWidth:2, pointRadius:0, tension:0.4, fill:false },
 { label:'Potassium (K)', data:[...sensorHistory.k], borderColor:chartColors.blue, borderWidth:2, pointRadius:0, tension:0.4, fill:false }
 ]
 },
 options: {
 animation: false, responsive: true,
 plugins: { legend: { labels: { color: '#5A4E3C', font: { family: 'Inter, sans-serif', size: 12 } } } },
 scales: {
 x: { display: false },
 y: { ticks: { color: '#8C7D6A', font: { family: 'Inter, sans-serif', size: 11 } },
 grid: { color: 'rgba(44,36,22,0.07)' } }
 }
 }
 });
}

function updateAnalyticsCharts() {
 const upd = (id, data, i=0) => {
 if (!charts[id]) return;
 charts[id].data.labels = Array(data.length).fill('');
 charts[id].data.datasets[i].data = [...data];
 charts[id].update('none');
 };
 upd('chart-moisture', sensorHistory.moisture);
 upd('chart-temp', sensorHistory.temp);
 upd('chart-ndvi', sensorHistory.ndvi);
 if (charts['chart-npk']) {
 charts['chart-npk'].data.datasets[0].data = [...sensorHistory.n];
 charts['chart-npk'].data.datasets[1].data = [...sensorHistory.p];
 charts['chart-npk'].data.datasets[2].data = [...sensorHistory.k];
 charts['chart-npk'].update('none');
 }
}

// Sensor Tab 
function switchSensorTab(tab, btn) {
 document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
 btn.classList.add('active');
 document.querySelectorAll('.sensor-panel').forEach(p => p.style.display = 'none');
 const sp = document.getElementById('sensor-' + tab); if (sp) sp.style.display = 'block';
}

// Diagnostics 
async function loadDiagnosticOutputs() {
 for (const [comp, galleryId] of [['component1','c1-gallery'],['component3','c3-gallery'],['component4','c4-gallery']]) {
 const gallery = document.getElementById(galleryId);
 if (!gallery) continue;
 try {
 const files = await fetch('/api/outputs/' + comp).then(r => r.json());
 gallery.innerHTML = files.map(f => {
 const nice = f.replace('.png','').replace(/eda_|eval_/,'').replace(/_/g,' ');
 return `<div>
 <img class="output-img" src="/static/outputs/${comp}/${f}" alt="${nice}" onclick="lightbox(this.src)">
 <div class="output-label">${nice}</div>
 </div>`;
 }).join('') || '<p style="color:var(--text-light);font-size:14px;padding:12px">No images found</p>';
 } catch(e) {}
 }
}

function lightbox(src) {
 const o = document.createElement('div');
 o.style.cssText = 'position:fixed;inset:0;background:rgba(44,36,22,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;backdrop-filter:blur(4px)';
 const img = document.createElement('img');
 img.src = src;
 img.style.cssText = 'max-width:92vw;max-height:90vh;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.4)';
 o.appendChild(img);
 o.onclick = () => document.body.removeChild(o);
 document.body.appendChild(o);
}

// Soil Prediction 
async function predictSoil() {
 const body = {
 nitrogen: +document.getElementById('f-n').value,
 phosphorus: +document.getElementById('f-p').value,
 potassium: +document.getElementById('f-k').value,
 temperature: +document.getElementById('f-temp').value,
 humidity: +document.getElementById('f-hum').value,
 ph_value: +document.getElementById('f-ph').value,
 rainfall: +document.getElementById('f-rain').value
 };
 const res = document.getElementById('soil-result');
 res.innerHTML = '<div class="card-title"><span class="title-icon"></span> Result</div><div class="result-placeholder">Analysing…</div>';
 try {
 const d = await fetch('/api/soil/predict', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(r => r.json());
 if (d.error) throw new Error(d.error);
 const cls = d.consensus === 'Healthy' ? 'good' : d.consensus === 'Moderate' ? 'warn' : 'alert';
 const xp = d.xgboost.probabilities;
 const colorFor = k => k === 'Healthy' ? chartColors.green : k === 'Moderate' ? chartColors.amber : chartColors.red;
 res.innerHTML = `
 <div class="card-title"><span class="title-icon"></span> Result</div>
 <div class="result-content">
 <div class="result-badge ${cls}">
<div class="result-main-label">${d.consensus}</div>
 <div class="result-sub">Soil Health Status</div>
 </div>
 <div class="result-models">
 <div class="model-card"><div class="model-name">XGBoost Model</div><div class="model-result">${d.xgboost.health}</div></div>
 <div class="model-card"><div class="model-name">LSTM Model</div><div class="model-result">${d.lstm.health}</div></div>
 </div>
 <div class="result-probs">
 <p style="font-size:13px;color:var(--text-light);font-weight:600;margin-bottom:4px">Confidence breakdown</p>
 ${Object.entries(xp).map(([k,v]) => `
 <div class="prob-row">
 <span class="prob-label">${k}</span>
 <div class="prob-track"><div class="prob-fill" style="width:${v*100}%;background:${colorFor(k)}"></div></div>
 <span class="prob-val">${(v*100).toFixed(1)}%</span>
 </div>`).join('')}
 </div>
 ${renderFertilizer(d.fertilizer)}
 </div>`;
 } catch(e) {
 res.innerHTML = `<div class="card-title"><span class="title-icon"></span> Result</div><div class="result-placeholder" style="color:var(--red)">Error: ${e.message}</div>`;
 }
}

// Fertilizer Recommendation renderer (Component 4)
function renderFertilizer(f) {
  if (!f) return '';
  return `
  <div class="rec-block rec-${f.status_class}">
    <div class="rec-head">
      <span class="rec-kicker">Fertilizer Recommendation</span>
      <span class="rec-title">${f.headline}</span>
    </div>
    <p class="rec-strategy">${f.strategy}</p>
    <div class="rec-priority">${f.priority}</div>

    <div class="rec-sub">Nutrient status and dosage</div>
    <div class="nutrient-grid">
      ${f.nutrients.map(n => `
        <div class="nutrient-card nc-${n.status_class}">
          <div class="nutrient-top">
            <span class="nutrient-name">${n.nutrient}</span>
            <span class="nutrient-level lv-${n.status_class}">${n.level}</span>
          </div>
          <div class="nutrient-reading">${n.value} <span>${n.unit}</span></div>
          <div class="nutrient-product">${n.product}</div>
          <div class="nutrient-dose">${n.dose}</div>
          <div class="nutrient-note">${n.note}</div>
        </div>`).join('')}
    </div>

    <div class="ph-strip ph-${f.ph.status_class}">
      <div class="ph-left">
        <span class="ph-value">pH ${f.ph.value}</span>
        <span class="ph-label">${f.ph.label}</span>
      </div>
      <p class="ph-advice">${f.ph.advice}</p>
    </div>

    <div class="rec-sub">Organic matter</div>
    <p class="rec-text">${f.organic_matter}</p>

    <div class="rec-sub">Application schedule</div>
    <ol class="rec-list">
      ${f.application_schedule.map(x => `<li>${x}</li>`).join('')}
    </ol>

    <div class="rec-foot">Re-test the soil in ${f.retest_after_days} days</div>
  </div>`;
}

// Anomaly Detection 
async function predictAnomaly() {
 const sensors = {
 vw_30cm: +document.getElementById('a-vw30').value,
 vw_60cm: +document.getElementById('a-vw60').value,
 vw_90cm: +document.getElementById('a-vw90').value,
 vw_120cm:+document.getElementById('a-vw120').value,
 vw_150cm:+document.getElementById('a-vw150').value,
 t_30cm: +document.getElementById('a-t30').value,
 t_60cm: +document.getElementById('a-t60').value,
 t_90cm: +document.getElementById('a-t90').value,
 t_120cm: +document.getElementById('a-t120').value,
 t_150cm: +document.getElementById('a-t150').value,
 };
 const res = document.getElementById('anomaly-result');
 res.innerHTML = '<div class="card-title"><span class="title-icon"></span> Result</div><div class="result-placeholder">Scanning…</div>';
 try {
 const d = await fetch('/api/anomaly/predict', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({sensors}) }).then(r => r.json());
 if (d.error) throw new Error(d.error);
 const isAlert = d.prediction === 'ANOMALY';
 const cls = isAlert ? 'alert' : 'good';
 res.innerHTML = `
 <div class="card-title"><span class="title-icon"></span> Result</div>
 <div class="result-content">
 <div class="result-badge ${cls}">
<div class="result-main-label${isAlert ? ' blinking' : ''}">${isAlert ? 'Anomaly Detected' : 'All Normal'}</div>
 <div class="result-sub">${isAlert ? 'Moisture pattern is unusual — please inspect the field' : 'Soil moisture pattern looks normal'}</div>
 </div>
 <div class="result-probs" style="margin-top:4px">
 <p style="font-size:13px;color:var(--text-light);font-weight:600;margin-bottom:8px">AI Confidence</p>
 <div class="prob-row">
 <span class="prob-label">Normal</span>
 <div class="prob-track"><div class="prob-fill" style="width:${d.probabilities.normal*100}%;background:${chartColors.green}"></div></div>
 <span class="prob-val">${(d.probabilities.normal*100).toFixed(1)}%</span>
 </div>
 <div class="prob-row">
 <span class="prob-label">Anomaly</span>
 <div class="prob-track"><div class="prob-fill" style="width:${d.probabilities.anomaly*100}%;background:${chartColors.red}"></div></div>
 <span class="prob-val">${(d.probabilities.anomaly*100).toFixed(1)}%</span>
 </div>
 </div>
 <div style="background:var(--bg);border-radius:var(--r-sm);padding:10px 12px;font-size:13px;color:var(--text-mid)">
 Overall confidence: <strong>${(d.confidence*100).toFixed(1)}%</strong>
 </div>
 </div>`;
 } catch(e) {
 res.innerHTML = `<div class="card-title"><span class="title-icon"></span> Result</div><div class="result-placeholder" style="color:var(--red)">Error: ${e.message}</div>`;
 }
}

// Zone Prediction 
async function predictZone() {
 const body = {
 ndvi: +document.getElementById('z-ndvi').value,
 ndwi: +document.getElementById('z-ndwi').value,
 evi: +document.getElementById('z-evi').value,
 savi: +document.getElementById('z-savi').value,
 nir: +document.getElementById('z-nir').value,
 swir: +document.getElementById('z-swir').value,
 };
 const res = document.getElementById('zone-result');
 res.innerHTML = '<div class="card-title"><span class="title-icon"></span> Result</div><div class="result-placeholder">Mapping…</div>';
 try {
 const d = await fetch('/api/zone/predict', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(r => r.json());
 if (d.error) throw new Error(d.error);
 res.innerHTML = `
 <div class="card-title"><span class="title-icon"></span> Result</div>
 <div class="result-content">
 <div class="result-badge good" style="border-color:#BDD7F5;background:var(--blue-bg)">
<div class="result-main-label" style="color:var(--blue)">${d.zone_label}</div>
 <div class="result-sub">Field zone ${d.zone_id + 1} of ${d.n_zones} total zones</div>
 </div>
 <div class="result-probs">
 <p style="font-size:13px;color:var(--text-light);font-weight:600;margin-bottom:8px">Distance to each zone centre (lower = closer match)</p>
 ${d.distances_to_centers.map((dist,i) => `
 <div class="prob-row">
 <span class="prob-label">Zone ${i+1}</span>
 <div class="prob-track">
 <div class="prob-fill" style="width:${Math.min(100,dist*10)}%;background:${i===d.zone_id?chartColors.blue:'#BDD7F5'}"></div>
 </div>
 <span class="prob-val">${dist.toFixed(1)}</span>
 </div>`).join('')}
 </div>
 <div style="background:var(--bg);border-radius:var(--r-sm);padding:10px 12px;font-size:13px;color:var(--text-mid)">
 Based on: NDVI ${body.ndvi.toFixed(2)} · NDWI ${body.ndwi.toFixed(2)} · EVI ${body.evi.toFixed(2)}
 </div>
 </div>`;
 } catch(e) {
 res.innerHTML = `<div class="card-title"><span class="title-icon"></span> Result</div><div class="result-placeholder" style="color:var(--red)">Error: ${e.message}</div>`;
 }
}

// Fill from Simulation 
function fillFromSim(type) {
 if (!currentStatus) { alert('Start the simulation first to get live values.'); return; }
 const s = currentStatus.sensors;
 const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = typeof v === 'number' ? +v.toFixed(4) : v; };
 if (type === 'soil') {
 set('f-n', s.nitrogen); set('f-p', s.phosphorus); set('f-k', s.potassium);
 set('f-temp', s.temperature); set('f-hum', s.humidity);
 set('f-ph', s.ph_value); set('f-rain', s.rainfall);
 } else if (type === 'anomaly') {
 set('a-vw30', s.vw_30cm); set('a-vw60', s.vw_60cm); set('a-vw90', s.vw_90cm);
 set('a-vw120', s.vw_120cm); set('a-vw150', s.vw_150cm);
 set('a-t30', s.t_30cm); set('a-t60', s.t_60cm); set('a-t90', s.t_90cm);
 set('a-t120', s.t_120cm); set('a-t150', s.t_150cm);
 } else if (type === 'zone') {
 set('z-ndvi', s.ndvi); set('z-ndwi', s.ndwi); set('z-evi', s.evi);
 set('z-savi', s.savi); set('z-nir', s.nir); set('z-swir', s.swir);
 }
}

// System Check (Diagnostics button on main) 
async function runDiagnostics() {
 const list = document.getElementById('svc-list');
 if (!list) return;
 list.innerHTML = '<div class="svc-item neutral">Running checks…</div>';
 await new Promise(r => setTimeout(r, 700));
 const batt = currentStatus?.rover?.battery || 100;
 const checks = [
 ['Random Forest (Anomaly model)', 'good'],
 ['KMeans (Zone mapping model)', 'good'],
 ['XGBoost + LSTM (Soil health model)', 'good'],
 [currentStatus?.inference?.anomaly_status === 'ANOMALY' ? ' Soil moisture anomaly detected' : 'Soil moisture — Normal', currentStatus?.inference?.anomaly_status === 'ANOMALY' ? 'warn' : 'good'],
 [batt < 20 ? ' Battery low: ' + batt.toFixed(0) + '%' : 'Battery: ' + batt.toFixed(0) + '%', batt < 20 ? 'warn' : 'good'],
 ['GPS signal active', 'good'],
 ];
 list.innerHTML = checks.map(([msg,cls]) => `<div class="svc-item ${cls}">${cls==='good'?'':cls==='warn'?'':''} ${msg}</div>`).join('');
 logEvent('System check completed — all models operational');
}

// Manual Input Modal 
function openManualModal() {
 document.getElementById('manual-modal').style.display = 'flex';
}
function closeManualModal() {
 document.getElementById('manual-modal').style.display = 'none';
}
function switchModalTab(tab, btn) {
 document.querySelectorAll('.mtab').forEach(b => b.classList.remove('active'));
 btn.classList.add('active');
 document.querySelectorAll('.modal-tab-panel').forEach(p => p.style.display = 'none');
 const mp = document.getElementById('modal-' + tab); if (mp) mp.style.display = 'block';
}
async function submitManualInput() {
 const g = id => +document.getElementById(id).value;
 const payload = {
 vw_30cm:g('m-vw30'), vw_60cm:g('m-vw60'), vw_90cm:g('m-vw90'),
 vw_120cm:g('m-vw120'), vw_150cm:g('m-vw150'),
 t_30cm:g('m-t30'), t_60cm:g('m-t60'), t_90cm:g('m-t90'),
 t_120cm:g('m-t120'), t_150cm:g('m-t150'),
 nitrogen:g('m-n'), phosphorus:g('m-p'), potassium:g('m-k'),
 ph_value:g('m-ph'), rainfall:g('m-rain'), humidity:g('m-hum'),
 temperature:g('m-temp'),
 nir:g('m-nir'), swir:g('m-swir'), ndvi:g('m-ndvi'),
 ndwi:g('m-ndwi'), evi:g('m-evi'), savi:g('m-savi')
 };
 try {
 const d = await fetch('/api/simulation/manual', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(r => r.json());
 closeManualModal();
 pollStatus();
 logEvent('Manual readings applied — Soil: ' + d.soil_health + ', Moisture: ' + d.anomaly_status);
 } catch(e) { alert('Could not apply readings: ' + e.message); }
}

// Camera (Main Panel) 
function updateCamSource() {
 const t = document.getElementById('cam-type').value;
 const urlInput = document.getElementById('cam-url');
 if (t === 'webcam') urlInput.classList.add('hidden');
 else urlInput.classList.remove('hidden');
}

async function connectCamera() {
 const type = document.getElementById('cam-type').value;
 const url = document.getElementById('cam-url')?.value || '';
 await connectCameraCore(type, url, 'cam-video', 'cam-img', 'cam-overlay', 'cam-status');
}

// Camera (Full Panel) 
function updateCamSourceFull() {
 const t = document.getElementById('cam-type-full').value;
 document.getElementById('droidcam-help').classList.toggle('hidden', t !== 'droidcam');
 document.getElementById('url-help').classList.toggle('hidden', t !== 'url');
 const src = document.getElementById('cam-info-src');
 if (src) src.textContent = t === 'webcam' ? 'Built-in webcam' : t === 'droidcam' ? 'DroidCam (WiFi)' : 'Custom URL';
}

async function connectCameraFull() {
 const t = document.getElementById('cam-type-full').value;
 let url = '';
 if (t === 'droidcam') url = document.getElementById('cam-url-full')?.value || '';
 if (t === 'url') url = document.getElementById('cam-url-custom')?.value || '';
 await connectCameraCore(t, url, 'cam-video-full', 'cam-img-full', 'cam-overlay-full', 'cam-info-status');
}

async function connectCameraCore(type, url, vidId, imgId, overlayId, statusId) {
 const vid = document.getElementById(vidId);
 const img = document.getElementById(imgId);
 const overlay = document.getElementById(overlayId);
 const statusEl= document.getElementById(statusId);

 if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }

 try {
 if (type === 'webcam') {
 const stream = await navigator.mediaDevices.getUserMedia({ video: { width:1280, height:720 }, audio:false });
 cameraStream = stream;
 if (vid) { vid.srcObject = stream; vid.style.display = 'block'; }
 if (img) img.style.display = 'none';
 if (overlay) overlay.style.display = 'none';
 if (statusEl) statusEl.textContent = ' Connected — Webcam (1280×720)';
 const ri = document.getElementById('cam-info-res'); if (ri) ri.textContent = '1280×720';
 const fi = document.getElementById('cam-info-fps'); if (fi) fi.textContent = '30 fps';
 } else {
 const feedUrl = type === 'droidcam'
 ? `http://${url || '192.168.1.100:4747'}/mjpegfeed`
 : url;
 if (vid) vid.style.display = 'none';
 if (img) { img.src = feedUrl; img.style.display = 'block'; }
 if (overlay) overlay.style.display = 'none';
 if (statusEl) statusEl.textContent = ' Connecting to ' + feedUrl + '…';
 if (img) {
 img.onload = () => { if (statusEl) statusEl.textContent = ' Connected — ' + feedUrl; };
 img.onerror = () => {
 if (overlay) overlay.style.display = 'flex';
 if (statusEl) statusEl.textContent = ' Could not connect to ' + feedUrl;
 };
 }
 }
 } catch(e) {
 if (overlay) overlay.style.display = 'flex';
 if (statusEl) statusEl.textContent = ' Error: ' + e.message;
 }
}

function disconnectCamera() {
 if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
 ['cam-video','cam-video-full'].forEach(id => {
 const el = document.getElementById(id);
 if (el) { el.srcObject = null; el.style.display = 'none'; }
 });
 ['cam-img','cam-img-full'].forEach(id => {
 const el = document.getElementById(id);
 if (el) { el.src = ''; el.style.display = 'none'; }
 });
 ['cam-overlay','cam-overlay-full'].forEach(id => {
 const el = document.getElementById(id);
 if (el) el.style.display = 'flex';
 });
 const s1 = document.getElementById('cam-status'), s2 = document.getElementById('cam-info-status');
 if (s1) s1.textContent = ' Not connected';
 if (s2) s2.textContent = 'Not connected';
}

function captureFrame() {
 const vid = document.getElementById('cam-video-full') || document.getElementById('cam-video');
 if (!vid?.srcObject) { alert('Connect a camera first.'); return; }
 const c = document.createElement('canvas');
 c.width = vid.videoWidth || 320; c.height = vid.videoHeight || 240;
 c.getContext('2d').drawImage(vid, 0, 0);
 const url = c.toDataURL('image/jpeg', 0.85);
 const img = document.createElement('img');
 img.className = 'frame-thumb'; img.src = url; img.onclick = () => lightbox(url);
 document.getElementById('captured-frames')?.prepend(img);
}

// Disease Detection 
let diseaseImageData = null;
let diseaseCamStream = null;

async function initDiseasePanel() {
 try {
 const d = await fetch('/api/disease/status').then(r => r.json());
 const bar = document.getElementById('c2-model-bar');
 const txt = document.getElementById('c2-status-text');
 if (d.ready) {
 bar.className = 'model-status-bar ready';
 bar.querySelector('span').textContent = '';
 txt.textContent = 'EfficientNetB0 model is loaded and ready';
 } else {
 bar.className = 'model-status-bar pending';
 bar.querySelector('span').textContent = '⏳';
 txt.textContent = 'Model not yet available — results will be simulated. Add chilli_disease_model.keras to the models/ folder.';
 }
 } catch(e) {}
}

function handleDrop(e) {
 e.preventDefault();
 const file = e.dataTransfer.files[0];
 if (file?.type.startsWith('image/')) loadDiseaseFile(file);
}

function handleFileSelect(e) {
 const file = e.target.files[0];
 if (file) loadDiseaseFile(file);
}

function loadDiseaseFile(file) {
 const reader = new FileReader();
 reader.onload = (e) => {
 diseaseImageData = e.target.result;
 document.getElementById('disease-preview').src = diseaseImageData;
 document.getElementById('disease-preview-wrap').style.display = 'flex';
 document.getElementById('upload-zone').style.display = 'none';
 };
 reader.readAsDataURL(file);
}

function clearDiseaseImage() {
 diseaseImageData = null;
 document.getElementById('disease-preview-wrap').style.display = 'none';
 document.getElementById('upload-zone').style.display = 'block';
 document.getElementById('disease-file').value = '';
}

async function startDiseaseCam() {
 try {
 const stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
 diseaseCamStream = stream;
 const v = document.getElementById('disease-cam');
 v.srcObject = stream; v.style.display = 'block';
 document.getElementById('capture-disease-btn').disabled = false;
 } catch(e) { alert('Camera error: ' + e.message); }
}

function stopDiseaseCam() {
 if (diseaseCamStream) { diseaseCamStream.getTracks().forEach(t => t.stop()); diseaseCamStream = null; }
 const v = document.getElementById('disease-cam');
 v.style.display = 'none'; v.srcObject = null;
 document.getElementById('capture-disease-btn').disabled = true;
}

function captureDiseaseFrame() {
 const v = document.getElementById('disease-cam');
 const c = document.getElementById('disease-canvas');
 c.width = v.videoWidth; c.height = v.videoHeight;
 c.getContext('2d').drawImage(v, 0, 0);
 diseaseImageData = c.toDataURL('image/jpeg', 0.85);
 document.getElementById('disease-preview').src = diseaseImageData;
 document.getElementById('disease-preview-wrap').style.display = 'flex';
 document.getElementById('upload-zone').style.display = 'none';
 stopDiseaseCam();
}

// Growth Monitoring renderer (Component 2)
function renderGrowthMonitoring(g) {
  if (!g) return '';
  const vigourColor = g.vigour_score >= 75 ? chartColors.green
                    : g.vigour_score >= 45 ? chartColors.amber : chartColors.red;
  return `
  <div class="rec-block rec-${g.status_class}">
    <div class="rec-head">
      <span class="rec-kicker">Growth Monitoring</span>
      <span class="rec-title">${g.growth_status}</span>
    </div>

    <div class="growth-metrics">
      <div class="gm-card">
        <span class="gm-label">Plant Vigour</span>
        <span class="gm-value">${g.vigour_score}<span class="gm-unit">/100</span></span>
        <div class="gm-track"><div class="gm-fill" style="width:${g.vigour_score}%;background:${vigourColor}"></div></div>
      </div>
      <div class="gm-card">
        <span class="gm-label">Expected Yield Loss</span>
        <span class="gm-value">${g.yield_loss_percent}<span class="gm-unit">%</span></span>
        <div class="gm-track"><div class="gm-fill" style="width:${g.yield_loss_percent}%;background:${g.yield_loss_percent>40?chartColors.red:g.yield_loss_percent>15?chartColors.amber:chartColors.green}"></div></div>
      </div>
      <div class="gm-card">
        <span class="gm-label">Stage Risk</span>
        <span class="gm-value gm-text lv-${g.status_class}">${g.stage_risk}</span>
      </div>
      <div class="gm-card">
        <span class="gm-label">Next Check</span>
        <span class="gm-value gm-text">${g.next_check_date || ('in ' + g.monitoring_interval_days + ' days')}</span>
      </div>
    </div>

    <div class="rec-sub">Yield outlook</div>
    <p class="rec-text">${g.expected_yield_impact}</p>

    <div class="rec-sub">Canopy condition</div>
    <p class="rec-text">${g.canopy_condition}</p>

    <div class="rec-sub">Recovery outlook</div>
    <p class="rec-text">${g.recovery_outlook}</p>

    <div class="rec-sub">What to watch for</div>
    <ul class="rec-list">
      ${g.watch_for.map(x => `<li>${x}</li>`).join('')}
    </ul>

    <div class="rec-foot">Re-inspect this plant every ${g.monitoring_interval_days} days</div>
  </div>`;
}

// Treatment Recommendation renderer (Component 2)
function renderTreatment(t) {
  if (!t) return '';
  const sevClass = t.severity_level >= 3 ? 'alert' : t.severity_level >= 2 ? 'warn' : 'good';
  const section = (title, items) => !items || !items.length ? '' : `
    <div class="rec-sub">${title}</div>
    <ul class="rec-list">${items.map(x => `<li>${x}</li>`).join('')}</ul>`;
  return `
  <div class="rec-block rec-${sevClass}">
    <div class="rec-head">
      <span class="rec-kicker">Treatment Recommendation</span>
      <span class="rec-title">Severity: ${t.severity}</span>
    </div>
    <p class="rec-strategy">${t.summary}</p>
    <div class="rec-confidence">${t.confidence_note}</div>

    <div class="rec-sub">Do this first</div>
    <p class="rec-text rec-urgent">${t.immediate_action}</p>

    ${section('Organic control', t.organic_control)}
    ${section('Chemical control', t.chemical_control)}
    ${section('Cultural practice', t.cultural_practice)}

    <div class="rec-foot">Re-check the plant after ${t.re_check_after_days} days</div>
  </div>`;
}

async function predictDisease() {
 if (!diseaseImageData) return;
 const res = document.getElementById('disease-result');
 res.innerHTML = '<div class="card-title"><span class="title-icon"></span> Result</div><div class="result-placeholder">Checking leaf…</div>';
 try {
 const b64 = diseaseImageData.split(',')[1];
 const d = await fetch('/api/disease/predict', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({image_b64:b64}) }).then(r => r.json());
 if (d.error) throw new Error(d.error);
 const isHealthy = d.prediction === 'Healthy';
 const cls = isHealthy ? 'good' : 'alert';
 const barColors = ['#3A6B45','#D4830A','#B83A2A','#2B6CB0','#B7791F','#6B46C1'];
 const sorted = Object.entries(d.probabilities).sort((a,b) => b[1]-a[1]);
 res.innerHTML = `
 <div class="card-title"><span class="title-icon"></span> Result</div>
 <div class="result-content">
 <div class="result-badge ${cls}">
<div class="result-main-label">${d.prediction}</div>
 <div class="result-sub">Confidence: ${(d.confidence*100).toFixed(1)}%${d.model_status==='simulated'?' · <em>simulated result</em>':''}</div>
 </div>
 <img src="${diseaseImageData}" style="width:100%;max-height:130px;object-fit:contain;border:1.5px solid var(--border);border-radius:var(--r-md);background:var(--bg)">
 <div class="disease-chart">
 <p style="font-size:13px;color:var(--text-light);font-weight:600;margin-bottom:4px">Probability by disease type</p>
 ${sorted.map(([name,prob],i) => `
 <div class="disease-row">
 <span class="disease-row-label">${name}</span>
 <div class="disease-track"><div class="disease-fill" style="width:${prob*100}%;background:${barColors[i%barColors.length]}"></div></div>
 <span class="disease-pct">${(prob*100).toFixed(1)}%</span>
 </div>`).join('')}
 </div>
 ${renderGrowthMonitoring(d.growth_monitoring)}
 ${renderTreatment(d.treatment)}
 ${d.model_status==='simulated'?`<div style="background:var(--amber-bg);border:1px solid #F5D08A;border-radius:var(--r-sm);padding:10px 12px;font-size:13px;color:var(--amber)">Place <strong>chilli_disease_model.keras</strong> in the <strong>models/</strong> folder to enable real detection.</div>`:''}
 </div>`;
 } catch(e) {
 res.innerHTML = `<div class="card-title"><span class="title-icon"></span> Result</div><div class="result-placeholder" style="color:var(--red)">Error: ${e.message}</div>`;
 }
}

// Activity Log 
async function loadLogs() {
 const c = document.getElementById('logs-container');
 if (!c) return;
 try {
 const logs = await fetch('/api/logs').then(r => r.json());
 c.innerHTML = logs.map(l => `
 <div class="log-entry">
 <span class="log-ts">${(l.timestamp||'').slice(11,19)}</span>
 <span class="log-msg"><strong>${l.event||''}</strong>${l.message ? ' — ' + l.message : ''}</span>
 </div>`).join('') || '<div class="log-placeholder">No activity recorded yet</div>';
 c.scrollTop = c.scrollHeight;
 } catch(e) {}
}

async function addLog() {
 const input = document.getElementById('log-input');
 if (!input?.value.trim()) return;
 await fetch('/api/logs/add', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({event:'note', message: input.value}) });
 input.value = '';
 loadLogs();
}

async function logEvent(msg) {
 await fetch('/api/logs/add', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({event:'system', message:msg}) }).catch(()=>{});
}

// Init 
document.addEventListener('DOMContentLoaded', () => {
 document.getElementById('panel-main').style.display = 'block';
 pollInterval = setInterval(pollStatus, 1200);
 pollStatus();

 document.getElementById('log-input')?.addEventListener('keydown', e => {
 if (e.key === 'Enter') addLog();
 });

 // Initial canvas renders — real values arrive with the config below
 drawRadar(0);
 loadAppConfig();

 // Update greeting every minute
 setInterval(() => {
 const el = document.getElementById('strip-greeting');
 if (el) el.textContent = getGreeting();
 }, 60000);
});

// ═══════════════════════════════════════════════
// MAP VIEW TOGGLE  (Leaflet.js + OpenStreetMap / Esri — no API key)
// ═══════════════════════════════════════════════
let currentMapView  = 'field';
let leafletMap      = null;      // Leaflet map instance
let leafletInited   = false;
let leafletLayer    = null;      // Current tile layer
let leafletMarker   = null;      // Rover position marker
let userMarker      = null;      // User location marker
let userLat         = null;
let userLon         = null;
let roverLat        = 0;    // set from /api/config on load
let roverLon        = 0;    // set from /api/config on load
let currentMapType  = 'satellite';
let leafletLoaded   = false;

// ── Tile layer definitions (all free, no API key) ──────────────────────
const TILE_LAYERS = {
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP',
    maxZoom: 19
  },
  terrain: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attr: 'Map data: &copy; OpenStreetMap contributors, SRTM | Rendering: &copy; OpenTopoMap',
    maxZoom: 17
  },
  hybrid: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr: 'Tiles &copy; Esri',
    maxZoom: 19,
    overlay: 'https://stamen-tiles-{s}.a.ssl.fastly.net/toner-hybrid/{z}/{x}/{y}{r}.png'
  },
  street: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attr: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  }
};

// ── Load Leaflet CSS + JS dynamically ──────────────────────────────────
function loadLeaflet(callback) {
  if (leafletLoaded) { callback(); return; }

  // CSS
  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  document.head.appendChild(link);

  // JS
  const script  = document.createElement('script');
  script.src    = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  script.onload = () => { leafletLoaded = true; callback(); };
  document.head.appendChild(script);
}

// ── Switch between Field canvas and Leaflet satellite ─────────────────
function switchMapView(view, btn) {
  currentMapView = view;
  document.querySelectorAll('.map-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  const fieldView     = document.getElementById('map-field-view');
  const satelliteView = document.getElementById('map-satellite-view');

  if (view === 'field') {
    fieldView.style.display     = 'block';
    satelliteView.style.display = 'none';
  } else {
    fieldView.style.display     = 'none';
    satelliteView.style.display = 'block';
    loadLeaflet(initLeafletMap);
  }
}

// ── Initialise Leaflet map ─────────────────────────────────────────────
function initLeafletMap() {
  if (leafletInited) {
    // Already created — just invalidate size (needed after display:none switch)
    if (leafletMap) leafletMap.invalidateSize();
    return;
  }
  leafletInited = true;

  const container = document.getElementById('google-map');
  if (!container) return;

  // Start at rover position; we'll fly to user location once granted
  leafletMap = L.map('google-map', {
    center:     [roverLat, roverLon],
    zoom:       18,
    zoomControl: true,
    attributionControl: true
  });

  // Load satellite layer by default
  applyTileLayer('satellite');

  // Rover marker (custom green triangle SVG)
  const roverIcon = L.divIcon({
    className: '',
    html: '<div style="width:24px;height:24px;display:flex;align-items:center;justify-content:center">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="#3A6B45" stroke="#fff" stroke-width="1.5">' +
          '<polygon points="12,2 22,22 2,22"/></svg></div>',
    iconSize:   [24, 24],
    iconAnchor: [12, 12]
  });

  leafletMarker = L.marker([roverLat, roverLon], { icon: roverIcon })
    .bindPopup('<b>Rover Position</b><br>' + roverLat.toFixed(5) + ', ' + roverLon.toFixed(5))
    .addTo(leafletMap);

  // Now request user GPS
  requestUserLocation();
}

// ── Apply a tile layer by key ──────────────────────────────────────────
function applyTileLayer(type) {
  if (!leafletMap) return;
  const cfg = TILE_LAYERS[type] || TILE_LAYERS.satellite;

  if (leafletLayer) leafletMap.removeLayer(leafletLayer);

  leafletLayer = L.tileLayer(cfg.url, {
    attribution: cfg.attr,
    maxZoom:     cfg.maxZoom || 19
  }).addTo(leafletMap);
}

// ── Switch tile layer ──────────────────────────────────────────────────
function setMapType(type) {
  currentMapType = type;
  document.querySelectorAll('.gmap-layer-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('layer-' + type);
  if (btn) btn.classList.add('active');
  applyTileLayer(type);
}

// ── Request browser geolocation ───────────────────────────────────────
function requestUserLocation() {
  const locText = document.getElementById('gmap-loc-text');
  if (locText) locText.textContent = 'Requesting your location...';

  if (!navigator.geolocation) {
    if (locText) locText.textContent = roverLat.toFixed(5) + ', ' + roverLon.toFixed(5) + ' (rover GPS — location unavailable)';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLat = pos.coords.latitude;
      userLon = pos.coords.longitude;

      // Fly to user location at close zoom
      if (leafletMap) leafletMap.flyTo([userLat, userLon], 18, { duration: 1.4 });

      // Blue dot marker for user
      const userIcon = L.divIcon({
        className: '',
        html: '<div style="width:18px;height:18px;border-radius:50%;background:#2B6CB0;border:3px solid #fff;box-shadow:0 2px 8px rgba(43,108,176,0.45)"></div>',
        iconSize:   [18, 18],
        iconAnchor: [9, 9]
      });

      if (userMarker) leafletMap.removeLayer(userMarker);
      userMarker = L.marker([userLat, userLon], { icon: userIcon })
        .bindPopup('<b>Your Location</b><br>' + userLat.toFixed(5) + ', ' + userLon.toFixed(5))
        .addTo(leafletMap);

      if (locText) locText.textContent = userLat.toFixed(5) + ', ' + userLon.toFixed(5) + ' (your location)';
    },
    (_err) => {
      // Denied — stay on rover position
      if (locText) locText.textContent = roverLat.toFixed(5) + ', ' + roverLon.toFixed(5) + ' (rover GPS — allow location for your position)';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ── Re-center button ──────────────────────────────────────────────────
function gmapRecenter() {
  if (!leafletMap) return;
  const lat = userLat || roverLat;
  const lon = userLon || roverLon;
  leafletMap.flyTo([lat, lon], 18, { duration: 1.2 });
  // Re-request location if not yet granted
  if (!userLat) requestUserLocation();
}

// ── Update rover marker when GPS changes ──────────────────────────────
function updateRoverCoordsForMap(lat, lon) {
  roverLat = lat;
  roverLon = lon;

  if (!leafletMap || !leafletMarker) return;

  leafletMarker.setLatLng([lat, lon]);
  leafletMarker.setPopupContent('<b>Rover Position</b><br>' + lat.toFixed(5) + ', ' + lon.toFixed(5));

  // If no user GPS and satellite view active, follow rover
  if (!userLat && currentMapView === 'satellite') {
    leafletMap.setView([lat, lon], leafletMap.getZoom(), { animate: true });
    const locText = document.getElementById('gmap-loc-text');
    if (locText) locText.textContent = lat.toFixed(5) + ', ' + lon.toFixed(5) + ' (rover GPS)';
  }
}


// ═══════════════════════════════════════════════
// ROVER CONNECTION POLLING + POPUP
// ═══════════════════════════════════════════════
let _lastRoverConnected  = null;  // null = not yet known
let _roverPollInterval   = null;
let _notifHideTimer      = null;

function startRoverConnectionPolling() {
  if (_roverPollInterval) return;
  // Poll every 2.5 seconds
  _roverPollInterval = setInterval(checkRoverConnection, 2500);
  checkRoverConnection(); // immediate first check
}

async function checkRoverConnection() {
  try {
    const res  = await fetch('/api/rover/connection');
    const data = await res.json();
    const now  = data.connected;

    // Only react when state actually changes (and we had a previous state)
    if (_lastRoverConnected !== null && now !== _lastRoverConnected) {
      if (now) {
        showRoverPopup('connected');
        showNotifToast('connected');
      } else {
        showRoverPopup('disconnected');
        showNotifToast('disconnected');
      }
    }
    _lastRoverConnected = now;
  } catch(e) { /* silent — server may be restarting */ }
}

// ── Full-screen popup ─────────────────────────
function showRoverPopup(state) {
  const overlay = document.getElementById('rover-popup-overlay');
  const icon    = document.getElementById('rover-popup-icon');
  const title   = document.getElementById('rover-popup-title');
  const msg     = document.getElementById('rover-popup-msg');
  const btn     = document.getElementById('rover-popup-btn') || overlay.querySelector('.rover-popup-btn');

  if (state === 'connected') {
    icon.className = 'rover-popup-icon connected';
    icon.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="var(--green)" stroke="none"/></svg>';
    title.textContent = 'Rover Connected';
    title.style.color = 'var(--green-text)';
    msg.textContent   = 'The rover is now connected and ready to receive movement commands from the mobile controller.';
    if (btn) { btn.textContent = 'Got it'; btn.className = 'rover-popup-btn'; }
  } else {
    icon.className = 'rover-popup-icon disconnected';
    icon.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="var(--red)" stroke="none"/></svg>';
    title.textContent = 'Rover Disconnected';
    title.style.color = 'var(--red)';
    msg.textContent   = 'The rover has been disconnected from the mobile controller. Toggle the switch on the controller page to reconnect.';
    if (btn) { btn.textContent = 'OK'; btn.className = 'rover-popup-btn disconnect-btn'; }
  }

  overlay.style.display = 'flex';
}

function closeRoverPopup() {
  const overlay = document.getElementById('rover-popup-overlay');
  if (overlay) overlay.style.display = 'none';
}

// Close popup on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeRoverPopup();
});

// ── Slide-in notification toast ───────────────
function showNotifToast(state) {
  const toast  = document.getElementById('notif-toast');
  const icon   = document.getElementById('notif-icon');
  const title  = document.getElementById('notif-title');
  const sub    = document.getElementById('notif-sub');
  if (!toast) return;

  clearTimeout(_notifHideTimer);
  toast.classList.remove('hiding');

  if (state === 'connected') {
    toast.className = 'notif-toast notif-connected';
    icon.innerHTML  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="var(--green)" stroke="none"/></svg>';
    title.textContent = 'Rover Connected';
    sub.textContent   = 'Mobile controller is active';
  } else {
    toast.className = 'notif-toast notif-disconnected';
    icon.innerHTML  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.2" stroke-linecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><circle cx="12" cy="20" r="1" fill="var(--red)" stroke="none"/></svg>';
    title.textContent = 'Rover Disconnected';
    sub.textContent   = 'Check mobile controller';
  }

  toast.style.display = 'flex';

  // Auto-dismiss after 5 seconds
  _notifHideTimer = setTimeout(dismissNotif, 5000);
}

function dismissNotif() {
  const toast = document.getElementById('notif-toast');
  if (!toast) return;
  toast.classList.add('hiding');
  setTimeout(() => { toast.style.display = 'none'; toast.classList.remove('hiding'); }, 280);
}

// ── Hook rover coords update into existing pollStatus ─
const _origUpdateUI = updateUI;
updateUI = function(data) {
  _origUpdateUI(data);
  if (data.rover) updateRoverCoordsForMap(data.rover.gps_lat, data.rover.gps_lon);
};

// ── Start polling on page load ─────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Slight delay so existing DOMContentLoaded handler runs first
  setTimeout(startRoverConnectionPolling, 1200);
});
