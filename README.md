# Merobiman — working milestone 02

Map-first Earth-system trend investigation for the NASA Space Apps Challenge, by team Merobiman.
**React + Tailwind CSS + TypeScript; Go backend; MapLibre globe/flat map; OpenStreetMap basemap.**

This is a real-data, runnable research prototype—not a finished challenge submission,
not a live weather forecast, and not a climate attribution system.

## What is implemented in v0.2

All six layers are visible and selectable on the globe / flat map. **Not all layers support numerical trends.**

| Layer | Real source / bundled date | Implemented analysis | Not implemented |
| --- | --- | --- | --- |
| Temperature | NASA GISTEMP v4, complete years 1880–2025 | Existing regional annual series, trend, HAC uncertainty, global BH stippling; CSV/JSON | Climate attribution |
| Air streams | Metop-C ASCAT via NOAA ERDDAP, September 2026 monthly composite (time coordinate September 16) | Real u/v arrows, accelerated particles, nearest sampled vector, weighted regional speed / direction; JSON | Land winds, forecasts, transport modelling, temporal trends |
| Water streams | NASA/JPL OSCAR v1 via NOAA mirror, **2014-09-26 archive** | Real u/v arrows, particles, point/region speed and direction; JSON | Live 2026 currents, transport modelling, temporal trends |
| Air-pollution indicator | NASA Terra MODIS aerosol optical depth, 2026-10-28 default | NASA rendered observation imagery, date selection, official legend | AQI, surface PM2.5, point concentrations, numerical trends/significance |
| Water-quality indicator | NASA Aqua MODIS chlorophyll-a, 2026-10-28 default | NASA imagery, date selection, official legend | Pollution/safety diagnosis, toxin/pathogen readings, numerical trends/significance |
| Habitat context | NASA Aqua MODIS monthly NDVI, September 2026 default | NASA vegetation imagery, month selection, official legend | Species suitability, biodiversity, habitat-loss inference, numerical trends/significance |

The app opens on **temperature trend analysis**, following the challenge workflow: choose a variable, region and time period; view a time series; and inspect the p-value and significance at the 0.05 threshold. Only temperature currently supports quantitative time-series trends; the other layers are snapshots or visual indicators. Annual values are calculated from complete years of monthly GISTEMP data, not weekly or monthly observations.

### AI assistance disclosure
Notion AI assisted in developing and revising the code, tests, documentation, and project presentation. NASA and other source observations are not AI-generated. The human participant is responsible for reviewing the implementation, results, provenance, and submission.

### Windows: no installation or NASA download required

Extract the entire archive (do not run the EXE inside the ZIP). Double-click **`start-windows.bat`**, then open **http://localhost:8080**. Stop with Ctrl+C.

Or, in PowerShell from the extracted `merobiman` folder:

```powershell
.\bin\merobiman-windows-amd64.exe
```

If you prefer source development, the reported startup problem is fixed:

```powershell
cd backend
go run .
```

The default data file is now found from either the project root or `backend` directory, or relative to the executable. An explicit override still works: `go run . -data "..\data\gistemp.nc.gz"`. Keep `data` and `bin` in their extracted layout. If a NASA connection fails, verify the bundled file exists before attempting a new download.

### Scientific limits of the additional layers

