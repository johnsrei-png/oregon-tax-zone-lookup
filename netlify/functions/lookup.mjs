// Looks up tax-relevant boundaries for an Oregon address.
//
// 1. Geocode with the U.S. Census geocoder (also returns county + incorporated city).
// 2. Metro boundary + Portland city limits: live query to Metro's RLIS ArcGIS service.
// 3. Transit district: point-in-polygon against GeoJSON files bundled in /data.
// 4. Flags addresses within NEAR_BOUNDARY_FEET of any relevant boundary.

import {
  METRO_CITY_LIMITS,
  METRO_DISTRICT,
  NEAR_BOUNDARY_FEET,
  attrsMention,
  feetToNearestEdge,
  laneTransit,
  loadMetroShapes,
  pointInFeature,
  queryPoint,
  transitFeatures,
} from "../lib/geo.mjs";

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";

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
  const pt = [lon, lat];
  const geos = match.geographies || {};
  const state = geos.States?.[0]?.STUSAB || geos.States?.[0]?.NAME;
  if (state && !/^(OR|Oregon)$/i.test(state)) notes.push("This address is outside Oregon.");
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
    notes.push("Metro's map service didn't respond, so the Portland check used Census data and the Metro check was skipped.");
    inPortland = censusCity ? /^portland$/i.test(censusCity) : false;
  }

  // ---- 3. Transit district ----
  if (transitFeatures.length === 0) notes.push("Transit boundary files haven't been added yet. See README.");
  const transitHits = transitFeatures.filter((f) => pointInFeature(pt, f));
  const transitNames = [...new Set(transitHits.map((f) => f._name.label))];
  let transitDistrict = transitNames.length ? transitNames.join(" / ") : "None of the listed districts";
  if (transitNames.length > 1) notes.push("Address falls in more than one transit district. Confirm with Oregon DOR.");

  // Temporary fallback until an LTD boundary file is added to data/lane-transit-district.json.
  const hasLtdBoundary = (laneTransit.features || []).length > 0;
  let ltdFallback = false;
  if (!transitNames.length && !hasLtdBoundary && /^lane$/i.test(county || "")) {
    transitDistrict = "Likely Lane Transit District (LTD)";
    ltdFallback = true;
    notes.push("Lane County address. The app doesn't have LTD's boundary yet, so confirm with Oregon DOR.");
  }

  // ---- 4. Near-boundary checks ----
  const nearBoundaries = [];
  const flagIfNear = (label, feet) => {
    if (Number.isFinite(feet) && feet <= NEAR_BOUNDARY_FEET) {
      nearBoundaries.push({ label, feet: Math.round(feet) });
    }
  };
  // Transit: distance to the edge of each nearby district, reported per district.
  for (const f of transitFeatures) {
    flagIfNear(`${f._name.short} transit district edge`, feetToNearestEdge(pt, [f]));
  }
  try {
    const { metro, portland } = await loadMetroShapes();
    flagIfNear("Metro tax boundary", feetToNearestEdge(pt, metro.features));
    flagIfNear("City of Portland limits", feetToNearestEdge(pt, portland.features));
  } catch (err) {
    notes.push("Couldn't load Metro boundary shapes, so the Metro and Portland edge checks were skipped.");
  }
  if (nearBoundaries.length) {
    notes.push(`Within ${NEAR_BOUNDARY_FEET} feet of a boundary. Geocoded locations can be off by this much, so confirm with the official lookup.`);
  }

  // ---- 5. Business tax ----
  let businessTax;
  if (inPortland) businessTax = "Yes: City of Portland and Multnomah County";
  else if (/^multnomah$/i.test(county || "")) businessTax = "Yes: Multnomah County only (outside City of Portland)";
  else businessTax = "No";

  if (/non_exact/i.test(match.matchType || "")) {
    notes.push("The geocoder made an approximate match. Double-check the matched address.");
  }

  const needsReview = notes.length > 0 || nearBoundaries.length > 0 || ltdFallback;

  return json(200, {
    input: address,
    matchedAddress: match.matchedAddress,
    lat,
    lon,
    county,
    city: censusCity,
    transitDistrict,
    inMetro,
    inPortland,
    businessTax,
    nearBoundaries,
    needsReview,
    notes,
  });
}
