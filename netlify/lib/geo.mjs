// Shared helpers for the lookup and boundaries functions.

import transitDistricts from "../../data/transit-districts.json";
import laneTransit from "../../data/lane-transit-district.json";
import meta from "../../data/meta.json";

export { meta, laneTransit };

const METRO_LAYERS =
  "https://gis.oregonmetro.gov/arcgis/rest/services/OpenData/BoundaryDataWebMerc/MapServer";
export const METRO_CITY_LIMITS = `${METRO_LAYERS}/0`;
export const METRO_DISTRICT = `${METRO_LAYERS}/3`;

// Anything closer than this to a boundary gets flagged for review.
export const NEAR_BOUNDARY_FEET = 500;

// Maps whatever name the boundary file uses to the district names on your list.
// Order matters: more specific patterns first.
const TRANSIT_NAME_RULES = [
  [/south clackamas|molalla|sctd/i, "South Clackamas Transportation District (SCTD)", "SCTD"],
  [/canby|\bcat\b/i, "Canby Area Transit (CAT)", "CAT"],
  [/wilsonville|smart/i, "Wilsonville Transit District (SMART)", "SMART"],
  [/sandy|\bsam\b/i, "Sandy Area Metro (SAM)", "SAM"],
  [/lane transit|\bltd\b/i, "Lane Transit District (LTD)", "LTD"],
  [/tri[- ]?met|tri-county|tri county/i, "Tri-County Metropolitan Transportation District (TriMet)", "TriMet"],
];

function transitLabel(feature) {
  const text = Object.values(feature.properties || {})
    .filter((v) => typeof v === "string")
    .join(" ");
  for (const [pattern, label, short] of TRANSIT_NAME_RULES) {
    if (pattern.test(text)) return { label, short };
  }
  return { label: text || "Unnamed transit district", short: text || "Other" };
}

// Transit features with normalized names attached once at load.
export const transitFeatures = [
  ...(transitDistricts.features || []),
  ...(laneTransit.features || []),
].map((f) => ({ ...f, _name: transitLabel(f) }));

// ---------- Live Metro services ----------

export async function queryPoint(layerUrl, lon, lat) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "false",
    f: "json",
  });
  const res = await fetch(`${layerUrl}/query?${params}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.features || [];
}

export function attrsMention(attrs = {}, pattern) {
  return Object.values(attrs).some((v) => typeof v === "string" && pattern.test(v.trim()));
}

// Boundary shapes for the map and edge-distance checks. Cached for the life of
// the function instance so they're only downloaded occasionally.
let metroShapesPromise = null;
export function loadMetroShapes() {
  if (!metroShapesPromise) {
    metroShapesPromise = (async () => {
      const [metro, cities] = await Promise.all([
        fetchGeoJSON(METRO_DISTRICT),
        fetchGeoJSON(METRO_CITY_LIMITS),
      ]);
      const portland = {
        type: "FeatureCollection",
        features: cities.features.filter((f) => attrsMention(f.properties, /^portland$/i)),
      };
      return { metro, portland };
    })().catch((err) => {
      metroShapesPromise = null; // retry next time
      throw err;
    });
  }
  return metroShapesPromise;
}

async function fetchGeoJSON(layerUrl) {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    maxAllowableOffset: "0.00003", // ~3 m simplification
    f: "geojson",
  });
  const res = await fetch(`${layerUrl}/query?${params}`);
  const data = await res.json();
  if (data.error || !data.features) throw new Error(data.error?.message || "No features returned");
  return data;
}

// ---------- Geometry ----------

export function pointInFeature(pt, feature) {
  const g = feature.geometry;
  if (!g) return false;
  if (g.type === "Polygon") return pointInPolygon(pt, g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.some((p) => pointInPolygon(pt, p));
  return false;
}

function pointInPolygon(pt, rings) {
  if (!inRing(pt, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (inRing(pt, rings[i])) return false;
  return true;
}

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringsOf(feature) {
  const g = feature.geometry;
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates;
  if (g.type === "MultiPolygon") return g.coordinates.flat();
  return [];
}

// Shortest distance in feet from a point to any edge of the features.
// Uses a local flat-earth projection, accurate to well under 1% at this scale.
export function feetToNearestEdge([lon, lat], features) {
  const mPerDegLat = 110540;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const f of features) {
    for (const ring of ringsOf(f)) {
      for (let i = 1; i < ring.length; i++) {
        const ax = (ring[i - 1][0] - lon) * mPerDegLon;
        const ay = (ring[i - 1][1] - lat) * mPerDegLat;
        const bx = (ring[i][0] - lon) * mPerDegLon;
        const by = (ring[i][1] - lat) * mPerDegLat;
        const d = distToSegment(ax, ay, bx, by);
        if (d < best) best = d;
      }
    }
  }
  return best * 3.28084;
}

function distToSegment(ax, ay, bx, by) {
  // distance from origin (the address) to segment AB
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.hypot(px, py);
}

// Douglas-Peucker simplification so the map download stays small.
export function simplifyFeature(feature, tolerance) {
  const g = feature.geometry;
  const simplifyRing = (ring) => {
    if (ring.length < 5) return ring;
    const out = dp(ring, tolerance);
    return out.length >= 4 ? out : ring;
  };
  let coordinates;
  if (g.type === "Polygon") coordinates = g.coordinates.map(simplifyRing);
  else if (g.type === "MultiPolygon") coordinates = g.coordinates.map((p) => p.map(simplifyRing));
  else return feature;
  return { ...feature, geometry: { type: g.type, coordinates } };
}

function dp(points, tol) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    const [x1, y1] = points[s];
    const [x2, y2] = points[e];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-12;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