- Wind: speed is `hypot(mean_u, mean_v)`, **not** the mean of instantaneous wind speeds. ASCAT ocean retrievals do not cover land. The provider's metadata title says 0.25°, but its published coordinates have approximately 1/3° spacing; v0.2 samples every ninth coordinate (~3°), without averaging.
- Currents: the accessible NOAA mirror is a **historical 2014 archive**, despite its “present” title. The file's actual time is displayed and exported. Native grid ~1/3°, nominal 15 m depth; sampled every sixth coordinate (~2°). New OSCAR products need a separate, verified adapter.
- Vector summaries: cos(latitude)-weighted valid sampled centers inside bounds. Mean magnitude and magnitude of the mean vector differ; opposite directions can cancel. Bearings point **TO** (clockwise from north), not meteorological FROM. Zero vectors have undefined direction (`null`). These are neither exact boundary-integrated fluxes nor forecasts.
- Animation: nearest-sample u/v advection, 1 day per display second for wind; 30 days per display second for currents, with a steady field held solely for visualization (not a trajectory forecast). Arrows are schematic, not travel distances. Reduced-motion preference disables animation; static arrows retain direction information.
- Imagery: NASA GIBS rendered products are visual indicators, not raw time-series retrieval arrays. Gaps/clouds are not zeros. The app does **not** invent p-values or concentration readings from RGB pixels. To support quantitative pollution or habitat trends, add numerical quality-screened retrievals, seasonal/cloud sampling treatment, robust uncertainty and independent validation.
- Connectivity: numerical vector snapshots, default-date coarse global NASA overviews, official legends, and country outlines are bundled. OSM basemaps, detailed NASA tiles, and other observation dates require internet. No silent date substitution is used. Mercator satellite imagery does not include the polar caps. Default overview is only 256 × 256, not native product resolution.
- Satellite reproducibility: layer ID and observation date are exported, but GIBS historical imagery can be reprocessed. Numerical research must pin raw product versions, QA flags and checksums instead. Bundled vector hashes and imagery download manifest are included.

### New API endpoints

- `GET /api/systems` — available environmental datasets and capabilities.
- `GET /api/flow?id=wind|currents` — finite real u/v samples, date, units/context, source SHA-256.
- `GET /api/flow/analyze?id=wind&west=-70&east=0&south=10&north=60` — sampled regional summary, methods and limitations.
- `GET /api/indicator/{air|water|habitat}/{overview.png|legend.svg}` — bundled imagery assets.
- `GET /api/tiles/{id}/{YYYY-MM-DD}/{z}/{y}/{x}.png` — date-validated, source-whitelisted NASA GIBS proxy. No arbitrary URL fetching.

