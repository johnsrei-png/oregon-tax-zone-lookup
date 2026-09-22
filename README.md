# Oregon Tax District Lookup

Search an Oregon address (or upload a spreadsheet of them) and get:

1. Transit district (TriMet, SMART, SCTD, SAM, LTD, CAT)
2. County
3. Whether it's inside the Oregon Metro tax boundary
4. Whether it's in the City of Portland / Multnomah County business tax area

Results come from public boundary data and are not an official tax determination.

## How it works

The page (`public/index.html`) calls one Netlify Function (`netlify/functions/lookup.mjs`), which:

- Geocodes the address with the free U.S. Census geocoder. This also returns the county and incorporated city.
- Asks Metro's live RLIS map service whether the point is inside the Metro District Boundary and the Portland city limits.
- Checks the point against transit district boundary files stored in `data/`.

Running the lookups in a Netlify Function (instead of in the browser) avoids cross-site request problems with the Census and Metro services. No API keys are needed.

## Setup

### 1. Add the transit district boundary files (required)

The two files in `data/` are empty placeholders. Replace them with real boundaries:

**`data/transit-districts.json`** (TriMet, SMART, SCTD, SAM, CAT)

1. Go to RLIS Discovery: https://rlisdiscovery.oregonmetro.gov/datasets/drcMetro::transit-districts
2. Download it as **GeoJSON**.
3. Rename the file to `transit-districts.json` and put it in `data/`.
4. Open it and check which districts it includes. If any of the five are missing, you'll need a boundary file from that district.

**`data/lane-transit-district.json`** (LTD)

LTD is outside Metro's region, so its boundary comes from a Lane County source, such as the Lane Council of Governments GIS data, LTD directly, or Lane County GIS. Download as GeoJSON, rename to `lane-transit-district.json`, and put it in `data/`.

Both files must be GeoJSON in standard latitude/longitude (WGS84). ArcGIS Hub GeoJSON downloads already are. If you only have a shapefile, convert it at https://mapshaper.org (Export → GeoJSON).

The function matches district names loosely (for example, anything containing "Canby" becomes Canby Area Transit (CAT)). If a district shows up under an odd name, adjust `TRANSIT_NAME_RULES` at the top of `lookup.mjs`.

### 2. Put it on GitHub

Create a new repository and push this folder to it.

### 3. Deploy on Netlify

1. In Netlify: **Add new site → Import an existing project → GitHub**, and pick the repo.
2. Leave the build command blank. `netlify.toml` already sets the publish folder (`public`) and functions folder.
3. Deploy.

Every push to GitHub redeploys the site automatically.

### Local testing (optional)

```
npm install -g netlify-cli
netlify dev
```

Then open http://localhost:8888.

## Keeping it accurate

- **Metro boundary and Portland city limits** are queried live, so annexations show up as soon as Metro updates its data (quarterly).
- **Transit districts** are a snapshot. Re-download the files every few months, or when a district annexes new territory, and push the update.
- **Rural and edge addresses:** the Census geocoder places some rural addresses by interpolating along the road, which can be off by a few hundred feet. Anything the app flags, and anything near a district edge, should be confirmed with the Oregon Department of Revenue transit tax lookup and Metro's address lookup.

## Business tax logic

- Inside City of Portland limits → "Yes: City of Portland and Multnomah County"
- In Multnomah County but outside Portland → "Yes: Multnomah County only"
- Otherwise → "No"
