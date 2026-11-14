import TrendGraph from "./TrendGraph";
import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type Map as GLMap,
  type ExpressionSpecification,
} from "maplibre-gl";
import {
  ArrowDownToLine,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  Database,
  Earth,
  ExternalLink,
  FlaskConical,
  Globe2,
  Info,
  Layers3,
  LoaderCircle,
  MapPin,
  Maximize2,
  Minus,
  Plus,
  Scan,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import type { FeatureCollection, Polygon } from "geojson";

type Bounds = { west: number; south: number; east: number; north: number };
type Layer = "trend" | "anomaly" | "coverage";
type Catalog = {
  variables: {
    id: string;
    name: string;
    source: {
      firstYear: number;
      lastCompleteYear: number;
      sha256: string;
      fileHistory: string;
      downloadedAt: string;
      title: string;
      url: string;
      grid: string;
      baseline: string;
      smoothing: string;
    };
  }[];
  methods: Record<string, string>;
  minYears: number;
};
type Trend = {
  slopePerDecade: number;
  ciLow: number;
  ciHigh: number;
  pValue: number;
  nYears: number;
  hacLag: number;
  rSquared: number;
  intercept: number;
};
type Result = {
  bounds: Bounds;
  start: number;
  end: number;
  series: { year: number; value: number }[];
  trend: Trend;
  cells: number;
  footprintPercent: number;
  source: Record<string, unknown>;
  methods: Record<string, string>;
  warnings: string[];
};
type Field = FeatureCollection<
  Polygon,
  { v: number | null; q: number | null; n: number }
> & {
  meta: {
    eligibleCells: number;
    significantCells: number;
    availableCells: number;
    totalCells: number;
    start: number;
    end: number;
    layer: Layer;
    year: number;
  };
};
const presets: { name: string; bounds: Bounds; center: [number, number] }[] = [
  {
    name: "Arctic",
    bounds: { west: -180, south: 66, east: 180, north: 90 },
    center: [-20, 48],
  },
  {
    name: "South Asia",
    bounds: { west: 65, south: 5, east: 95, north: 35 },
    center: [80, 22],
  },
  {
    name: "Amazon basin · box",
    bounds: { west: -75, south: -15, east: -45, north: 5 },
    center: [-60, -5],
  },
  {
    name: "North Atlantic · box",
    bounds: { west: -60, south: 20, east: -10, north: 60 },
    center: [-35, 40],
  },
  {
    name: "Global",
    bounds: { west: -180, south: -90, east: 180, north: 90 },
    center: [-20, 22],
  },
];
const earthZoom = () =>
  window.innerWidth > 1000 ? 1.95 : window.innerWidth > 600 ? 1 : 0.9;
const signed = (v: number, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
const pLabel = (p: number) => (p < 0.0001 ? "< 0.0001" : `= ${p.toFixed(4)}`);
const coord = (v: number, axis: "lat" | "lon") =>
  `${Math.abs(v).toFixed(1)}°${axis === "lat" ? (v < 0 ? "S" : "N") : v < 0 ? "W" : "E"}`;
const coords = (b: Bounds) =>
  `${coord(b.south, "lat")}–${coord(b.north, "lat")} · ${coord(b.west, "lon")}–${coord(b.east, "lon")}`;
function regionParams(start: number, end: number, b: Bounds) {
  return new URLSearchParams({
    start: String(start),
    end: String(end),
    ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v)])),
  });
}
async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) {
    let message = `Request failed (${r.status})`;
    try {
      message = (await r.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  return r.json();
}
function boundsFeature(b: Bounds): FeatureCollection {
  const steps = Math.max(1, Math.ceil((b.east - b.west) / 4));
  const ring: number[][] = [];
  for (let i = 0; i <= steps; i++)
    ring.push([b.west + ((b.east - b.west) * i) / steps, b.south]);
  for (let i = steps; i >= 0; i--)
    ring.push([
      b.west + ((b.east - b.west) * i) / steps,
      Math.min(b.north, 89.99),
    ]);
  ring.push(ring[0]);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  };
}
function colors(layer: Layer): ExpressionSpecification {
  const stops =
    layer === "coverage"
      ? [0, "#24343f", 50, "#788f91", 80, "#76baa6", 100, "#c7ead5"]
      : layer === "anomaly"
        ? [
            -3,
            "#407ead",
            -1.5,
            "#86b4cc",
            0,
            "#e1d7b9",
            1.5,
            "#e4a06b",
            3,
            "#c95b3d",
          ]
        : [
            -1,
            "#377eac",
            -0.5,
            "#77b0c8",
            0,
            "#d5dacb",
            0.25,
            "#d7b479",
            0.5,
            "#d88953",
            1,
            "#bd4e35",
          ];
  return [
    "interpolate",
    ["linear"],
    ["coalesce", ["get", "v"], 0],
    ...stops,
  ] as ExpressionSpecification;
}
function App({ onLayerChange }: { onLayerChange: (id: string) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [fatal, setFatal] = useState("");
  const [start, setStart] = useState(1981);
  const [end, setEnd] = useState(2025);
  const [draftStart, setDraftStart] = useState(1981);
  const [draftEnd, setDraftEnd] = useState(2025);
  const [layer, setLayer] = useState<Layer>("trend");
  const [year, setYear] = useState(2025);
  const [evidence, setEvidence] = useState(true);
  const [projection, setProjection] = useState<"globe" | "mercator">("globe");
  const [field, setField] = useState<Field | null>(null);
  const [fieldLoading, setFieldLoading] = useState(true);
  const [mapError, setMapError] = useState("");
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState<Bounds>(presets[0].bounds);
  const [regionName, setRegionName] = useState("Arctic");
  const [result, setResult] = useState<Result | null>(null);
  const [regionLoading, setRegionLoading] = useState(true);
  const [regionError, setRegionError] = useState("");
  const [draw, setDraw] = useState(false);
  const [firstCorner, setFirstCorner] = useState<[number, number] | null>(null);
  const [showBounds, setShowBounds] = useState(false);
  const [boundsDraft, setBoundsDraft] = useState<Bounds>(presets[0].bounds);
  const [annualOpen, setAnnualOpen] = useState(false);
  const [methodsOpen, setMethodsOpen] = useState(false);
  const [tab, setTab] = useState<"explore" | "provenance">("explore");
  const [notice, setNotice] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const map = useRef<GLMap | null>(null);
  const modalClose = useRef<HTMLButtonElement>(null);
  const [tileWarning, setTileWarning] = useState(false);
  const clickState = useRef({ draw, firstCorner });
  clickState.current = { draw, firstCorner };
  useEffect(() => {
    const ac = new AbortController();
    getJSON<Catalog>("/api/catalog", ac.signal)
      .then((c) => {
        setCatalog(c);
        const last = c.variables[0].source.lastCompleteYear;
        setEnd(last);
        setDraftEnd(last);
        setYear(last);
      })
      .catch((e) => {
        if (e.name !== "AbortError")
          setFatal(`Cannot reach the Go backend. ${e.message}`);
      });
    return () => ac.abort();
  }, []);
  useEffect(() => {
    if (!catalog) return;
    const ac = new AbortController();
    setFieldLoading(true);
    setMapError("");
    getJSON<Field>(
      `/api/map?${new URLSearchParams({ start: String(start), end: String(end), layer, year: String(year) })}`,
      ac.signal,
    )
      .then(setField)
      .catch((e) => {
        if (e.name !== "AbortError") setMapError(e.message);
      })
      .finally(() => {
        if (!ac.signal.aborted) setFieldLoading(false);
      });
    return () => ac.abort();
  }, [catalog, start, end, layer, year]);
  useEffect(() => {
    if (!catalog) return;
    const ac = new AbortController();
    setRegionLoading(true);
    setRegionError("");
    setResult(null);
    getJSON<Result>(
      `/api/analyze?${regionParams(start, end, selection)}`,
      ac.signal,
    )
      .then(setResult)
      .catch((e) => {
        if (e.name !== "AbortError") setRegionError(e.message);
      })
      .finally(() => {
        if (!ac.signal.aborted) setRegionLoading(false);
      });
    return () => ac.abort();
  }, [catalog, start, end, selection]);
  useEffect(() => {
    if (!root.current) return;
    const m = new maplibregl.Map({
      container: root.current,
      center: [-20, 32],
      zoom: earthZoom(),
      minZoom: 0,
      maxZoom: 6,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
      style: {
        version: 8,
        projection: { type: "globe" },
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            maxzoom: 19,
            attribution:
              '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
          },
        },
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#0c1a23" },
          },
          {
            id: "osm",
            type: "raster",
            source: "osm",
            paint: {
              "raster-saturation": -1,
              "raster-brightness-min": 0.03,
              "raster-brightness-max": 0.65,
              "raster-contrast": 0.12,
              "raster-opacity": 0.88,
            },
          },
        ],
      },
    });
    map.current = m;
    m.on("load", () => {
      m.setPadding({
        top: 0,
        bottom: window.innerWidth > 1000 ? 64 : 80,
        left: 0,
        right: 0,
      });
      m.addSource("field", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      m.addLayer({
        id: "climate",
        type: "fill",
        source: "field",
        paint: {
          "fill-color": colors("trend"),
          "fill-opacity": ["case", ["==", ["get", "v"], null], 0, 0.72],
          "fill-antialias": false,
        },
      });
      m.addSource("countries", {
        type: "geojson",
        data: "/countries.geojson",
        attribution: "Boundaries: Natural Earth (public domain)",
      });
      m.addLayer({
        id: "coastlines",
        type: "line",
        source: "countries",
        paint: {
          "line-color": "#19333a",
          "line-opacity": 0.85,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            0,
            0.45,
            2,
            0.85,
            5,
            1.3,
          ],
        },
      });
      m.addSource("evidence", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      m.addLayer({
        id: "stipple",
        type: "circle",
        source: "evidence",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            0,
            0.6,
            2,
            1.1,
            5,
            2,
          ],
          "circle-color": "#17282c",
          "circle-opacity": 0.75,
        },
      });
      const graticule: FeatureCollection = {
        type: "FeatureCollection",
        features: [],
      };
      for (let lat = -60; lat <= 60; lat += 30)
        graticule.features.push({
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: Array.from({ length: 181 }, (_, i) => [
              -180 + i * 2,
              lat,
            ]),
          },
        });
      for (let lon = -180; lon < 180; lon += 30)
        graticule.features.push({
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: Array.from({ length: 89 }, (_, i) => [
              lon,
              -88 + i * 2,
            ]),
          },
        });
      m.addSource("grid", { type: "geojson", data: graticule });
      m.addLayer({
        id: "graticule",
        type: "line",
        source: "grid",
        paint: {
          "line-color": "#d7e5dd",
          "line-opacity": 0.12,
          "line-width": 0.6,
        },
      });
      m.addSource("selection", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      m.addLayer({
        id: "selection-fill",
        type: "fill",
        source: "selection",
        paint: { "fill-color": "#d1f9bc", "fill-opacity": 0.03 },
      });
      m.addLayer({
        id: "selection-line",
        type: "line",
        source: "selection",
        paint: {
          "line-color": "#dbfac9",
          "line-width": 2,
          "line-dasharray": [3, 2],
        },
      });
      m.getCanvas().setAttribute(
        "aria-label",
        "Interactive Earth trend map. Click a cell to inspect it. Equivalent region selection is available in the investigation controls.",
      );
      setReady(true);
    });
    m.on("error", (e) => {
      if (e.error?.message?.includes("tile.openstreetmap"))
        setTileWarning(true);
    });
    m.on("click", (e) => {
      const lon = ((((e.lngLat.lng + 180) % 360) + 360) % 360) - 180;
      const lat = Math.max(-89.999, Math.min(89.999, e.lngLat.lat));
      const state = clickState.current;
      if (state.draw) {
        if (!state.firstCorner) {
          setFirstCorner([lon, lat]);
          setNotice("First corner set. Click the opposite corner.");
          return;
        }
        const [x, y] = state.firstCorner;
        const b = {
          west: Math.min(x, lon),
          east: Math.max(x, lon),
          south: Math.min(y, lat),
          north: Math.max(y, lat),
        };
        if (b.east - b.west < 0.1 || b.north - b.south < 0.1) {
          setNotice("Choose a larger rectangle.");
          return;
        }
        if (b.east - b.west > 180) {
          setNotice(
            "Antimeridian-crossing rectangles must be split into two regions.",
          );
          return;
        }
        setSelection(b);
        setBoundsDraft(b);
        setRegionName("Custom region");
        setDraw(false);
        setFirstCorner(null);
        setNotice("Region selected. Calculating its fixed-footprint trend.");
      } else {
        const west = Math.floor((lon + 180) / 2) * 2 - 180;
        const south = Math.floor((lat + 90) / 2) * 2 - 90;
        const b = { west, east: west + 2, south, north: south + 2 };
        setSelection(b);
        setBoundsDraft(b);
        setRegionName("Native grid cell");
      }
    });
    m.on("mousemove", () => {
      m.getCanvas().style.cursor = clickState.current.draw
        ? "crosshair"
        : "grab";
    });
    return () => {
      setReady(false);
      m.remove();
      map.current = null;
    };
  }, []);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    m.setProjection({ type: projection });
  }, [projection, ready]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !field) return;
    if (
      field.meta.layer !== layer ||
      field.meta.start !== start ||
      field.meta.end !== end ||
      (layer === "anomaly" && field.meta.year !== year)
    ) {
      (m.getSource("field") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: [],
      });
      (m.getSource("evidence") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: [],
      });
      return;
    }
    (m.getSource("field") as GeoJSONSource).setData(field);
    m.setPaintProperty("climate", "fill-color", colors(layer));
    const dots: FeatureCollection = {
      type: "FeatureCollection",
      features: field.features
        .filter(
          (f) =>
            f.properties.q !== null &&
            f.properties.q <= 0.05 &&
            f.properties.v !== null,
        )
        .map((f) => {
          const c = f.geometry.coordinates[0];
          return {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Point",
              coordinates: [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2],
            },
          };
        }),
    };
    (m.getSource("evidence") as GeoJSONSource).setData(dots);
  }, [field, layer, ready, start, end, year]);
  useEffect(() => {
    const m = map.current;
    if (m && ready)
      m.setLayoutProperty(
        "stipple",
        "visibility",
        evidence && layer === "trend" ? "visible" : "none",
      );
  }, [evidence, layer, ready]);
  useEffect(() => {
    const m = map.current;
    if (m && ready)
      (m.getSource("selection") as GeoJSONSource).setData(
        boundsFeature(selection),
      );
  }, [selection, ready]);
  useEffect(() => {
    if (!methodsOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modalClose.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMethodsOpen(false);
      if (e.key === "Tab") {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".method-modal button,.method-modal a[href]",
          ),
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = oldOverflow;
      previouslyFocused?.focus();
    };
  }, [methodsOpen]);
  const src = catalog?.variables[0].source;
  const dirty = draftStart !== start || draftEnd !== end;
  const invalid = !src
    ? "Loading dataset…"
    : draftStart < src.firstYear ||
        draftEnd > src.lastCompleteYear ||
        draftEnd - draftStart + 1 < 30
      ? "Choose at least 30 complete years in the available record."
      : "";
  const changeRegion = (name: string) => {
    const p = presets.find((p) => p.name === name);
    if (!p) return;
    setRegionName(p.name);
    setSelection(p.bounds);
    setBoundsDraft(p.bounds);
    setNotice("");
    setDraw(false);
    map.current?.easeTo({
      center: p.center,
      zoom: earthZoom(),
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 0
        : 900,
    });
  };
  const download = (format: "csv" | "json") => {
    const q = regionParams(start, end, selection);
    q.set("format", format);
    q.set("download", "1");
    window.open(`/api/analyze?${q}`, "_blank", "noopener");
  };
  const direction = result
    ? result.trend.ciLow > 0
      ? "Increasing trend"
      : result.trend.ciHigh < 0
        ? "Decreasing trend"
        : "Trend not resolved"
    : "";
  return (
    <div
      className={`app-shell antialiased ${projection === "mercator" ? "flat-map" : ""}`}
    >
      <header className="app-header">
        <a className="brand" href="#" aria-label="Merobiman home">
          <span className="brand-mark">
            <Earth size={25} />
          </span>
          <span>
            mero<span className="brand-light">biman</span>
            <small>EARTH SYSTEM OBSERVATORY</small>
          </span>
        </a>
        <nav aria-label="Workspace" className="top-nav">
          <button
            className={tab === "explore" ? "nav-button active" : "nav-button"}
            onClick={() => setTab("explore")}
          >
            <Compass size={17} />
            Explore
          </button>
          <button
            className={
              tab === "provenance" ? "nav-button active" : "nav-button"
            }
            onClick={() => setTab("provenance")}
          >
            <Database size={17} />
            Data & provenance
          </button>
        </nav>
        <div className="header-right">
          <span className="dataset-status">
            <span className={catalog ? "status-dot" : "status-dot waiting"} />
            {catalog ? "NASA GISTEMP v4" : "Connecting to Go API"}
          </span>
          <button
            className="button subtle"
            aria-label="Methods"
            onClick={() => setMethodsOpen(true)}
          >
            <FlaskConical size={16} />
            <span className="optional-label">Methods</span>
          </button>
          <button
            className="button primary export-top"
            aria-label="Export analysis"
            disabled={!result || regionLoading}
            onClick={() => download("json")}
          >
            <ArrowDownToLine size={16} />
            <span className="optional-label">Export analysis</span>
          </button>
        </div>
      </header>
      {fatal ? (
        <div className="fatal" role="alert">
          <Database size={32} />
          <h1>Backend connection unavailable</h1>
          <p>{fatal}</p>
          <p>Start the Go server using the README, then reload this page.</p>
          <button
            className="button primary"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      ) : (
        <main className="workspace">
          <div className="map-stage">
            <div ref={root} className="map-canvas" />
            <div className="map-heading">
              <span className="eyebrow">THE BIG PICTURE</span>
              <h1>
                {layer === "trend"
                  ? "Where is the planet changing?"
                  : layer === "anomaly"
                    ? "A year in the temperature record."
                    : "Where does the record hold up?"}
              </h1>
              <p>
                {layer === "anomaly"
                  ? `${year} anomaly · relative to 1951–1980`
                  : `${start}–${end} · ${end - start + 1} complete calendar years`}
                <span className="native-note">2° grid · 1200 km smoothing</span>
              </p>
            </div>
            <div className="map-tools" aria-label="Map controls">
              <div className="projection-switch">
                <button
                  title="Globe projection"
                  aria-label="Globe projection"
                  aria-pressed={projection === "globe"}
                  className={projection === "globe" ? "selected" : ""}
                  onClick={() => setProjection("globe")}
                >
                  <Globe2 size={17} />
                </button>
                <button
                  title="Flat map projection"
                  aria-label="Flat map projection"
                  aria-pressed={projection === "mercator"}
                  className={projection === "mercator" ? "selected" : ""}
                  onClick={() => setProjection("mercator")}
                >
                  <Layers3 size={17} />
                </button>
              </div>
              <button
                className="tool-button"
                aria-label="Zoom in"
                onClick={() => map.current?.zoomIn()}
              >
                <Plus size={19} />
              </button>
              <button
                className="tool-button"
                aria-label="Zoom out"
                onClick={() => map.current?.zoomOut()}
              >
                <Minus size={19} />
              </button>
              <button
                className="tool-button"
                aria-label="Reset Earth view"
                onClick={() =>
                  map.current?.easeTo({
                    center: [-20, 32],
                    zoom: earthZoom(),
                    bearing: 0,
                    pitch: 0,
                  })
                }
              >
                <Maximize2 size={17} />
              </button>
            </div>
            {(fieldLoading || !ready) && (
              <div className="map-loading" role="status">
                <LoaderCircle className="spin" size={16} />
                {!ready
                  ? "Preparing Earth…"
                  : "Computing native-grid analysis…"}
              </div>
            )}
            {mapError && (
              <div className="map-alert" role="alert">
                {mapError}
                <button
                  onClick={() => setYear((y) => (y === end ? end - 1 : end))}
                >
                  Retry field
                </button>
              </div>
            )}
            {tileWarning && (
              <div className="tile-warning" role="status">
                Basemap tiles unavailable; NASA overlays are still independent.
              </div>
            )}
            {draw && (
              <div className="draw-banner" role="status">
                <Scan size={17} />
                {firstCorner
                  ? "Click the opposite corner"
                  : "Click the first corner of a region"}
                <button
                  aria-label="Cancel region drawing"
                  onClick={() => {
                    setDraw(false);
                    setFirstCorner(null);
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="map-legend">
              <div className="legend-top">
                <span>
                  {layer === "trend"
                    ? "Temperature trend"
                    : layer === "anomaly"
                      ? "Temperature anomaly"
                      : "Temporal data coverage"}
                </span>
                <strong>
                  {layer === "trend"
                    ? "°C / decade"
                    : layer === "anomaly"
                      ? "°C"
                      : "%"}
                </strong>
              </div>
              <div
                className={`color-ramp ${layer === "coverage" ? "coverage-ramp" : layer === "anomaly" ? "anomaly-ramp" : ""}`}
              />
              <div className="legend-ticks">
                {(layer === "coverage"
                  ? ["0", "25", "50", "75", "100"]
                  : layer === "anomaly"
                    ? ["≤ −3", "−1.5", "0", "+1.5", "≥ +3"]
                    : ["≤ −1", "−0.5", "0", "+0.5", "≥ +1"]
                ).map((v) => (
                  <span key={v}>{v}</span>
                ))}
              </div>
              <div className="legend-foot">
                <span>
                  <i className="missing-swatch" />
                  No eligible data
                </span>
                {layer === "trend" && (
                  <span>
                    <i className="evidence-dot" />
                    Dots: BH q ≤ 0.05
                  </span>
                )}
                {layer === "coverage" && <span>Complete annual values</span>}
              </div>
              {layer === "anomaly" && (
                <label className="year-scrub">
                  YEAR <strong>{year}</strong>
                  <input
                    aria-label="Historical anomaly year"
                    type="range"
                    min={src?.firstYear || 1880}
                    max={src?.lastCompleteYear || 2025}
                    value={year}
                    onChange={(e) => setYear(+e.target.value)}
                  />
                </label>
              )}
            </div>
          </div>
          <aside
            className="control-panel panel"
            aria-label="Investigation controls"
          >
            <div className="panel-kicker">
              <span>YOUR INVESTIGATION</span>
              <Settings2 size={15} />
            </div>
            <h2>Follow the evidence.</h2>
            <label className="field-label" htmlFor="variable">
              1 · Select a variable
            </label>
            <select
              id="variable"
              className="select-field"
              value="temperature"
              onChange={(e) => onLayerChange(e.target.value)}
            >
              <option value="temperature">Temperature anomaly</option>
              <option value="wind">Air streams · wind</option>
              <option value="currents">Water streams · currents</option>
              <option value="air">Air pollution · aerosol indicator</option>
              <option value="water">Water quality · chlorophyll indicator</option>
              <option value="habitat">Habitat · vegetation indicator</option>
            </select>
            <p className="field-help">NASA GISTEMP v4 · Land–Ocean Index. Only temperature supports quantitative trends; other layers show snapshots or imagery.</p>
            <div className="section-divider" />
            <label className="field-label" htmlFor="region">
              2 · Select a region
            </label>
            <select
              id="region"
              className="select-field"
              value={
                presets.some((p) => p.name === regionName) ? regionName : ""
              }
              onChange={(e) => changeRegion(e.target.value)}
            >
              <option value="" disabled>
                {regionName}
              </option>
              {presets.map((p) => (
                <option key={p.name}>{p.name}</option>
              ))}
            </select>
            <button
              className={`button draw-button ${draw ? "drawing" : ""}`}
              aria-pressed={draw}
              onClick={() => {
                setDraw((v) => !v);
                setFirstCorner(null);
                setNotice("");
              }}
            >
              <Scan size={16} />
              {draw ? "Cancel drawing" : "Draw a region"}
              <span>2 corners</span>
            </button>
            <button
              className="text-button bounds-toggle"
              aria-expanded={showBounds}
              onClick={() => setShowBounds((v) => !v)}
            >
              Enter coordinates{" "}
              {showBounds ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {showBounds && (
              <form
                className="bounds-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (
                    boundsDraft.west >= boundsDraft.east ||
                    boundsDraft.south >= boundsDraft.north
                  ) {
                    setNotice(
                      "West must be less than east, and south less than north.",
                    );
                    return;
                  }
                  setSelection({ ...boundsDraft });
                  setRegionName("Custom region");
                  setDraw(false);
                  setNotice("");
                  map.current?.easeTo({
                    center: [
                      (boundsDraft.west + boundsDraft.east) / 2,
                      (boundsDraft.south + boundsDraft.north) / 2,
                    ],
                    zoom: earthZoom(),
                    duration: window.matchMedia(
                      "(prefers-reduced-motion: reduce)",
                    ).matches
                      ? 0
                      : 700,
                  });
                }}
              >
                {(["west", "east", "south", "north"] as const).map((k) => (
                  <label key={k}>
                    {k}
                    <input
                      type="number"
                      step="any"
                      min={k === "west" || k === "east" ? -180 : -90}
                      max={k === "west" || k === "east" ? 180 : 90}
                      value={boundsDraft[k]}
                      onChange={(e) =>
                        setBoundsDraft((b) => ({ ...b, [k]: +e.target.value }))
                      }
                    />
                  </label>
                ))}
                <button className="button subtle" type="submit">
                  Inspect these bounds
                </button>
              </form>
            )}
            {notice && (
              <p className="selection-notice" role="status">
                {notice}
              </p>
            )}
            <div className="section-divider" />
            <span className="field-label">Map analysis</span>
            <div
              className="layer-options"
              role="radiogroup"
              aria-label="Map analysis layer"
            >
              {(
                [
                  {
                    id: "trend",
                    name: "Long-term trend",
                    unit: "Change per decade",
                    icon: ArrowUpRight,
                  },
                  {
                    id: "anomaly",
                    name: "Annual anomaly",
                    unit: "Departure from the baseline",
                    icon: Layers3,
                  },
                  {
                    id: "coverage",
                    name: "Data coverage",
                    unit: "Check the evidence footprint",
                    icon: ShieldCheck,
                  },
                ] as const
              ).map((l) => (
                <button
                  role="radio"
                  aria-checked={layer === l.id}
                  key={l.id}
                  className={`layer-option ${layer === l.id ? "active" : ""}`}
                  onClick={() => setLayer(l.id)}
                >
                  <l.icon size={18} />
                  <span>
                    <strong>{l.name}</strong>
                  </span>
                  <i className="radio-mark">{layer === l.id && <span />}</i>
                </button>
              ))}
            </div>
            <div className="section-divider" />
            <div className="label-row">
              <label className="field-label" htmlFor="start">
                3 · Select a time period
              </label>
              <span className="quiet">≥ 30 years</span>
            </div>
            <div className="year-inputs">
              <label>
                <span>FROM</span>
                <input
                  id="start"
                  type="number"
                  min={src?.firstYear || 1880}
                  max={draftEnd - 29}
                  value={draftStart}
                  onChange={(e) => setDraftStart(+e.target.value)}
                />
              </label>
              <span className="year-to">—</span>
              <label>
                <span>THROUGH</span>
                <input
                  aria-label="End year"
                  type="number"
                  min={draftStart + 29}
                  max={src?.lastCompleteYear || 2025}
                  value={draftEnd}
                  onChange={(e) => setDraftEnd(+e.target.value)}
                />
              </label>
            </div>
            {dirty && invalid && (
              <p className="input-error" role="alert">
                {invalid}
              </p>
            )}
            <button
              className="button apply-button"
              disabled={!!invalid || fieldLoading || !dirty}
              onClick={() => {
                setStart(draftStart);
                setEnd(draftEnd);
                setYear(draftEnd);
              }}
            >
              {fieldLoading ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <ArrowUpRight size={16} />
              )}
              Update analysis
            </button>
            <label
              className={`toggle-row ${layer !== "trend" ? "muted-control" : ""}`}
            >
              <span>
                <strong>Significance stippling</strong>
                <small>Global BH-adjusted q ≤ 0.05</small>
              </span>
              <input
                type="checkbox"
                checked={evidence}
                disabled={layer !== "trend"}
                onChange={(e) => setEvidence(e.target.checked)}
              />
            </label>
            <button
              className="text-button mobile-provenance"
              onClick={() =>
                setTab(tab === "explore" ? "provenance" : "explore")
              }
            >
              {tab === "explore"
                ? "Dataset & provenance"
                : "Back to regional analysis"}
              <ArrowUpRight size={14} />
            </button>
            <p className="control-bottom">
              <Info size={14} />
              <span>
                Click any map cell to investigate it. Zoom does not increase
                data resolution.
              </span>
            </p>
          </aside>
          <aside className="inspector panel" aria-label="Regional analysis">
            <div className="panel-kicker">
              <span>
                {tab === "provenance"
                  ? "DATA & PROVENANCE"
                  : "REGIONAL INSPECTOR"}
              </span>
              <MapPin size={15} />
            </div>
            {tab === "provenance" ? (
              <div className="provenance">
                <button
                  className="text-button"
                  onClick={() => setTab("explore")}
                >
                  Back to regional analysis
                  <ArrowUpRight size={14} />
                </button>
                <h2>A traceable record.</h2>
                <p>
                  Every result is tied to a NASA data snapshot and explicit
                  analysis settings.
                </p>
                <dl>
                  <dt>Dataset</dt>
                  <dd>{src?.title}</dd>
                  <dt>Available annual record</dt>
                  <dd>
                    {src?.firstYear}–{src?.lastCompleteYear}
                  </dd>
                  <dt>Anomaly reference</dt>
                  <dd>1951–1980</dd>
                  <dt>Spatial support</dt>
                  <dd>2° grid · 1200 km smoothing</dd>
                  <dt>Source file history</dt>
                  <dd>{src?.fileHistory}</dd>
                  <dt>Data SHA-256</dt>
                  <dd className="hash">{src?.sha256}</dd>
                  <dt>Method version</dt>
                  <dd>ols-hac-bh-v1</dd>
                </dl>
                <a
                  className="source-link"
                  href="https://data.giss.nasa.gov/gistemp/data_v4.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  NASA source & downloads
                  <ExternalLink size={14} />
                </a>
                <button
                  className="button subtle full-width"
                  onClick={() => setMethodsOpen(true)}
                >
                  Read the analysis methods
                  <ArrowUpRight size={15} />
                </button>
              </div>
            ) : (
              <>
                <div className="region-heading">
                  <h2>{regionName}</h2>
                  <span className="region-type">
                    {regionName === "Native grid cell"
                      ? "2° × 2° cell"
                      : "Bounding-box region"}
                  </span>
                </div>
                <p className="region-coords">{coords(selection)}</p>
                <p className="inspector-window">
                  Trend interval: {start}–{end}
                </p>
                {regionLoading ? (
                  <div className="region-loading" role="status">
                    <LoaderCircle className="spin" size={24} />
                    <p>Estimating the regional trend…</p>
                  </div>
                ) : regionError ? (
                  <div className="region-error" role="alert">
                    <Info size={22} />
                    <h3>Not enough usable evidence</h3>
                    <p>{regionError}</p>
                    <button
                      className="button subtle"
                      onClick={() => changeRegion("Arctic")}
                    >
                      Inspect the Arctic
                    </button>
                  </div>
                ) : (
                  result && (
                    <>
                      <div className="trend-summary">
                        <span className="eyebrow">TEMPERATURE CHANGE</span>
                        <div className="trend-value">
                          {signed(result.trend.slopePerDecade)}
                          <span>°C / decade</span>
                        </div>
                        <div
                          className={`direction-badge ${result.trend.ciLow <= 0 && result.trend.ciHigh >= 0 ? "unresolved" : ""}`}
                        >
                          {result.trend.ciLow > 0 ? (
                            <ArrowUpRight size={14} />
                          ) : result.trend.ciHigh < 0 ? (
                            <ArrowDownRight size={14} />
                          ) : (
                            <Info size={14} />
                          )}{" "}
                          {direction}
                        </div>
                        <p className="interval">
                          95% interval{" "}
                          <strong>
                            {signed(result.trend.ciLow)} to{" "}
                            {signed(result.trend.ciHigh)}
                          </strong>
                        </p>
                      </div>
                      <TrendGraph region={regionName} series={result.series} model={result.trend} />
                      <div className="stat-grid">
                        <div>
                          <span>Annual values</span>
                          <strong>{result.trend.nYears}</strong>
                        </div>
                        <div>
                          <span>Fixed area covered</span>
                          <strong>
                            {Math.min(100, result.footprintPercent).toFixed(1)}
                            <small>%</small>
                          </strong>
                        </div>
                        <div>
                          <span>Contributing cells</span>
                          <strong>{result.cells.toLocaleString()}</strong>
                        </div>
                        <div>
                          <span>Regional p-value</span>
                          <strong className="p-value">
                            {pLabel(result.trend.pValue)}
                          </strong>
                        </div>
                      </div>
                      <div className="evidence-note" aria-label="Statistical significance result">
                        <ShieldCheck size={16} />
                        <p>
                          <strong>5 · Statistical significance:</strong>{" "}
                          {result.trend.pValue < 0.05
                            ? "Statistically significant at p < 0.05."
                            : "Not statistically significant at p < 0.05."}{" "}
                          This two-sided regional test uses Newey–West uncertainty and is unadjusted for repeated selections. Map stippling uses global BH-adjusted q-values. A trend does not establish its cause.
                        </p>
                      </div>
                      <button
                        className="annual-toggle"
                        aria-expanded={annualOpen}
                        onClick={() => setAnnualOpen((v) => !v)}
                      >
                        <span>
                          Annual anomaly record <small>°C vs. 1951–1980</small>
                        </span>
                        {annualOpen ? (
                          <ChevronUp size={16} />
                        ) : (
                          <ChevronDown size={16} />
                        )}
                      </button>
                      {annualOpen && (
                        <div
                          className="annual-record"
                          tabIndex={0}
                          aria-label="Scrollable annual observations"
                        >
                          <table>
                            <caption className="sr-only">
                              {regionName} annual temperature anomalies from{" "}
                              {start} through {end}, degrees Celsius relative to
                              1951–1980.
                            </caption>
                            <thead>
                              <tr>
                                <th>Year</th>
                                <th>Anomaly (°C)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {result.series.map((p) => (
                                <tr key={p.year}>
                                  <td>{p.year}</td>
                                  <td>{signed(p.value, 3)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      <div className="inspector-method">
                        <span className="eyebrow">HOW THIS WAS CALCULATED</span>
                        <p>
                          Fixed-footprint, area-weighted annual anomalies.
                          Linear trend with Newey–West uncertainty; HAC lag{" "}
                          {result.trend.hacLag} years.
                        </p>
                        <button
                          className="text-button"
                          onClick={() => setMethodsOpen(true)}
                        >
                          Methods & limitations
                          <ArrowUpRight size={14} />
                        </button>
                      </div>
                      {result.warnings
                        .filter((w) => w.startsWith("Less"))
                        .map((w) => (
                          <p key={w} className="input-error">
                            {w}
                          </p>
                        ))}
                      <div className="inspector-download">
                        <button
                          className="button subtle"
                          onClick={() => download("csv")}
                        >
                          <ArrowDownToLine size={15} />
                          Annual CSV
                        </button>
                        <button
                          className="button subtle"
                          onClick={() => download("json")}
                        >
                          <ArrowDownToLine size={15} />
                          Full analysis
                        </button>
                      </div>
                      <p className="causation-note">
                        Detecting a trend does not identify its cause. An
                        unresolved trend is not evidence of no change.
                      </p>
                    </>
                  )
                )}
              </>
            )}
          </aside>
          <div className="field-status">
            <span className="status-dot" />
            <span>
              {mapError
                ? "Analysis unavailable"
                : fieldLoading
                  ? "Analysis running"
                  : field
                    ? `${(layer === "anomaly" ? field.meta.availableCells : field.meta.eligibleCells).toLocaleString()} eligible native-grid cells`
                    : "Waiting for data"}
            </span>
            <span className="status-separator" />
            Go analysis engine
            <span className="prototype-tag">RESEARCH PROTOTYPE</span>
          </div>
        </main>
      )}
      {methodsOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMethodsOpen(false);
          }}
        >
          <section
            className="method-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="method-title"
          >
            <div className="modal-heading">
              <span className="eyebrow">TRANSPARENCY BY DESIGN</span>
              <button
                className="tool-button"
                ref={modalClose}
                aria-label="Close methods"
                onClick={() => setMethodsOpen(false)}
              >
                <X size={20} />
              </button>
            </div>
            <h2 id="method-title">The method behind the map.</h2>
            <p className="modal-intro">
              A reproducible exploration tool—not a climate attribution model or
              a publication-ready inference system.
            </p>
            <dl>
              {Object.entries(catalog?.methods || {})
                .filter(([key]) => key !== "version")
                .sort(
                  ([a], [b]) =>
                    [
                      "annualAggregation",
                      "regionalAggregation",
                      "trend",
                      "uncertainty",
                      "mapEligibility",
                      "mapMultiplicity",
                      "regionalMultiplicity",
                      "caveat",
                    ].indexOf(a) -
                    [
                      "annualAggregation",
                      "regionalAggregation",
                      "trend",
                      "uncertainty",
                      "mapEligibility",
                      "mapMultiplicity",
                      "regionalMultiplicity",
                      "caveat",
                    ].indexOf(b),
                )
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>
                      {(
                        {
                          annualAggregation: "01 · Annual aggregation",
                          regionalAggregation: "02 · Regional footprint",
                          trend: "03 · Trend estimation",
                          uncertainty: "04 · Uncertainty",
                          mapEligibility: "05 · Eligible map cells",
                          mapMultiplicity: "06 · Spatial multiple testing",
                          regionalMultiplicity: "07 · Regional inference",
                          caveat: "08 · Interpretation",
                        } as Record<string, string>
                      )[key] || key}
                    </dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
            <div className="method-source">
              <Database size={20} />
              <p>
                <strong>NASA GISTEMP v4</strong>
                <br />
                Land–Ocean Temperature Index · 2° grid · 1200 km smoothing.
                Anomalies relative to 1951–1980. Temperature supports quantitative trends. Other Earth-system layers are available from the variable selector; satellite indicator imagery does not yet support numerical trends.
              </p>
            </div>
            <a
              className="source-link"
              href="https://data.giss.nasa.gov/gistemp/data_v4.html"
              target="_blank"
              rel="noreferrer"
            >
              Open NASA dataset documentation
              <ExternalLink size={15} />
            </a>
          </section>
        </div>
      )}
    </div>
  );
}
export default App;
