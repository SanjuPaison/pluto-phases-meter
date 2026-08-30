/* Pluto Phases Meter — engine.js
   The scoring logic (weights, tables, digit-reduction rules) is NOT in this
   file anymore — it lives only in the Cloudflare Worker (worker/worker.js).
   This file computes the public Sun/Moon ecliptic longitude (ephemeris —
   not secret, just astronomy) and sends plain, non-secret numbers to the
   Worker: local hour/weekday/day/month/year, the longitudes, and which of
   the 13 buttons is selected. It gets back only { pct, factors }. */

/* ===== CONFIGURE THIS after deploying the Worker (see worker/README-worker.md) ===== */
var WORKER_URL = "https://pluto-phases-meter-worker.sanjupaison.workers.dev/";

(function(){
"use strict";

var _sym = ["\uD83C\uDF10","\u2648","\u2649","\u264A","\u264B","\u264C","\u264D","\u264E","\u264F","\u2650","\u2651","\u2652","\u2653"];
var _names = ["Global","Aries","Taurus","Gemini","Cancer","Leo","Virgo","Libra","Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"];

/* ecliptic longitude (deg, 0-360) -> zodiac sign number 1..12 (Aries=1)
   This mapping is just public zodiac boundaries, not proprietary — fine to
   keep client-side purely so we can label the Sun/Moon glyph immediately
   without waiting on the network. The Worker computes its own copy from
   the same longitude for the actual scoring, so the two never disagree. */
function _signOf(lonDeg){
  var l = ((lonDeg%360)+360)%360;
  return Math.floor(l/30)+1;
}

/* Get public ephemeris (Sun/Moon longitude) for a given moment */
function _ephemeris(dateObj){
  var AE = window.Astronomy;
  var t = AE.MakeTime(dateObj);
  var sunLon = AE.SunPosition(t).elon;
  var moonLon = AE.EclipticGeoMoon(t).lon;
  return { sunLon: sunLon, moonLon: moonLon, sunSign: _signOf(sunLon), moonSign: _signOf(moonLon) };
}

/* Ask the Worker to do the actual scoring. Returns a Promise<{pct, factors}> */
function _computeRemote(dateObj, activeSystem){
  var eph = _ephemeris(dateObj);
  var payload = {
    hour: dateObj.getHours(),
    weekday: dateObj.getDay(),
    day: dateObj.getDate(),
    month: dateObj.getMonth()+1,
    year: dateObj.getFullYear(),
    sunLon: eph.sunLon,
    moonLon: eph.moonLon,
    activeSystem: activeSystem
  };
  return fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).then(function(res){
    if(!res.ok){ return res.json().then(function(e){ throw new Error(e.error || ("HTTP "+res.status)); }); }
    return res.json();
  });
}

window.__plutoMeter = {
  computeRemote:_computeRemote, ephemeris:_ephemeris, symbols:_sym, names:_names, signOf:_signOf
};

})();

