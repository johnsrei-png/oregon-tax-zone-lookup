// Serves simplified boundary shapes for the map, plus data-freshness info.
// Browsers and Netlify's CDN cache the response for a day.

import { loadMetroShapes, meta, simplifyFeature, transitFeatures } from "../lib/geo.mjs";

const MAP_TOLERANCE = 0.00008; // ~8 m, plenty for drawing on a map

// 5 decimal places is about 1 meter, and cuts the download size roughly in half.
const round = (c) => (typeof c[0] === "number" ? [+c[0].toFixed(5), +c[1].toFixed(5)] : c.map(round));
const roundGeometry = (g) => ({ type: g.type, coordinates: round(g.coordinates) });

export async function handler() {
  const transit = {
    type: "FeatureCollection",
    features: transitFeatures.map((f) => ({
      type: "Feature",
      properties: { name: f._name.label, short: f._name.short },
      geometry: roundGeometry(simplifyFeature(f, MAP_TOLERANCE).geometry),
    })),
  };

  let metro = null;
  let portland = null;
  try {
    const shapes = await loadMetroShapes();
    metro = shapes.metro;
    portland = shapes.portland;
  } catch (err) {
    // Map still works with transit districts only.
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=86400",
    },
    body: JSON.stringify({ meta, transit, metro, portland }),
  };
}
