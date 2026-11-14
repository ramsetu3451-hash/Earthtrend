package main

import (
	"compress/gzip"
	"embed"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed all:static
var static embed.FS
var data *Dataset
var cache sync.Map
var computeMu sync.Mutex
var computeSlots = make(chan struct{}, 4)

const minYears = 30
const minMapCoverage = 0.9

type Bounds struct {
	West  float64 `json:"west"`
	South float64 `json:"south"`
	East  float64 `json:"east"`
	North float64 `json:"north"`
}
type RegionResult struct {
	Bounds    Bounds         `json:"bounds"`
	Start     int            `json:"start"`
	End       int            `json:"end"`
	Series    []Observation  `json:"series"`
	Trend     *Trend         `json:"trend"`
	Cells     int            `json:"cells"`
	Footprint float64        `json:"footprintPercent"`
	Source    map[string]any `json:"source"`
	Methods   map[string]any `json:"methods"`
	Warnings  []string       `json:"warnings"`
}

func source() map[string]any {
	return map[string]any{"id": "gistemp-loti-v4", "title": "NASA GISTEMP v4 · Land–Ocean Temperature Index", "url": sourceURL, "downloadUrl": dataURL, "sha256": data.SHA, "downloadedAt": data.Downloaded, "fileHistory": data.History, "grid": "2° × 2°", "smoothing": "1200 km", "baseline": "1951–1980", "units": "°C anomaly", "firstYear": data.First, "lastCompleteYear": data.Last, "monthlyRecords": data.MonthlyRecords}
}
func methods() map[string]any {
	return map[string]any{"version": methodVersion, "annualAggregation": "Arithmetic mean of all 12 monthly anomalies; otherwise year is missing", "regionalAggregation": "Spherical overlap-area weighted mean over a fixed footprint: only cells with all annual values in selected interval", "trend": "Ordinary least squares against calendar year; slope × 10", "uncertainty": "Bartlett Newey-West HAC, lag floor(4*(n/100)^(2/9)), n/(n−2) scaling, asymptotic normal 95% interval and two-sided p-value", "mapEligibility": "At least 30 annual values and 90% temporal coverage", "mapMultiplicity": "Benjamini–Hochberg adjustment across all eligible global grid cells; q ≤ 0.05. BH assumes independent/positive dependence; spatial dependence may limit interpretation", "regionalMultiplicity": "Regional p-value is unadjusted; repeated exploratory regional tests require additional control", "caveat": "Prototype. Statistical uncertainty is conditional on this dataset and linear model; it does not include full observational/structural uncertainty or establish causation"}
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Print(err)
	}
}
func fail(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
func window(r *http.Request) (int, int, error) {
	start, end := max(1981, data.First), data.Last
	var err error
	if v := r.URL.Query().Get("start"); v != "" {
		start, err = strconv.Atoi(v)
		if err != nil {
			return 0, 0, fmt.Errorf("start must be an integer")
		}
	}
	if v := r.URL.Query().Get("end"); v != "" {
		end, err = strconv.Atoi(v)
		if err != nil {
			return 0, 0, fmt.Errorf("end must be an integer")
		}
	}
	if start < data.First || end > data.Last || end-start+1 < minYears {
		return 0, 0, fmt.Errorf("choose at least %d complete years within %d–%d", minYears, data.First, data.Last)
	}
	return start, end, nil
}
func finite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }
func bounds(r *http.Request) (Bounds, error) {
	b := Bounds{-180, 66, 180, 90}
	pairs := []struct {
		name string
		ptr  *float64
	}{{"west", &b.West}, {"south", &b.South}, {"east", &b.East}, {"north", &b.North}}
	for _, v := range pairs {
		if s := r.URL.Query().Get(v.name); s != "" {
			n, e := strconv.ParseFloat(s, 64)
			if e != nil || !finite(n) {
				return b, fmt.Errorf("invalid %s", v.name)
			}
			*v.ptr = n
		}
	}
	if b.West < -180 || b.East > 180 || b.West >= b.East || b.South < -90 || b.North > 90 || b.South >= b.North {
		return b, fmt.Errorf("invalid bounds; use west < east and south < north; split antimeridian-crossing regions")
	}
	return b, nil
}
func areaWeight(lat, lon float64, b Bounds) float64 {
	lo, hi := math.Max(lat-1, b.South), math.Min(lat+1, b.North)
	left, right := math.Max(lon-1, b.West), math.Min(lon+1, b.East)
	if lo >= hi || left >= right {
		return 0
	}
	return (math.Sin(hi*math.Pi/180) - math.Sin(lo*math.Pi/180)) * (right - left) * math.Pi / 180
}
func region(b Bounds, start, end int) (RegionResult, error) {
	out := RegionResult{Bounds: b, Start: start, End: end, Series: []Observation{}, Source: source(), Methods: methods(), Warnings: []string{}}
	weights := make([]float64, len(data.Lat)*len(data.Lon))
	var total float64
	for i, lat := range data.Lat {
		for j, lon := range data.Lon {
			c := i*len(data.Lon) + j
			weight := areaWeight(lat, lon, b)
			if weight <= 0 {
				continue
			}
			valid := true
			for y := start; y <= end; y++ {
				if math.IsNaN(data.Annual[y-data.First][c]) {
					valid = false
					break
				}
			}
			if valid {
				weights[c] = weight
				total += weight
				out.Cells++
			}
		}
	}
	if total <= 0 {
		return out, fmt.Errorf("no fixed-footprint cells have complete annual data across this interval; try another region or period")
	}
	full := (math.Sin(b.North*math.Pi/180) - math.Sin(b.South*math.Pi/180)) * (b.East - b.West) * math.Pi / 180
	out.Footprint = 100 * total / full
	for y := start; y <= end; y++ {
		sum := 0.0
		for c, w := range weights {
			if w > 0 {
				sum += w * data.Annual[y-data.First][c]
			}
		}
		out.Series = append(out.Series, Observation{y, sum / total})
	}
	out.Trend = fit(out.Series)
	if out.Footprint < 80 {
		out.Warnings = append(out.Warnings, "Less than 80% of the selected area is represented by the fixed analysis footprint.")
	}
	out.Warnings = append(out.Warnings, "Regional p-value is unadjusted for repeated selections. This analysis does not establish the cause of a trend.", "Native grid is 2° with 1200 km smoothing; zooming in does not add local detail.")
	return out, nil
}
func nullable(v float64) any {
	if !finite(v) {
		return nil
	}
	return v
}
func makeMap(start, end int, layer string, year int) map[string]any {
	n := len(data.Lat) * len(data.Lon)
	fits := make([]*Trend, n)
	ps := []float64{}
	ids := []int{}
	ns := make([]int, n)
	if layer == "trend" || layer == "coverage" {
		for c := 0; c < n; c++ {
			s := data.series(c, start, end)
			ns[c] = len(s)
			if len(s) >= minYears && float64(len(s))/float64(end-start+1) >= minMapCoverage {
				fits[c] = fit(s)
				ps = append(ps, fits[c].P)
				ids = append(ids, c)
			}
		}
	}
	if layer == "anomaly" {
		for c := 0; c < n; c++ {
			ns[c] = len(data.series(c, start, end))
		}
	}
	qs := make([]float64, n)
	for c := range qs {
		qs[c] = math.NaN()
	}
	if len(ps) > 0 {
		adjusted := adjustBH(ps)
		for k, c := range ids {
			qs[c] = adjusted[k]
		}
	}
	features := make([]any, 0, n)
	sig := 0
	available := 0
	for i, lat := range data.Lat {
		for j, lon := range data.Lon {
			c := i*len(data.Lon) + j
			v := math.NaN()
			switch layer {
			case "trend":
				if fits[c] != nil {
					v = fits[c].Slope
				}
			case "anomaly":
				v = data.Annual[year-data.First][c]
			case "coverage":
				v = 100 * float64(ns[c]) / float64(end-start+1)
			}
			if finite(v) {
				available++
			}
			if qs[c] <= 0.05 {
				sig++
			}
			features = append(features, map[string]any{"type": "Feature", "id": c, "properties": map[string]any{"v": nullable(v), "q": nullable(qs[c]), "n": ns[c]}, "geometry": map[string]any{"type": "Polygon", "coordinates": [][][]float64{{{lon - 1, lat - 1}, {lon + 1, lat - 1}, {lon + 1, lat + 1}, {lon - 1, lat + 1}, {lon - 1, lat - 1}}}}})
		}
	}
	return map[string]any{"type": "FeatureCollection", "features": features, "meta": map[string]any{"start": start, "end": end, "layer": layer, "year": year, "totalCells": n, "eligibleCells": len(ids), "significantCells": sig, "availableCells": available, "methodVersion": methodVersion, "sha256": data.SHA}}
}
func serveMap(w http.ResponseWriter, r *http.Request) {
	start, end, e := window(r)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	layer := r.URL.Query().Get("layer")
	if layer == "" {
		layer = "trend"
	}
	if layer != "trend" && layer != "anomaly" && layer != "coverage" {
		fail(w, 400, "unknown map layer")
		return
	}
	year := end
	if s := r.URL.Query().Get("year"); s != "" {
		year, e = strconv.Atoi(s)
		if e != nil || year < data.First || year > data.Last {
			fail(w, 400, "invalid complete year")
			return
		}
	}
	key := fmt.Sprintf("%d-%d-%s-%d", start, end, layer, year)
	if v, ok := cache.Load(key); ok {
		writeCached(w, r, v.([]byte))
		return
	}
	select {
	case computeSlots <- struct{}{}:
		defer func() { <-computeSlots }()
	default:
		fail(w, 429, "analysis busy; retry shortly")
		return
	}
	computeMu.Lock()
	defer computeMu.Unlock()
	if v, ok := cache.Load(key); ok {
		writeCached(w, r, v.([]byte))
		return
	}
	v := makeMap(start, end, layer, year)
	body, e := json.Marshal(v)
	if e != nil {
		fail(w, 500, e.Error())
		return
	}
	entries := 0
	cache.Range(func(k, v any) bool { entries++; return true })
	if entries >= 8 {
		cache.Range(func(k, v any) bool { cache.Delete(k); return false })
	}
	cache.Store(key, body)
	writeCached(w, r, body)
}
func writeCached(w http.ResponseWriter, r *http.Request, b []byte) {
	w.Header().Set("Content-Type", "application/geo+json")
	w.Header().Set("Vary", "Accept-Encoding")
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		z := gzip.NewWriter(w)
		defer z.Close()
		z.Write(b)
	} else {
		w.Write(b)
	}
}
func serveRegion(w http.ResponseWriter, r *http.Request) {
	start, end, e := window(r)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	b, e := bounds(r)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	out, e := region(b, start, end)
	if e != nil {
		fail(w, 422, e.Error())
		return
	}
	if r.URL.Query().Get("format") == "csv" {
		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", "attachment; filename=merobiman-region.csv")
		writer := csv.NewWriter(w)
		defer writer.Flush()
		writer.Write([]string{"year", "temperature_anomaly_c", "dataset_sha256", "start", "end", "west", "south", "east", "north", "method_version"})
		for _, p := range out.Series {
			writer.Write([]string{strconv.Itoa(p.Year), strconv.FormatFloat(p.Value, 'f', 8, 64), data.SHA, strconv.Itoa(start), strconv.Itoa(end), fmt.Sprint(b.West), fmt.Sprint(b.South), fmt.Sprint(b.East), fmt.Sprint(b.North), methodVersion})
		}
		return
	}
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", "attachment; filename=merobiman-analysis.json")
	}
	writeJSON(w, out)
}
func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP listen address")
	path := flag.String("data", "data/gistemp.nc.gz", "NASA compressed NetCDF path (downloads if missing)")
	flag.Parse()
	var err error
	*path = resolveDataPath(*path)
	data, err = loadDataset(*path)
	if err != nil {
		log.Fatal(err)
	}
	initSystems(*path)
	mux := http.NewServeMux()
	registerSystems(mux)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"status": "ok", "dataset": data.SHA})
	})
	mux.HandleFunc("GET /api/catalog", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"variables": []any{map[string]any{"id": "temperature", "name": "Surface temperature anomaly", "source": source()}}, "methods": methods(), "minYears": minYears})
	})
	mux.HandleFunc("GET /api/map", serveMap)
	mux.HandleFunc("GET /api/analyze", serveRegion)
	mux.HandleFunc("GET /api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "unknown API endpoint") })
	sub, _ := fs.Sub(static, "static")
	files := http.FileServer(http.FS(sub))
	mux.Handle("GET /", files)
	// Warm the default field without delaying readiness.
	go func() {
		start := max(1981, data.First)
		body, e := json.Marshal(makeMap(start, data.Last, "trend", data.Last))
		if e == nil {
			cache.Store(fmt.Sprintf("%d-%d-trend-%d", start, data.Last, data.Last), body)
		}
	}()
	server := &http.Server{Addr: *addr, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	}), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("Merobiman running at http://%s", *addr)
	log.Fatal(server.ListenAndServe())
}