/* =================== UI layer =================== */
(function(){
"use strict";

var CACHE_KEY = "pluto_phases_meter_cache_v1";

var state = {
  theme: "space",
  gender: "male", // informational only — tells the person which natal sign to look up, doesn't touch the math
  mode: "now",
  activeSystem: 0, // 0 = global, else 1-12 — set only by tapping a symbol below
  customDate: null,
  busy: false,
  lastKey: null // memoization key: what inputs produced the currently-shown result
};

var THEMES = [
  {id:"space", label:"Deep Space", dot:"#c084fc"},
  {id:"dashboard", label:"Dashboard", dot:"#7dd3fc"},
  {id:"celestial", label:"Celestial", dot:"#e7c368"},
  {id:"synth", label:"Synthwave", dot:"#ff5fc4"}
];

var MIN_YEAR = 2017, MAX_YEAR = 2032;

function pad(n){ return n<10 ? "0"+n : ""+n; }

function fmtClock(d){
  return pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds());
}
function fmtDate(d){
  return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
}

function currentMoment(){
  if(state.mode==="custom" && state.customDate) return state.customDate;
  return new Date();
}

function inRange(d){
  var y = d.getFullYear();
  return y>=MIN_YEAR && y<=MAX_YEAR;
}

function colorForPct(p){
  if(p<30) return "#ef4444";
  if(p>70) return "#22c55e";
  return "#eab308";
}
function statusForPct(p){
  if(p<30) return "Low alignment — a quieter, more effortful window.";
  if(p>70) return "High alignment — conditions read favorably.";
  return "Mixed alignment — a fairly neutral window.";
}

/* memoization key: same hour + same day + same active system + same mode
   means the result would be identical, so skip the network call */
function keyFor(moment, activeSystem){
  return [moment.getFullYear(), moment.getMonth(), moment.getDate(), moment.getHours(), activeSystem].join("-");
}

function readCache(){
  try{
    var raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e){ return null; }
}
function writeCache(entry){
  try{ localStorage.setItem(CACHE_KEY, JSON.stringify(entry)); } catch(e){ /* storage unavailable, ignore */ }
}

function buildThemeGrid(){
  var wrap = document.getElementById("themeGrid");
  wrap.innerHTML = "";
  THEMES.forEach(function(t){
    var el = document.createElement("button");
    el.className = "theme-swatch"+(t.id===state.theme?" active":"");
    el.style.setProperty("--dot-color", t.dot);
    el.title = t.label;
    el.setAttribute("aria-label", t.label);
    el.addEventListener("click", function(){
      state.theme = t.id;
      document.body.setAttribute("data-theme", t.id);
      buildThemeGrid();
    });
    wrap.appendChild(el);
  });
}

function buildZodiacRow(){
  var wrap = document.getElementById("zodiacRow");
  wrap.innerHTML = "";
  var M = window.__plutoMeter;

  // render order: 12 signs, then Global, then Settings — Global/Settings
  // are moved to the end per the requested layout. `order` holds the
  // activeSystem index each button corresponds to (Settings has none).
  var order = [1,2,3,4,5,6,7,8,9,10,11,12,0];

  order.forEach(function(idx){
    var btn = document.createElement("button");
    btn.className = "zbtn"+(state.activeSystem===idx?" active":"");
    btn.title = M.names[idx];
    btn.textContent = M.symbols[idx];
    btn.addEventListener("click", function(){
      if(state.activeSystem===idx) return;
      state.activeSystem = idx;
      refresh();
    });
    wrap.appendChild(btn);
  });

  var settingsBtn = document.createElement("button");
  settingsBtn.className = "zbtn";
  settingsBtn.title = "Settings";
  settingsBtn.setAttribute("aria-label", "Settings");
  settingsBtn.textContent = "\u2699";
  settingsBtn.addEventListener("click", function(){
    document.getElementById("themePanel").classList.toggle("open");
  });
  wrap.appendChild(settingsBtn);
}

var ZODIAC_ORDER = [1,2,3,4,5,6,7,8,9,10,11,12,0]; // matches buildZodiacRow's render order

function highlightActiveZodiac(){
  var wrap = document.getElementById("zodiacRow");
  Array.prototype.forEach.call(wrap.children, function(el, i){
    var idx = ZODIAC_ORDER[i]; // undefined for the trailing Settings button — never matches
    el.classList.toggle("active", idx===state.activeSystem);
  });
}

function renderBreakdown(f, flags){
  flags = flags || {};
  var grid = document.getElementById("breakdownGrid");
  var M = window.__plutoMeter;
  var items = [
    ["Hour", f.hour, false],
    ["Day", f.day, !!flags.day],
    ["Moon", M.symbols[f.moon], !!flags.moon],
    ["Sun", M.symbols[f.sun], !!flags.sun],
    ["Month", f.month, !!flags.month],
    ["Year", f.year, false],
    ["Date", f.date, false]
  ];
  grid.innerHTML = "";
  items.forEach(function(it){
    var div = document.createElement("div");
    div.className = "bd-item" + (it[2] ? " penalty" : "");
    div.innerHTML = '<div class="bd-num">'+it[1]+'</div><div class="bd-label">'+it[0]+'</div>';
    grid.appendChild(div);
  });
}

function paintResult(pct, factors, opts){
  opts = opts || {};
  var fill = document.getElementById("meterFill");
  var pctEl = document.getElementById("pctDisplay");
  var statusEl = document.getElementById("statusText");
  var color = colorForPct(pct);

  pctEl.textContent = pct + "%";
  pctEl.style.color = color;
  fill.style.width = pct + "%";
  fill.style.background = color;
  statusEl.textContent = (opts.stale ? "(Last known reading — live update unavailable) " : "") + statusForPct(pct);
  stampMomentDisplay(opts.at ? new Date(opts.at) : new Date());

  highlightActiveZodiac();
  renderBreakdown(factors, opts.flags);
}

function setLoading(isLoading){
  var pctEl = document.getElementById("pctDisplay");
  var statusEl = document.getElementById("statusText");
  if(isLoading){
    pctEl.textContent = "…";
    pctEl.style.color = "var(--text-faint)";
    statusEl.textContent = "Reading the current moment…";
  }
}

function refresh(){
  if(state.busy) return;
  var moment = currentMoment();
  var oor = document.getElementById("outOfRange");

  if(!inRange(moment)){
    oor.classList.add("show");
    var pctEl = document.getElementById("pctDisplay");
    pctEl.textContent = "--%";
    pctEl.style.color = "var(--text-faint)";
    document.getElementById("meterFill").style.width = "0%";
    document.getElementById("statusText").textContent = "Pick a date between 2017 and 2032.";
    document.getElementById("breakdownGrid").innerHTML = "";
    return;
  }
  oor.classList.remove("show");

  var key = keyFor(moment, state.activeSystem);

  // memoized: identical inputs to what's already on screen — skip the network call
  var cached = readCache();
  if(cached && cached.key===key){
    paintResult(cached.pct, cached.factors, { at: cached.at, flags: cached.flags });
    return;
  }

  state.busy = true;
  setLoading(true);

  var M = window.__plutoMeter;
  M.computeRemote(moment, state.activeSystem).then(function(result){
    state.busy = false;
    var at = moment.getTime(); // the moment actually being read — "now" snapshot, or the chosen custom date/time
    paintResult(result.pct, result.factors, { at: at, flags: result.flags });
    writeCache({ key: key, pct: result.pct, factors: result.factors, flags: result.flags, at: at });
  }).catch(function(err){
    state.busy = false;
    var fallback = readCache();
    if(fallback){
      paintResult(fallback.pct, fallback.factors, { stale:true, at: fallback.at, flags: fallback.flags });
    } else {
      document.getElementById("pctDisplay").textContent = "--%";
      document.getElementById("pctDisplay").style.color = "var(--text-faint)";
      document.getElementById("statusText").textContent = "Reading unavailable — check your connection and try refresh.";
      document.getElementById("breakdownGrid").innerHTML = "";
    }
  });
}

function updateGenderHint(){
  var el = document.getElementById("genderHint");
  if(!el) return;
  var which = state.gender === "male" ? "Sun" : "Moon";
  el.textContent = "Use your " + which + " sign";
}

function stampMomentDisplay(d){
  d = d || new Date();
  document.getElementById("clockTime").textContent = fmtClock(d);
  document.getElementById("clockDate").textContent = fmtDate(d);
}

function forceRefresh(btnEl){
  btnEl.classList.add("spin");
  setTimeout(function(){ btnEl.classList.remove("spin"); }, 650);
  // a manual refresh should force a real check even if the memoized key
  // matches, in case the underlying moment or Worker result has moved on
  var moment = currentMoment();
  if(inRange(moment)){
    var key = keyFor(moment, state.activeSystem);
    var cached = readCache();
    if(cached && cached.key===key){
      try{ localStorage.removeItem(CACHE_KEY); } catch(e){}
    }
  }
  refresh();
}

function wireSettings(){
  document.getElementById("clockBlock").addEventListener("click", function(){
    document.getElementById("momentPanel").classList.toggle("open");
  });

  document.getElementById("genderToggle").addEventListener("click", function(e){
    var btn = e.target.closest(".toggle-btn");
    if(!btn) return;
    Array.prototype.forEach.call(this.children, function(b){ b.classList.remove("active"); });
    btn.classList.add("active");
    state.gender = btn.getAttribute("data-gender");
    updateGenderHint(); // display-only, no recalculation needed
  });

  document.getElementById("dateModeToggle").addEventListener("click", function(e){
    var btn = e.target.closest(".toggle-btn");
    if(!btn) return;
    Array.prototype.forEach.call(this.children, function(b){ b.classList.remove("active"); });
    btn.classList.add("active");
    state.mode = btn.getAttribute("data-mode");
    var input = document.getElementById("customDateInput");
    if(state.mode==="custom"){
      input.style.display = "block";
      if(!input.value){
        var n = new Date();
        input.value = n.getFullYear()+"-"+pad(n.getMonth()+1)+"-"+pad(n.getDate())+"T"+pad(n.getHours())+":"+pad(n.getMinutes());
      }
      state.customDate = new Date(input.value);
    } else {
      input.style.display = "none";
      state.customDate = null;
    }
    refresh();
  });

  document.getElementById("customDateInput").addEventListener("change", function(){
    state.customDate = new Date(this.value);
    refresh();
  });

  document.getElementById("headerRefreshBtn").addEventListener("click", function(){ forceRefresh(this); });
}

/* Tell whatever page has embedded us (via iframe) how tall we actually are,
   so it can resize the iframe to match instead of leaving blank space below
   (or clipping us) with a guessed fixed height. Harmless if not embedded —
   postMessage to a same-window "parent" is a no-op then. */
function reportHeight(){
  try{
    var h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    window.parent.postMessage({ source: "pluto-phases-meter", height: h }, "*");
  } catch(e){ /* ignore — e.g. cross-origin restrictions in unusual embeds */ }
}

function watchHeight(){
  reportHeight();
  if(window.ResizeObserver){
    new ResizeObserver(reportHeight).observe(document.body);
  } else {
    // fallback for very old browsers without ResizeObserver
    window.addEventListener("resize", reportHeight);
    setInterval(reportHeight, 1000);
  }
}

function init(){
  buildThemeGrid();
  buildZodiacRow();
  wireSettings();
  updateGenderHint();
  watchHeight(); // reports our height to the embedding page so it can auto-size the iframe
  refresh(); // one call on load; after this, only a refresh button or a settings change triggers another
}

if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

})();
