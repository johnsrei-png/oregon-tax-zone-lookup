// Looks up tax-relevant boundaries for an Oregon address.
//
// 1. Geocode with the U.S. Census geocoder (also returns county + incorporated city).
// 2. Metro boundary + Portland city limits: live query to Metro's RLIS ArcGIS service.
// 3. Transit district: point-in-polygon against GeoJSON files bundled in /data
//    (RLIS "Transit Districts" layer + an LTD boundary file).

import transitDistricts from "../../data/transit-districts.json";
import laneTransit from "../../data/lane-transit-district.json";

const CENSUS_URL =
  "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const METRO_BOUNDARY_LAYERS =
  "https://gis.oregonmetro.gov/arcgis/rest/services/OpenData/BoundaryDataWebMerc/MapServer";
const METRO_CITY_LIMITS = `${METRO_BOUNDARY_LAYERS}/0`;
const METRO_DISTRICT = `${METRO_BOUNDARY_LAYERS}/3`;

// Maps whatever name the boundary file uses to the district names on your list.
// Order matters: more specific patterns first.
const TRANSIT_NAME_RULES = [
  [/south clackamas|molalla|sctd/i, "South Clackamas Transportation District (SCTD)"],
  [/canby|\bcat\b/i, "Canby Area Transit (CAT)"],
  [/wilsonville|smart/i, "Wilsonville Transit District (SMART)"],
  [/sandy|\bsam\b/i, "Sandy Area Metro (SAM)"],
  [/lane|ltd/i, "Lane Transit District (LTD)"],
  [/tri[- ]?met|tri-county|tri county/i, "Tri-County Metropolitan Transportation District (TriMet)"],
];

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

export async function handler(event) {
  const address = (event.queryStringParameters?.address || "").trim();
  if (!address) return json(400, { error: "Enter an address to look up." });

  const notes = [];

  // ---- 1. Geocode ----
  let match;
  try {
    const params = new URLSearchParams({
      address,
      benchmark: "Public_AR_Current",
      vintage: "Current_Current",
      layers: "all",
      format: "json",
    });
    const res = await fetch(`${CENSUS_URL}?${params}`);
    const data = await res.json();
    match = data?.result?.addressMatches?.[0];
  } catch (err) {
    return json(502, { error: "The Census geocoder didn't respond. Try again in a moment." });
  }
  if (!match) {
    return json(404, {
      error: "No match for that address. Check the street name and include the city and ZIP.",
    });
  }

  const lon = match.coordinates.x;
  const lat = match.coordinates.y;
  const geos = match.geographies || {};
  const state = geos.States?.[0]?.STUSAB || geos.States?.[0]?.NAME;
  if (state && !/^(OR|Oregon)$/i.test(state)) {
    notes.push("This address is outside Oregon.");
  }
  const county = (geos.Counties?.[0]?.NAME || "").replace(/ County$/i, "") || null;
  const censusCity = (geos["Incorporated Places"]?.[0]?.NAME || "").replace(/ city$/i, "") || null;

  // ---- 2. Metro boundary + Portland city limits (live) ----
  let inMetro = null;
  let inPortland = null;
  try {
    const [metroHits, cityHits] = await Promise.all([
      queryPoint(METRO_DISTRICT, lon, lat),
      queryPoint(METRO_CITY_LIMITS, lon, lat),
    ]);
    inMetro = metroHits.length > 0;
    inPortland = cityHits.some((f) => attrsMention(f.attributes, /^portland$/i));
  } catch (err) {
    notes.push("Metro's map service didn't respond, so the Metro and Portland checks used backup data.");
    inPortland = censusCity ? /^portland$/i.test(censusCity) : false;
  }

  // ---- 3. Transit district (bundled boundaries) ----
  const transitFeatures = [
    ...(transitDistricts.features || []),
    ...(laneTransit.features || []),
  ];
  if (transitFeatures.length === 0) {
    notes.push("Transit boundary files haven't been added yet. See README.");
  }
  const transitHits = transitFeatures.filter((f) => pointInFeature([lon, lat], f));
  const transitNames = [...new Set(transitHits.map(normalizeTransitName))];
  let transitDistrict = transitNames.length ? transitNames.join(" / ") : "None of the listed districts";
  if (transitNames.length > 1) notes.push("Address falls in more than one transit district polygon. Confirm with Oregon DOR.");

  // Temporary fallback until an LTD boundary file is added to data/lane-transit-district.json.
  const hasLtdBoundary = (laneTransit.features || []).length > 0;
  if (!transitNames.length && !hasLtdBoundary && /^lane$/i.test(county || "")) {
    transitDistrict = "Likely Lane Transit District (LTD)";
    notes.push("Lane County address. The app doesn't have LTD's boundary yet, so confirm with the Oregon DOR transit tax lookup.");
  }

  // ---- 4. Business tax ----
  let businessTax;
  if (inPortland) businessTax = "Yes: City of Portland and Multnomah County";
  else if (/^multnomah$/i.test(county || "")) businessTax = "Yes: Multnomah County only (outside City of Portland)";
  else businessTax = "No";

  if (match.tigerLine && /non_exact/i.test(match.matchType || "")) {
    notes.push("The geocoder made an approximate match. Double-check the matched address.");
  }

  return json(200, {
    input: address,
    matchedAddress: match.matchedAddress,
    lat,
    lon,
    county,
    city: censusCity,
    transitDistrict,
    inMetro,
    businessTax,
    notes,
  });
}

// ArcGIS "which polygons contain this point?" query.
async function queryPoint(layerUrl, lon, lat) {
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

function attrsMention(attrs = {}, pattern) {
  return Object.values(attrs).some((v) => typeof v === "string" && pattern.test(v.trim()));
}

function normalizeTransitName(feature) {
  const text = Object.values(feature.properties || {})
    .filter((v) => typeof v === "string")
    .join(" ");
  for (const [pattern, label] of TRANSIT_NAME_RULES) {
    if (pattern.test(text)) return label;
  }
  return text || "Unnamed transit district";
}

// ---- Point-in-polygon (ray casting), handles holes and MultiPolygons ----
function pointInFeature(pt, feature) {
  const g = feature.geometry;
  if (!g) return false;
  if (g.type === "Polygon") return pointInPolygon(pt, g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.some((poly) => pointInPolygon(pt, poly));
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

export const _test = { pointInFeature, normalizeTransitName };
