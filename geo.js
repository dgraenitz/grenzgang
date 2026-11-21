/* Grenzgang – Geometrie. Alle Koordinaten in Metern (ETRS89 / UTM 33N), außer lat/lon-Funktionen. */
(function (root) {
  'use strict';
  const RAD = Math.PI / 180;

  /* ---------- Punkt in Fläche ---------- */
  function ringContains(r, x, y) {
    let inside = false;
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function polyContains(rings, x, y) {
    if (!ringContains(rings[0], x, y)) return false;
    for (let k = 1; k < rings.length; k++) if (ringContains(rings[k], x, y)) return false;
    return true;
  }
  function parcelContains(p, x, y) {
    const b = p.bbox;
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
    for (const rings of p.polys) if (polyContains(rings, x, y)) return true;
    return false;
  }
  function bboxOf(polys) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const rings of polys) {
      const r = rings[0];
      for (let i = 0; i < r.length; i += 2) {
        if (r[i] < a) a = r[i];
        if (r[i] > c) c = r[i];
        if (r[i + 1] < b) b = r[i + 1];
        if (r[i + 1] > d) d = r[i + 1];
      }
    }
    return [a, b, c, d];
  }

  /* ---------- Raster-Index ---------- */
  class Grid {
    constructor(cell) { this.c = cell || 200; this.m = new Map(); }
    add(p) {
      const c = this.c, b = p.bbox;
      for (let i = Math.floor(b[0] / c); i <= Math.floor(b[2] / c); i++)
        for (let j = Math.floor(b[1] / c); j <= Math.floor(b[3] / c); j++) {
          const k = i + ',' + j;
          let l = this.m.get(k);
          if (!l) this.m.set(k, (l = []));
          l.push(p);
        }
    }
    at(x, y) { return this.m.get(Math.floor(x / this.c) + ',' + Math.floor(y / this.c)) || []; }
    near(x, y, r) {
      const c = this.c, s = new Set();
      for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++)
        for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) {
          const l = this.m.get(i + ',' + j);
          if (l) for (const p of l) s.add(p);
        }
      return Array.from(s);
    }
  }
  function inAny(grid, x, y) {
    for (const p of grid.at(x, y)) if (parcelContains(p, x, y)) return true;
    return false;
  }

  /* ---------- Kanten ---------- */
  function flatEdges(p) {
    const out = [];
    for (const rings of p.polys) for (const r of rings) {
      const n = r.length / 2;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; out.push(r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]); }
    }
    return new Float64Array(out);
  }

  /* Außenkanten der Vereinigung mehrerer Flurstücke: eine Kante gehört zur Außengrenze,
     wenn genau eine ihrer beiden Seiten (±0,2 m) in der Auswahl liegt. */
  function outerEdges(sel) {
    const g = new Grid(100);
    sel.forEach((p) => g.add(p));
    const out = [], off = 0.2;
    for (const p of sel) for (const rings of p.polys) for (const r of rings) {
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * j], by = r[2 * j + 1];
        const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
        if (l < 0.02) continue;
        const mx = (ax + bx) / 2, my = (ay + by) / 2, nx = (-dy / l) * off, ny = (dx / l) * off;
        if (inAny(g, mx + nx, my + ny) !== inAny(g, mx - nx, my - ny)) out.push(ax, ay, bx, by);
      }
    }
    return new Float64Array(out);
  }

  /* ---------- Abstand & Strahl ---------- */
  function nearestEdge(edges, px, py) {
    let best = Infinity, bx = 0, by = 0;
    for (let i = 0; i < edges.length; i += 4) {
      const ax = edges[i], ay = edges[i + 1], dx = edges[i + 2] - ax, dy = edges[i + 3] - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = Math.hypot(px - qx, py - qy);
      if (d < best) { best = d; bx = qx; by = qy; }
    }
    return best === Infinity ? null : { d: best, x: bx, y: by };
  }

  /* Erster Treffer eines Strahls (px,py)+t*(dx,dy), |d|=1, mit den Kanten. Liefert Entfernung und Schnittwinkel (0–90°). */
  function rayHit(edges, px, py, dx, dy, maxT) {
    let bestT = maxT, bi = -1;
    for (let i = 0; i < edges.length; i += 4) {
      const ax = edges[i], ay = edges[i + 1], ex = edges[i + 2] - ax, ey = edges[i + 3] - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const apx = ax - px, apy = ay - py;
      const t = (apx * ey - apy * ex) / den;
      const u = (apx * dy - apy * dx) / den;
      if (t >= 0 && t < bestT && u >= 0 && u <= 1) { bestT = t; bi = i; }
    }
    if (bi < 0) return null;
    const ex = edges[bi + 2] - edges[bi], ey = edges[bi + 3] - edges[bi + 1];
    const cos = Math.abs(dx * ex + dy * ey) / Math.hypot(ex, ey);
    return { t: bestT, x: px + dx * bestT, y: py + dy * bestT, angle: Math.acos(Math.min(1, cos)) / RAD };
  }

  /* ---------- Richtungen (lat/lon, Grad) ---------- */
  function bearing(lat1, lon1, lat2, lon2) {
    const dl = (lon2 - lon1) * RAD;
    const y = Math.sin(dl) * Math.cos(lat2 * RAD);
    const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos(dl);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  function dest(lat, lon, brg, d) {
    const R = 6371008.8, dl = d / R, th = brg * RAD, p1 = lat * RAD, l1 = lon * RAD;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(dl) + Math.cos(p1) * Math.sin(dl) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dl) * Math.cos(p1), Math.cos(dl) - Math.sin(p1) * Math.sin(p2));
    return [l2 / RAD, p2 / RAD];
  }
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180; // a-b in −180…180
  const smoothAngle = (prev, next, k) => (prev + k * angDiff(next, prev) + 360) % 360;
  const CARD = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  const cardinal = (h) => CARD[Math.round(h / 45) % 8];

  /* Kompass aus Gerätelage. Flach gehalten: Richtung der Oberkante; aufrecht: Richtung der Rückseite. */
  function headingFromOrientation(alpha, beta, gamma) {
    if (Math.abs(beta) <= 50) return (360 - alpha) % 360;
    const x = beta * RAD, y = gamma * RAD, z = alpha * RAD;
    const cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    const vx = -cZ * sY - sZ * sX * cY, vy = -sZ * sY + cZ * sX * cY;
    return (Math.atan2(vx, vy) / RAD + 360) % 360;
  }

  function circleRing(lon, lat, r, n) {
    n = n || 40;
    const dlat = r / 111320, dlon = r / (111320 * Math.cos(lat * RAD)), out = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      out.push([lon + dlon * Math.sin(a), lat + dlat * Math.cos(a)]);
    }
    return out;
  }

  const api = { ringContains, polyContains, parcelContains, bboxOf, Grid, inAny, flatEdges, outerEdges,
    nearestEdge, rayHit, bearing, dest, angDiff, smoothAngle, cardinal, headingFromOrientation, circleRing };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof self !== 'undefined' ? self : this);
