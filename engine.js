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

var _sym = ["\u221E","\u2648","\u2649","\u264A","\u264B","\u264C","\u264D","\u264E","\u264F","\u2650","\u2651","\u2652","\u2653"];
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
    var el = document.createElement("div");
    el.className = "theme-swatch"+(t.id===state.theme?" active":"");
    el.innerHTML = '<div class="theme-dot" style="background:'+t.dot+'"></div>'+t.label;
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
  for(var i=0;i<13;i++){
    (function(idx){
      var btn = document.createElement("button");
      btn.className = "zbtn"+(idx===0?" global":"")+(state.activeSystem===idx?" active":"");
      btn.title = M.names[idx];
      btn.textContent = M.symbols[idx];
      btn.addEventListener("click", function(){
        if(state.activeSystem===idx) return;
        state.activeSystem = idx;
        refresh();
      });
      wrap.appendChild(btn);
    })(i);
  }
}

function highlightActiveZodiac(){
  var wrap = document.getElementById("zodiacRow");
  Array.prototype.forEach.call(wrap.children, function(el, idx){
    el.classList.toggle("active", idx===state.activeSystem);
  });
}

function renderBreakdown(f){
  var grid = document.getElementById("breakdownGrid");
  var M = window.__plutoMeter;
  var items = [
    ["Hour", f.hour],
    ["Day", f.day],
    ["Moon", M.symbols[f.moon] + " " + M.names[f.moon]],
    ["Sun", M.symbols[f.sun] + " " + M.names[f.sun]],
    ["Month", f.month],
    ["Year", f.year],
    ["Date", f.date]
  ];
  grid.innerHTML = "";
  items.forEach(function(it){
    var div = document.createElement("div");
    div.className = "bd-item";
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

  var M = window.__plutoMeter;
  var sysLabel = state.activeSystem===0 ? "Global" : M.names[state.activeSystem];
  document.getElementById("zodiacCurrent").textContent = "Reading via " + sysLabel;

  highlightActiveZodiac();
  renderBreakdown(factors);
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
    document.getElementById("zodiacCurrent").textContent = "";
    document.getElementById("breakdownGrid").innerHTML = "";
    return;
  }
  oor.classList.remove("show");

  var key = keyFor(moment, state.activeSystem);

  // memoized: identical inputs to what's already on screen — skip the network call
  var cached = readCache();
  if(cached && cached.key===key){
    paintResult(cached.pct, cached.factors, {});
    return;
  }

  state.busy = true;
  setLoading(true);

  var M = window.__plutoMeter;
  M.computeRemote(moment, state.activeSystem).then(function(result){
    state.busy = false;
    paintResult(result.pct, result.factors, {});
    writeCache({ key: key, pct: result.pct, factors: result.factors, at: Date.now() });
  }).catch(function(err){
    state.busy = false;
    var fallback = readCache();
    if(fallback){
      paintResult(fallback.pct, fallback.factors, { stale:true });
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
  el.innerHTML = "This doesn't change the reading itself — it's just a pointer: look up your <b>natal " + which + " sign</b> (from your own birth chart, not today's sky) and tap its symbol below to score the reading with your table.";
}

function tickClock(){
  var now = new Date();
  document.getElementById("clockTime").textContent = fmtClock(now);
  document.getElementById("clockDate").textContent = fmtDate(now);
}

function wireSettings(){
  document.getElementById("settingsBtn").addEventListener("click", function(){
    document.getElementById("settingsPanel").classList.toggle("open");
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

  document.getElementById("refreshBtn").addEventListener("click", function(){
    this.classList.add("spin");
    var self = this;
    setTimeout(function(){ self.classList.remove("spin"); }, 650);
    // a manual refresh should force a real check even if the memoized key
    // matches, in case the underlying moment or Worker result has moved on
    var moment = currentMoment();
    if(inRange(moment)){
      var key = keyFor(moment, state.activeSystem);
      var cached = readCache();
      if(cached && cached.key===key){
        // force a fresh network call by clearing the memoized cache entry first
        try{ localStorage.removeItem(CACHE_KEY); } catch(e){}
      }
    }
    refresh();
  });
}

function drawStars(){
  var svg = document.getElementById("stars");
  var n = 90;
  var frag = document.createDocumentFragment();
  for(var i=0;i<n;i++){
    var c = document.createElementNS("http://www.w3.org/2000/svg","circle");
    c.setAttribute("cx", (Math.random()*100)+"%");
    c.setAttribute("cy", (Math.random()*100)+"%");
    c.setAttribute("r", (Math.random()*1.3+.2).toFixed(2));
    c.setAttribute("fill", "#ffffff");
    c.setAttribute("opacity", (Math.random()*.6+.15).toFixed(2));
    frag.appendChild(c);
  }
  svg.appendChild(frag);
}

function init(){
  buildThemeGrid();
  buildZodiacRow();
  wireSettings();
  updateGenderHint();
  drawStars();
  tickClock();
  setInterval(tickClock, 1000); // clock display only — no network cost, no recalculation
  refresh(); // one call on load; after this, only the refresh button or a settings change triggers another
}

if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

})();