Source metadata: [ASCAT NOAA mirror](https://coastwatch.pfeg.noaa.gov/erddap/info/erdQCwindproductsMonthly/index.html), [OSCAR NOAA archive](https://coastwatch.pfeg.noaa.gov/erddap/info/jplOscar/index.html), [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-and-software/earthdata-developer-portal/gibs-api).

## Quick start (Linux x86_64, no build tools required)

```sh
chmod +x run.sh bin/merobiman-linux-amd64
./run.sh
```

Open **http://localhost:8080** in your browser. Stop with Ctrl+C.
The bundled NASA `.nc.gz` snapshot allows analysis without a data download.
OSM basemap tiles require internet. Geographic outlines and the NASA field are bundled;
no third-party map tiles are cached in this archive.

## Build from source (macOS, Windows, Linux)

Requires **Go 1.24+**, **Node 20.19+ or 22.12+**, npm.

```sh
cd frontend
npm ci
npm run build
cd ..
# Copy frontend/dist contents into backend/static, replacing the old contents.
# macOS/Linux:
rm -rf backend/static && cp -R frontend/dist backend/static
cd backend
go test ./...
go build -o ../bin/merobiman .
cd ..
./bin/merobiman -data data/gistemp.nc.gz
```

Windows PowerShell equivalent for the final build/copy steps:

```powershell
Remove-Item backend/static -Recurse -Force
Copy-Item frontend/dist backend/static -Recurse
cd backend
go test ./...
go build -o ../bin/merobiman.exe .
cd ..
./bin/merobiman.exe -data data/gistemp.nc.gz
```

`make build` does the frontend copy/build on systems with Make.
To bind to another interface use `-addr 0.0.0.0:8080`; do not expose this prototype
publicly without the operational hardening described below.

### Development

Terminal 1, from project root:

```sh
cd backend
go run .
```

Terminal 2:

```sh
cd frontend
npm ci
npm run dev
```

Vite proxies `/api` to Go on port 8080. Open the Vite URL (usually localhost:5173).
Python is **not** required to run or build the app. The optional Python validation
script is an independent development oracle, not part of the backend architecture.

## Implemented

- Interactive globe and flat map, OSM raster basemap, Natural Earth boundary overlay.
- Native 2° grid temperature trend field, annual anomaly field, and temporal-coverage field.
- Historical anomaly year scrubber (complete years only).
- Configurable trend period with a 30-year minimum.
- Cell inspection, preset bounding-box regions, two-click rectangle selection,
  and keyboard-accessible numeric bounds.
- Constant-footprint regional aggregation using exact spherical rectangle overlap weights.
- OLS trends per decade with Newey–West HAC uncertainty.
- Global Benjamini–Hochberg q-values, optional significance stippling.
- Regional annual observation table, JSON analysis export, and CSV export.
- Source-file SHA-256, dataset history, and explicit method version in exported results.
- Bounded map-result cache, bounded map computation queue, input validation.
- Desktop/mobile layouts, keyboard controls, focus-trapped methods dialog,
  reduced-motion support, loading/error/no-data states.

## Source data and provenance

**NASA GISTEMP v4 Land–Ocean Temperature Index (L-OTI), 1200 km smoothing.**

- Documentation: https://data.giss.nasa.gov/gistemp/data_v4.html
- File: https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz
- Snapshot file history: Created 2026-10-08 07:32:28 by SBBX_to_nc 2.0;
  GHCNv4 / ERSSTv5; anomaly reference 1951–1980.
- Downloaded for this build on 2026-11-01 UTC.
- Compressed SHA-256: `44c8a2d358d73a5488232cedda387c6e6501671f9d2286b5c656f5a4efb43796`.
- Raw shape: 1761 monthly records × 90 latitudes × 180 longitudes.
- Complete annual record used: 1880–2025. Partial 2026 is excluded.
- `tempanomaly` is packed int16, fill=32767, scale≈0.01; units K **anomaly**.
  A kelvin anomaly increment equals a Celsius anomaly increment: do not subtract 273.15.
- **2° cell spacing is not independent 2° observational resolution.** 1200 km smoothing
  induces spatial dependence and coarser effective information. Zoom adds no local detail.
- GISTEMP blends land-surface air and sea-surface water anomalies; it is not a uniform
  direct satellite measurement of near-surface air temperature everywhere.

Deleting the bundled compressed file causes Go to fetch a fresh snapshot on startup.
The API recomputes the checksum and exposes the new history; it does not claim a
mutable upstream file is an immutable version. The adapter supports NetCDF classic
CDF1/CDF2 fixed variables, and explicitly rejects unsupported formats/record variables.

Geographic context:
- © OpenStreetMap contributors: https://www.openstreetmap.org/copyright
- OSM tile policy: https://operations.osmfoundation.org/policies/tiles/
- Boundaries: Natural Earth 1:110m, public domain:
  https://www.naturalearthdata.com/about/terms-of-use/
- Boundary GeoJSON snapshot:
  https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson

NASA data citation guidance: https://data.giss.nasa.gov/gistemp/ (cite GISTEMP Team and
Lenssen et al. following NASA's current guidance). This independent prototype does
not imply NASA endorsement and does not use NASA logos.

## Scientific method, version `ols-hac-bh-v1`

1. **Annual data:** arithmetic mean of 12 monthly anomalies. If any month is missing,
   that cell-year is missing. Partial years are not substituted for complete years.
2. **Cell eligibility:** at least 30 complete annual values and at least 90% coverage
   over the requested interval. Ineligible cells are transparent, not zero trend.
3. **Trend:** OLS against calendar year. Report slope × 10 in °C/decade.
4. **Uncertainty:** Bartlett Newey–West heteroskedasticity/autocorrelation-consistent
   covariance; lag `floor(4*(n/100)^(2/9))`; finite-sample factor `n/(n−2)`.
   Missing-year pairs use actual calendar distances. Two-sided p-values and 95% CIs
   use an **asymptotic normal approximation**, not a claim of exact finite-sample coverage.
5. **Global multiplicity:** BH-adjust the p-values of all globally eligible cells for
   the selected interval. Stipple q ≤ 0.05. The denominator is the full eligible field,
   not only currently visible cells. BH assumes independent/appropriate positive
   dependence and is **not** a guarantee of spatial field significance under arbitrary
   dependence; smoothing and exploratory window selection complicate interpretation.
6. **Regions:** a fixed footprint of cells complete in *every* selected year.
   Each cell's weight is its exact spherical overlap with the selection rectangle.
   The footprint is held constant across time. Its percentage of requested area is shown.
   Regional p-values are **unadjusted**; repeated regional exploration needs further control.
7. **Interpretation:** a trend, its practical magnitude, its statistical evidence, and
   its cause are different questions. No-significance is not proof of no change.

Method references:
- Newey & West (1987): https://doi.org/10.2307/1913610
- Benjamini & Hochberg (1995): https://doi.org/10.1111/j.2517-6161.1995.tb02031.x

### Scientific limitations

This milestone does not propagate the full GISTEMP observational uncertainty ensemble,
use an attribution model, assess changepoints/nonlinear trends, or provide seasonal
analyses. HAC inference is conditional on the selected model and asymptotic assumptions.
The fixed regional mask may discard substantial area in early periods; coverage is
reported and a warning is shown below 80%. Regions crossing the antimeridian must be
split. Presets labelled “box” are rectangles, not exact ecological/catchment boundaries.

## API

- `GET /api/health`
- `GET /api/catalog`
- `GET /api/map?start=1981&end=2025&layer=trend`
- `GET /api/map?start=1981&end=2025&layer=anomaly&year=2025`
- `GET /api/map?start=1981&end=2025&layer=coverage`
- `GET /api/analyze?start=1981&end=2025&west=65&south=5&east=95&north=35`
- Add `format=csv` or `download=1` to the regional endpoint for export.

Map GeoJSON properties: `v` = displayed value, `q` = global BH-adjusted value or null,
`n` = valid annual values in the selected analysis period.
The response `meta` names the period/layer/year and data SHA.

## Validation

```sh
cd backend && go test -race ./...
```

`qa/science-validation.json` records an independent raw-file comparison using SciPy
and Statsmodels: four regions (including a partial-cell rectangle), every eligible
native-grid trend/q-value for 1981–2025, plus malformed request rejection.
The reference check compares decoded observations, spherical weights, slopes, CIs,
and adjusted q-values—not only values returned by Go itself.

Optional reproduction (requires the running Go server and Python with numpy/scipy/statsmodels):

```sh
python -m pip install numpy scipy statsmodels
python -c "import gzip,shutil; shutil.copyfileobj(gzip.open('data/gistemp.nc.gz','rb'),open('data/gistemp.nc','wb'))"
python scripts/validate_science.py
```

Independent numerical agreement is **not peer review or scientific certification**.
See `qa/ui-validation.json` for the exercised UI states and preview images.

## Remaining challenge work

v0.2 adds mission-backed MODIS indicator imagery and NASA OSCAR vector data, alongside the temperature reference layer. However, **only temperature currently supports a full numerical time-series trend/significance workflow**. Flow layers support snapshot statistics; pollution and vegetation layers support imagery exploration only.

To finish the broader challenge: add quality-screened numerical AOD, chlorophyll and vegetation time-series adapters; contemporary ocean-current and land-wind sources; seasonal/sampling sensitivity checks; robust-method comparisons; independent domain-scientist review; native-grid scientific-file exports; saved investigations; and the submission narrative/video. Do not market these indicator layers as complete pollution-risk or species-habitat analysis.

Before public deployment: configure an appropriate OSM-compatible tile provider,
HTTPS, hosting/resource limits, authentication if needed, durable dataset/version
storage, operational logging, and stronger request throttling. No public deployment
is included in this archive.
