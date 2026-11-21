/* Grenzgang – App-Logik */
(() => {
  'use strict';
  const { Grid, parcelContains, bboxOf, inAny, flatEdges, outerEdges, nearestEdge, rayHit, bearing, dest,
    angDiff, smoothAngle, cardinal, headingFromOrientation, circleRing } = Geo;

  /* ================= Konfiguration ================= */
  const CONFIG = {
    wfs: 'https://geodienste.sachsen.de/aaa/public_alkis/vereinf/wfs',
    dop: 'https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=sn_dop_020&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/jpeg',
    osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    dem: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    /* Nur nötig, falls der Browser den GeoSN-Server wegen CORS blockiert: URL eines eigenen Proxys (siehe proxy-worker.js). */
    proxy: '',
    kreisFilter: /Mittelsachsen|Chemnitz/i,
    rayLength: 400,
  };
  const DEFAULTS = {
    gemarkungen: 'Auerswalde, Garnsdorf, Glösa, Draisdorf, Heinersdorf, Wittgensdorf',
    warn: 10, decl: 5, headingSrc: 'compass', rot2d: false,
  };
  const VIEWS = {
    '2d': { pitch: 0, zoom: 17.5, terrain: false, rotate: false, pad: { top: 0, bottom: 0, left: 0, right: 0 } },
    '3d': { pitch: 62, zoom: 17, terrain: true, rotate: true, pad: { top: 160, bottom: 0, left: 0, right: 0 } },
    heli: { pitch: 74, zoom: 15.6, terrain: true, rotate: true, pad: { top: 320, bottom: 0, left: 0, right: 0 } },
  };

  /* ================= Projektion ================= */
  proj4.defs('EPSG:25833', '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs');
  proj4.defs('EPSG:25832', '+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs');
  const cFwd = proj4('EPSG:4326', 'EPSG:25833');
  const cInv = proj4('EPSG:25833', 'EPSG:4326');
  const toUTM = (lon, lat) => cFwd.forward([lon, lat]);
  const toLL = (x, y) => cInv.forward([x, y]);
  const c32to33 = proj4('EPSG:25832', 'EPSG:25833');

  /* ================= Speicher (IndexedDB, mit Notfall-Fallback im Arbeitsspeicher) ================= */
  const DB = (() => {
    let dbp = null;
    const mem = new Map();
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open('grenzgang', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    }));
    return {
      async get(k) {
        try {
          const db = await open();
          return await new Promise((res, rej) => {
            const q = db.transaction('kv').objectStore('kv').get(k);
            q.onsuccess = () => res(q.result);
            q.onerror = () => rej(q.error);
          });
        } catch (e) { return mem.get(k); }
      },
      async set(k, v) {
        mem.set(k, v);
        try {
          const db = await open();
          await new Promise((res, rej) => {
            const t = db.transaction('kv', 'readwrite');
            t.objectStore('kv').put(v, k);
            t.oncomplete = res;
            t.onerror = () => rej(t.error);
          });
        } catch (e) { /* nur Arbeitsspeicher */ }
      },
    };
  })();

  /* ================= Zustand ================= */
  const S = {
    settings: { ...DEFAULTS },
    parcels: [], byId: new Map(), grid: new Grid(200),
    selected: new Set(), selParcels: [], selGrid: new Grid(100), areaEdges: new Float64Array(0),
    pos: null, xy: null, heading: null, view: '2d', base: 'osm', follow: true, mark: false,
    current: null, curEdges: new Float64Array(0), localC: null, localEdges: new Float64Array(0),
    localArea: new Float64Array(0), localDirty: true, lastWarn: 0, lastStatus: '', picked: null,
  };
  const $ = (id) => document.getElementById(id);
  const EMPTY = { type: 'FeatureCollection', features: [] };
  const ids = (a) => ['literal', a.length ? a : ['__none__']];

  /* ================= Hilfsfunktionen UI ================= */
  let toastT = 0;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, ms || 3500);
  }
  const fmtM = (d) => (d < 10 ? d.toFixed(1) : Math.round(d)).toString().replace('.', ',');
  const fmtArea = (a) => (a ? Number(a).toLocaleString('de-DE') + ' m²' : '');
  const labelOf = (props) => (props.flstnrzae || '?') + (props.flstnrnen ? '/' + props.flstnrnen : '');

  /* ================= GML-Parser (ALKIS-WFS, vereinfachtes Schema) ================= */
  function ringFrom(el) {
    const pl = el.getElementsByTagNameNS('*', 'posList')[0];
    let nums, dim = 2;
    if (pl) {
      dim = Number(pl.getAttribute('srsDimension') || 2);
      nums = pl.textContent.trim().split(/\s+/).map(Number);
    } else {
      const ps = el.getElementsByTagNameNS('*', 'pos');
      if (!ps.length) return null;
      nums = [];
      for (const p of ps) nums.push(...p.textContent.trim().split(/\s+/).map(Number));
      dim = nums.length / ps.length;
    }
    const n = Math.floor(nums.length / dim);
    const out = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) { out[2 * i] = nums[i * dim]; out[2 * i + 1] = nums[i * dim + 1]; }
    return out;
  }
  function polysFrom(geomEl) {
    const polys = [];
    const els = [...geomEl.getElementsByTagNameNS('*', 'Polygon'), ...geomEl.getElementsByTagNameNS('*', 'PolygonPatch')];
    for (const pe of els) {
      const rings = [];
      for (const ch of pe.children) {
        const ln = ch.localName;
        const outer = ln === 'exterior' || ln === 'outerBoundaryIs';
        if (outer || ln === 'interior' || ln === 'innerBoundaryIs') {
          const r = ringFrom(ch);
          if (r && r.length >= 6) (outer ? rings.unshift(r) : rings.push(r));
        }
      }
      if (rings.length) polys.push(rings);
    }
    return polys;
  }
  function parseGML(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Die Antwort des Servers ist kein gültiges XML.');
    const exc = doc.getElementsByTagNameNS('*', 'ExceptionText');
    if (exc.length) throw new Error('Server-Fehler: ' + exc[0].textContent.trim().slice(0, 200));
    const out = [];
    for (const f of doc.getElementsByTagNameNS('*', 'Flurstueck')) {
      const props = {};
      let geom = null;
      for (const c of f.children) {
        if (c.getElementsByTagNameNS('*', 'posList').length || c.getElementsByTagNameNS('*', 'pos').length) { geom = c; continue; }
        const v = c.textContent.trim();
        if (v && v.length < 200) props[c.localName] = v;
      }
      if (!geom) continue;
      let polys = polysFrom(geom);
      if (!polys.length) continue;
      const srsEl = geom.hasAttribute('srsName') ? geom : geom.querySelector('[srsName]');
      const srs = srsEl ? srsEl.getAttribute('srsName') : '';
      if (/25832/.test(srs)) {
        polys = polys.map((rs) => rs.map((r) => { const o = new Float64Array(r.length); for (let i = 0; i < r.length; i += 2) { const q = c32to33.forward([r[i], r[i + 1]]); o[i] = q[0]; o[i + 1] = q[1]; } return o; }));
      } else if (polys[0][0][0] > 4000000) { // Achsen vertauscht (N,E statt E,N)
        polys = polys.map((rs) => rs.map((r) => { const o = new Float64Array(r.length); for (let i = 0; i < r.length; i += 2) { o[i] = r[i + 1]; o[i + 1] = r[i]; } return o; }));
      }
      const gmlId = f.getAttributeNS('http://www.opengis.net/gml/3.2', 'id') || f.getAttribute('gml:id');
      const id = props.flstkennz || gmlId || [props.gemaschl, props.flstnrzae, props.flstnrnen, out.length].join('-');
      out.push({ id, props, polys });
    }
    return out;
  }

  /* ================= WFS-Abruf ================= */
  const escLike = (s) => s.replace(/[!*.]/g, '!$&').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  function wfsUrl(name, start, count) {
    const filter = `<Filter xmlns='http://www.opengis.net/fes/2.0'><PropertyIsLike wildCard='*' singleChar='.' escapeChar='!'>` +
      `<ValueReference>ave:gemarkung</ValueReference><Literal>*${escLike(name)}*</Literal></PropertyIsLike></Filter>`;
    const u = new URL(CONFIG.wfs);
    const q = {
      SERVICE: 'WFS', VERSION: '2.0.0', REQUEST: 'GetFeature', TYPENAMES: 'ave:Flurstueck',
      NAMESPACES: 'xmlns(ave,http://repository.gdi-de.org/schemas/adv/produkt/alkis-vereinfacht/2.0)',
      SRSNAME: 'urn:ogc:def:crs:EPSG::25833', FILTER: filter, COUNT: String(count), STARTINDEX: String(start),
    };
    for (const k in q) u.searchParams.set(k, q[k]);
    return u.toString();
  }
  async function fetchGemarkung(name, onProgress) {
    const all = [], page = 5000;
    for (let start = 0; ; start += page) {
      const url = wfsUrl(name, start, page);
      let res;
      try { res = await fetch(CONFIG.proxy ? CONFIG.proxy + encodeURIComponent(url) : url); }
      catch (e) {
        throw new Error('Keine Verbindung zum GeoSN-Server. Ohne Netz geht das nicht – oder der Browser blockiert den Zugriff (CORS). Dann hilft der kleine Proxy aus proxy-worker.js.');
      }
      if (!res.ok) throw new Error('GeoSN-Server antwortet mit Status ' + res.status + '.');
      const items = parseGML(await res.text());
      all.push(...items);
      onProgress(all.length);
      if (items.length < page) break;
    }
    return all.filter((it) => !it.props.kreis || CONFIG.kreisFilter.test(it.props.kreis));
  }

  /* ================= Daten verwalten ================= */
  const namesList = () => S.settings.gemarkungen.split(',').map((s) => s.trim()).filter(Boolean);
  const dsKey = (n) => 'ds:' + n.toLowerCase();

  function indexParcels(items) {
    S.parcels = []; S.byId = new Map(); S.grid = new Grid(200);
    for (const it of items) {
      if (S.byId.has(it.id)) continue;
      const p = { id: it.id, props: it.props, polys: it.polys, label: labelOf(it.props), bbox: bboxOf(it.polys) };
      S.parcels.push(p); S.byId.set(p.id, p); S.grid.add(p);
    }
  }
  function toGeoJSON(parcels) {
    return {
      type: 'FeatureCollection',
      features: parcels.map((p) => ({
        type: 'Feature',
        properties: { id: p.id, label: p.label, gem: p.props.gemarkung || '' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: p.polys.map((rings) => rings.map((r) => {
            const a = new Array(r.length / 2);
            for (let i = 0; i < a.length; i++) a[i] = toLL(r[2 * i], r[2 * i + 1]);
            return a;
          })),
        },
      })),
    };
  }
  async function loadStored() {
    const items = [];
    for (const n of namesList()) {
      const ds = await DB.get(dsKey(n));
      if (ds && ds.items) items.push(...ds.items);
    }
    indexParcels(items);
    if (map.getSource('parcels')) map.getSource('parcels').setData(toGeoJSON(S.parcels));
    const sel = (await DB.get('selection')) || [];
    S.selected = new Set(sel.filter((id) => S.byId.has(id)));
    recomputeArea();
    S.localDirty = true; S.current = null;
    renderDataList();
    if (S.xy) analyze();
  }
  async function downloadData() {
    const btn = $('btnLoad'), msg = $('dataMsg');
    btn.disabled = true; msg.className = 'msg'; msg.textContent = '';
    try {
      for (const n of namesList()) {
        const row = document.querySelector(`[data-gem="${CSS.escape(n)}"] .st`);
        if (row) row.textContent = 'lädt …';
        const items = await fetchGemarkung(n, (c) => { if (row) row.textContent = c + ' Flurstücke …'; });
        if (!items.length) throw new Error('Für „' + n + '“ wurden keine Flurstücke im Kreis Mittelsachsen oder in Chemnitz gefunden. Schreibweise prüfen.');
        await DB.set(dsKey(n), { q: n, at: new Date().toISOString(), items });
      }
      await loadStored();
      fitToData();
      msg.textContent = 'Fertig. Die Flurstücke liegen jetzt auf dem Gerät und funktionieren auch ohne Netz.';
      msg.className = 'msg ok';
    } catch (e) {
      msg.textContent = e.message; msg.className = 'msg bad';
      renderDataList();
    } finally { btn.disabled = false; }
  }
  async function renderDataList() {
    const ul = $('gemList'); ul.textContent = '';
    for (const n of namesList()) {
      const ds = await DB.get(dsKey(n));
      const li = document.createElement('li');
      li.dataset.gem = n;
      const a = document.createElement('span'); a.textContent = n;
      const b = document.createElement('span'); b.className = 'st';
      b.textContent = ds ? ds.items.length.toLocaleString('de-DE') + ' · ' + new Date(ds.at).toLocaleDateString('de-DE') : 'nicht geladen';
      li.append(a, b); ul.append(li);
    }
    $('selCount').textContent = S.selected.size ? S.selected.size + ' Flurstück' + (S.selected.size > 1 ? 'e' : '') + ' markiert' : 'Noch nichts markiert';
  }
  function fitToData() {
    if (!S.parcels.length) return;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of S.parcels) { a = Math.min(a, p.bbox[0]); b = Math.min(b, p.bbox[1]); c = Math.max(c, p.bbox[2]); d = Math.max(d, p.bbox[3]); }
    const sw = toLL(a, b), ne = toLL(c, d);
    if (!S.pos) map.fitBounds([sw, ne], { padding: 40, duration: 800 });
  }

  /* ================= Auswahl / Bereich ================= */
  function recomputeArea() {
    S.selParcels = [...S.selected].map((id) => S.byId.get(id)).filter(Boolean);
    S.selGrid = new Grid(100); S.selParcels.forEach((p) => S.selGrid.add(p));
    S.areaEdges = S.selParcels.length ? outerEdges(S.selParcels) : new Float64Array(0);
    S.localDirty = true;
    if (map.getLayer('sel-fill')) {
      map.setFilter('sel-fill', ['in', ['get', 'id'], ids([...S.selected])]);
      const lines = [];
      for (let i = 0; i < S.areaEdges.length; i += 4) lines.push([toLL(S.areaEdges[i], S.areaEdges[i + 1]), toLL(S.areaEdges[i + 2], S.areaEdges[i + 3])]);
      map.getSource('area').setData({ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } });
    }
    DB.set('selection', [...S.selected]);
    renderDataList();
  }
  let recomputeT = 0;
  function toggleSelect(id) {
    if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
    $('markCount').textContent = S.selected.size;
    clearTimeout(recomputeT);
    if (map.getLayer('sel-fill')) map.setFilter('sel-fill', ['in', ['get', 'id'], ids([...S.selected])]);
    recomputeT = setTimeout(() => { recomputeArea(); analyze(); }, 250);
  }
  function parcelAt(x, y) {
    for (const p of S.grid.at(x, y)) if (parcelContains(p, x, y)) return p;
    return null;
  }

  /* ================= Karte ================= */
  const map = new maplibregl.Map({
    container: 'map', center: [12.9, 50.87], zoom: 12, maxPitch: 85, attributionControl: false,
    style: {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        osm: { type: 'raster', tiles: [CONFIG.osm], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap-Mitwirkende' },
        dop: { type: 'raster', tiles: [CONFIG.dop], tileSize: 256, maxzoom: 20, attribution: 'Luftbild © GeoSN, dl-de/by-2.0' },
        dem: { type: 'raster-dem', tiles: [CONFIG.dem], tileSize: 256, maxzoom: 15, encoding: 'terrarium', attribution: 'Gelände: Mapzen/AWS' },
      },
      layers: [
        { id: 'bg-osm', type: 'raster', source: 'osm' },
        { id: 'bg-dop', type: 'raster', source: 'dop', layout: { visibility: 'none' } },
      ],
    },
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

  const meEl = document.createElement('div');
  meEl.className = 'me'; meEl.innerHTML = '<div class="cone"></div><div class="dot"></div>';
  const meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: 'map', pitchAlignment: 'map' });

  map.on('load', () => {
    map.addSource('parcels', { type: 'geojson', data: EMPTY });
    map.addSource('area', { type: 'geojson', data: EMPTY });
    map.addSource('acc', { type: 'geojson', data: EMPTY });
    map.addSource('ray', { type: 'geojson', data: EMPTY });
    map.addSource('hits', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': '#2f7dd1', 'fill-opacity': 0.14 } });
    map.addLayer({ id: 'sel-fill', type: 'fill', source: 'parcels', filter: ['in', ['get', 'id'], ids([])], paint: { 'fill-color': '#2E8B57', 'fill-opacity': 0.3 } });
    map.addLayer({ id: 'cur-fill', type: 'fill', source: 'parcels', filter: ['==', ['get', 'id'], '__none__'], paint: { 'fill-color': '#FFD84D', 'fill-opacity': 0.32 } });
    map.addLayer({ id: 'parcel-line', type: 'line', source: 'parcels', paint: { 'line-color': '#FFD84D', 'line-opacity': 0.95, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 18, 1.6] } });
    map.addLayer({ id: 'area-casing', type: 'line', source: 'area', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.85 } });
    map.addLayer({ id: 'area-line', type: 'line', source: 'area', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#FF5A1F', 'line-width': 3.5 } });
    map.addLayer({ id: 'ray-line', type: 'line', source: 'ray', paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
    map.addLayer({ id: 'hit-dots', type: 'circle', source: 'hits', paint: { 'circle-radius': 6, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    map.addLayer({
      id: 'parcel-label', type: 'symbol', source: 'parcels', minzoom: 16.3,
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-size': 12 },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.3 },
    });
    meMarker.setLngLat(map.getCenter()).addTo(map); meEl.style.display = 'none';
    setBase(S.base);
    S.ready = true;
    loadStored().then(() => { if (!S.parcels.length) openSheet(); });
  });
  map.on('error', (e) => {
    const s = e && e.sourceId;
    if (s === 'dop' && !map._dopWarned) { map._dopWarned = true; toast('Luftbild nicht erreichbar – Karte bleibt verfügbar.', 5000); }
  });
  map.on('dragstart', () => { if (S.follow) { S.follow = false; renderTools(); } });
  map.on('click', (e) => {
    const [x, y] = toUTM(e.lngLat.lng, e.lngLat.lat);
    const p = parcelAt(x, y);
    if (!p) { hidePick(); return; }
    if (S.mark) { toggleSelect(p.id); flashPick(p); } else showPick(p);
  });

  function setBase(b) {
    S.base = b;
    map.setLayoutProperty('bg-osm', 'visibility', b === 'osm' ? 'visible' : 'none');
    map.setLayoutProperty('bg-dop', 'visibility', b === 'dop' ? 'visible' : 'none');
    map.setPaintProperty('parcel-line', 'line-color', b === 'dop' ? '#FFD84D' : '#8a6a00');
    map.setPaintProperty('parcel-label', 'text-color', b === 'dop' ? '#ffffff' : '#3a2e00');
    map.setPaintProperty('parcel-label', 'text-halo-color', b === 'dop' ? '#000000' : '#ffffff');
    renderTools();
  }
  function setView(v) {
    S.view = v;
    const c = VIEWS[v];
    if (map.getLayer('bg-osm')) map.setTerrain(c.terrain ? { source: 'dem', exaggeration: 1.2 } : null);
    S.follow = true;
    const opts = { pitch: c.pitch, zoom: c.zoom, padding: c.pad, duration: 900 };
    if (S.pos) opts.center = [S.pos.lon, S.pos.lat];
    opts.bearing = (c.rotate || S.settings.rot2d) && S.heading != null ? S.heading : (v === '2d' ? 0 : map.getBearing());
    map.easeTo(opts);
    renderTools();
  }
  let camT = 0;
  function followCamera(force) {
    if (!S.follow || !S.pos) return;
    const now = Date.now();
    if (!force && now - camT < 250) return;
    camT = now;
    const o = { center: [S.pos.lon, S.pos.lat], duration: 600, easing: (t) => t, essential: true };
    if ((VIEWS[S.view].rotate || S.settings.rot2d) && S.heading != null) o.bearing = S.heading;
    map.easeTo(o);
  }

  /* ================= Standort ================= */
  let watchId = null;
  function startLocation() {
    if (!S.ready) { map.once('load', startLocation); return; }
    if (!('geolocation' in navigator)) { toast('Dieses Gerät meldet keinen Standort.'); return; }
    watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
  function onGeoError(e) {
    const m = { 1: 'Standortfreigabe verweigert. In den Browser-Einstellungen für diese Seite erlauben.', 2: 'Standort nicht verfügbar. Freie Sicht zum Himmel hilft.', 3: 'Standortbestimmung dauert zu lange …' };
    toast(m[e.code] || 'Standortfehler', 5000);
  }
  function onFix(p) {
    const { latitude: lat, longitude: lon, accuracy, heading: gh, speed } = p.coords;
    const first = !S.pos;
    S.pos = { lat, lon, acc: accuracy };
    S.xy = toUTM(lon, lat);
    meEl.style.display = ''; meMarker.setLngLat([lon, lat]);
    map.getSource('acc').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleRing(lon, lat, Math.max(accuracy, 1))] } });
    if (S.settings.headingSrc === 'gps' && gh != null && !isNaN(gh) && speed > 0.8) setHeading(gh);
    const b = $('acc');
    b.textContent = '±' + Math.round(accuracy) + ' m';
    b.className = 'pill ' + (accuracy <= 8 ? 'ok' : accuracy <= 20 ? 'warn' : 'bad');
    analyze();
    if (first) { S.follow = true; setView(S.view); } else followCamera();
  }

  /* ================= Kompass ================= */
  function onOri(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if ((e.type === 'deviceorientationabsolute' || e.absolute) && e.alpha != null) h = headingFromOrientation(e.alpha, e.beta || 0, e.gamma || 0);
    if (h == null) return;
    S.compassSeen = true;
    if (S.settings.headingSrc === 'compass') setHeading((h + Number(S.settings.decl) + 360) % 360);
  }
  async function startCompass() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') await DeviceOrientationEvent.requestPermission();
    } catch (e) { /* ignorieren */ }
    window.addEventListener('deviceorientationabsolute', onOri, true);
    window.addEventListener('deviceorientation', onOri, true);
    setTimeout(() => { if (!S.compassSeen) { $('hdg').textContent = 'Kein Kompass'; toast('Der Kompass liefert keine Werte. Handy kurz in einer 8 bewegen oder Richtung auf „GPS“ stellen.', 6000); } }, 4000);
  }
  let hdgQueued = false;
  function setHeading(h) {
    S.heading = S.heading == null ? h : smoothAngle(S.heading, h, 0.25);
    if (hdgQueued) return;
    hdgQueued = true;
    requestAnimationFrame(() => { hdgQueued = false; onHeading(); });
  }
  let rayT = 0;
  function onHeading() {
    meMarker.setRotation(S.heading);
    $('hdg').textContent = Math.round(S.heading) + '° ' + cardinal(S.heading);
    const now = Date.now();
    if (now - rayT > 150) { rayT = now; analyzeRay(); renderHero(); }
    followCamera();
  }

  /* ================= Analyse ================= */
  let hero = null; // letzter Messwert für die Anzeige
  function refreshLocal() {
    const [x, y] = S.xy;
    if (!S.localDirty && S.localC && Math.hypot(x - S.localC[0], y - S.localC[1]) < 40) return;
    S.localC = [x, y]; S.localDirty = false;
    const arr = [];
    for (const p of S.grid.near(x, y, CONFIG.rayLength + 50)) for (const rings of p.polys) for (const r of rings) {
      const n = r.length / 2;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; arr.push(r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]); }
    }
    S.localEdges = new Float64Array(arr);
    const a = S.areaEdges, b = [];
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - x) < 600 && Math.abs(a[i + 1] - y) < 600) b.push(a[i], a[i + 1], a[i + 2], a[i + 3]);
    S.localArea = new Float64Array(b);
  }
  function analyze() {
    if (!S.xy) return;
    const [x, y] = S.xy;
    const cur = parcelAt(x, y);
    if (cur !== S.current) {
      S.current = cur;
      S.curEdges = cur ? flatEdges(cur) : new Float64Array(0);
      if (map.getLayer('cur-fill')) map.setFilter('cur-fill', ['==', ['get', 'id'], cur ? cur.id : '__none__']);
      renderTop();
    }
    refreshLocal();
    const hasArea = S.selected.size > 0;
    const inside = hasArea ? inAny(S.selGrid, x, y) : null;
    const edges = hasArea ? S.areaEdges : S.curEdges;
    const n = edges.length ? nearestEdge(edges, x, y) : null;
    hero = { n, inside, hasArea };
    if (n) {
      const ll = toLL(n.x, n.y);
      hero.brg = bearing(S.pos.lat, S.pos.lon, ll[1], ll[0]);
    }
    analyzeRay();
    renderHero();
    maybeWarn();
  }
  let rayRes = { parcel: null, area: null };
  function analyzeRay() {
    if (!S.xy || S.heading == null) { rayRes = { parcel: null, area: null }; return; }
    const [x, y] = S.xy;
    const far = toUTM(...dest(S.pos.lat, S.pos.lon, S.heading, 300));
    const l = Math.hypot(far[0] - x, far[1] - y);
    const dx = (far[0] - x) / l, dy = (far[1] - y) / l;
    rayRes = {
      parcel: rayHit(S.localEdges, x, y, dx, dy, CONFIG.rayLength),
      area: S.localArea.length ? rayHit(S.localArea, x, y, dx, dy, CONFIG.rayLength) : null,
    };
    const first = rayRes.parcel || rayRes.area;
    const endLL = first ? toLL(first.x, first.y) : dest(S.pos.lat, S.pos.lon, S.heading, 60);
    map.getSource('ray').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[S.pos.lon, S.pos.lat], endLL] } });
    const dots = [];
    if (rayRes.parcel) dots.push({ type: 'Feature', properties: { c: '#FFD84D' }, geometry: { type: 'Point', coordinates: toLL(rayRes.parcel.x, rayRes.parcel.y) } });
    if (rayRes.area) dots.push({ type: 'Feature', properties: { c: '#FF5A1F' }, geometry: { type: 'Point', coordinates: toLL(rayRes.area.x, rayRes.area.y) } });
    map.getSource('hits').setData({ type: 'FeatureCollection', features: dots });
  }

  /* ================= Anzeige ================= */
  function renderTop() {
    const p = S.current;
    if (p) {
      $('parcelName').textContent = (p.props.gemarkung ? p.props.gemarkung + ' · ' : '') + p.label;
      $('parcelMeta').textContent = [fmtArea(p.props.amtlflae || p.props.flaeche), p.props.lagebeztxt].filter(Boolean).join(' · ') || 'Flurstück';
      $('btnHere').hidden = false;
    } else {
      $('parcelName').textContent = S.pos ? 'Kein Flurstück hier' : 'Suche Standort …';
      $('parcelMeta').textContent = S.pos ? (S.parcels.length ? 'Außerhalb der geladenen Daten' : 'Flurstücke laden: Menü') : 'Freie Sicht zum Himmel hilft';
      $('btnHere').hidden = true;
    }
    renderHere();
  }
  function renderHere() {
    const b = $('btnHere');
    if (!S.current) return;
    b.textContent = S.selected.has(S.current.id) ? 'Aus Bereich nehmen' : 'In Bereich aufnehmen';
  }
  function statusOf() {
    if (!hero || !hero.n) return { k: 'idle', t: S.pos ? 'Kein Bereich markiert' : 'Warte auf Standort' };
    const acc = S.pos ? S.pos.acc : 0, d = hero.n.d, warn = Math.max(Number(S.settings.warn), acc);
    if (!hero.hasArea) return { k: 'idle', t: 'Kein Bereich markiert' };
    if (!hero.inside) return { k: 'bad', t: 'Außerhalb deines Bereichs' };
    if (d <= warn) return { k: 'warn', t: 'Nahe an der Grenze' };
    return { k: 'ok', t: 'Innerhalb deines Bereichs' };
  }
  function renderHero() {
    const st = statusOf();
    const bn = $('banner');
    bn.className = 'banner ' + st.k; bn.textContent = st.t;
    const n = hero && hero.n;
    $('dist').textContent = n ? fmtM(n.d) : '–';
    $('distCap').textContent = !n ? 'Standort oder Flurstück fehlt'
      : hero.hasArea ? (hero.inside ? 'bis zur Bereichsgrenze' : 'zurück zum Bereich') : 'bis zur Flurstücksgrenze';
    const arrow = $('arrow');
    if (n && hero.brg != null) {
      const rel = S.heading == null ? hero.brg : angDiff(hero.brg, S.heading);
      arrow.style.transform = `rotate(${rel}deg)`; arrow.style.opacity = 1;
      const side = Math.abs(rel) < 12 ? 'voraus' : Math.abs(rel) > 168 ? 'hinter dir' : (rel > 0 ? Math.round(rel) + '° rechts' : Math.round(-rel) + '° links');
      $('distDir').textContent = S.heading == null ? 'Richtung ab Norden ' + Math.round(hero.brg) + '°' : side;
    } else { arrow.style.opacity = 0.25; $('distDir').textContent = ''; }
    const rp = rayRes.parcel, ra = rayRes.area;
    const line = (r) => (r ? fmtM(r.t) + ' m · Winkel ' + Math.round(r.angle) + '°' : '—');
    $('aheadParcel').textContent = S.heading == null ? 'Kompass wartet …' : line(rp);
    $('aheadArea').textContent = S.heading == null ? '' : line(ra);
    $('rowArea').hidden = !S.selected.size;
    if (S.pos && S.pos.acc > 12 && n && n.d < S.pos.acc) $('distCap').textContent += ' (GPS ±' + Math.round(S.pos.acc) + ' m)';
  }
  function maybeWarn() {
    const st = statusOf();
    const now = Date.now();
    if ((st.k === 'warn' || st.k === 'bad') && (st.k !== S.lastStatus || now - S.lastWarn > 6000)) {
      S.lastWarn = now;
      if (navigator.vibrate) navigator.vibrate(st.k === 'bad' ? [400, 150, 400, 150, 400] : [200, 100, 200]);
    }
    S.lastStatus = st.k;
  }
  function renderTools() {
    document.querySelectorAll('#views button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === S.view)));
    $('btnBase').setAttribute('aria-pressed', String(S.base === 'dop'));
    $('btnFollow').setAttribute('aria-pressed', String(S.follow));
    $('btnMark').setAttribute('aria-pressed', String(S.mark));
    document.body.classList.toggle('marking', S.mark);
  }
  function showPick(p) {
    S.picked = p;
    $('pickName').textContent = (p.props.gemarkung ? p.props.gemarkung + ' · ' : '') + p.label;
    $('pickMeta').textContent = [fmtArea(p.props.amtlflae || p.props.flaeche), p.props.lagebeztxt].filter(Boolean).join(' · ');
    $('pickBtn').textContent = S.selected.has(p.id) ? 'Aus Bereich nehmen' : 'In Bereich aufnehmen';
    $('pick').hidden = false;
  }
  function flashPick(p) { S.picked = p; showPick(p); }
  function hidePick() { $('pick').hidden = true; S.picked = null; }

  /* ================= Menü ================= */
  function openSheet() { $('sheet').hidden = false; renderDataList(); }
  function closeSheet() { $('sheet').hidden = true; }
  function bindSettings() {
    const s = S.settings;
    $('setGem').value = s.gemarkungen; $('setWarn').value = s.warn; $('setDecl').value = s.decl;
    $('setSrc').value = s.headingSrc; $('setRot2d').checked = !!s.rot2d;
    const save = () => {
      s.gemarkungen = $('setGem').value; s.warn = Number($('setWarn').value) || 10; s.decl = Number($('setDecl').value) || 0;
      s.headingSrc = $('setSrc').value; s.rot2d = $('setRot2d').checked;
      DB.set('settings', s); renderDataList(); if (S.xy) analyze();
    };
    ['setGem', 'setWarn', 'setDecl', 'setSrc', 'setRot2d'].forEach((id) => $(id).addEventListener('change', save));
  }

  /* ================= Start ================= */
  let wake = null;
  async function keepAwake() { try { wake = await navigator.wakeLock.request('screen'); } catch (e) { /* nicht verfügbar */ } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.started) keepAwake(); });

  async function init() {
    const saved = await DB.get('settings');
    if (saved) S.settings = { ...DEFAULTS, ...saved };
    bindSettings();
    $('btnStart').addEventListener('click', async () => {
      $('start').hidden = true; S.started = true;
      startLocation(); await startCompass(); keepAwake();
    });
    document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('btnBase').addEventListener('click', () => setBase(S.base === 'osm' ? 'dop' : 'osm'));
    $('btnFollow').addEventListener('click', () => { S.follow = true; setView(S.view); });
    $('btnMark').addEventListener('click', () => { S.mark = !S.mark; $('markCount').textContent = S.selected.size; hidePick(); renderTools(); if (S.mark) toast('Flurstücke antippen, um sie aufzunehmen oder zu entfernen.', 4500); });
    $('btnMenu').addEventListener('click', openSheet);
    $('btnClose').addEventListener('click', closeSheet);
    $('btnLoad').addEventListener('click', downloadData);
    $('btnClear').addEventListener('click', () => { S.selected.clear(); recomputeArea(); analyze(); renderHere(); toast('Bereich geleert.'); });
    $('btnHere').addEventListener('click', () => { if (S.current) { toggleSelect(S.current.id); setTimeout(renderHere, 300); } });
    $('pickBtn').addEventListener('click', () => { if (S.picked) { toggleSelect(S.picked.id); setTimeout(() => showPick(S.picked), 10); } });
    $('pickClose').addEventListener('click', hidePick);
    $('btnDone').addEventListener('click', () => { S.mark = false; renderTools(); });
    renderTools(); renderTop(); renderHero();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  init();
})();
