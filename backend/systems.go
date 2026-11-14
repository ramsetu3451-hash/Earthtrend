package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type FlowPoint struct {
	Lon     float64  `json:"lon"`
	Lat     float64  `json:"lat"`
	U       float64  `json:"u"`
	V       float64  `json:"v"`
	Speed   float64  `json:"speed"`
	Bearing *float64 `json:"bearingTo"`
}
type FlowField struct {
	ID         string      `json:"id"`
	Date       string      `json:"date"`
	Title      string      `json:"title"`
	Source     string      `json:"source"`
	SHA        string      `json:"sha256"`
	Native     string      `json:"nativeGrid"`
	SampleStep float64     `json:"sampleStep"`
	Note       string      `json:"note"`
	Points     []FlowPoint `json:"points"`
}
type Indicator struct {
	ID        string   `json:"id"`
	Layer     string   `json:"gibsLayer"`
	Title     string   `json:"title"`
	Matrix    string   `json:"matrix"`
	Date      string   `json:"defaultDate"`
	Min       string   `json:"minDate"`
	Max       string   `json:"maxDate"`
	Legend    string   `json:"legendSource"`
	Intervals []string `json:"timeIntervals"`
	Source    string   `json:"source"`
}

var flowFields = map[string]*FlowField{}
var indicators = map[string]Indicator{}
var systemsDir string

func resolveDataPath(path string) string {
	if _, e := os.Stat(path); e == nil {
		return path
	}
	if path != "data/gistemp.nc.gz" {
		return path
	}
	exe, _ := os.Executable()
	for _, p := range []string{filepath.Join("..", path), filepath.Join(filepath.Dir(exe), path), filepath.Join(filepath.Dir(exe), "..", path)} {
		if _, e := os.Stat(p); e == nil {
			return p
		}
	}
	return path
}
func vectorBearing(u, v float64) *float64 {
	if math.Hypot(u, v) < 1e-10 {
		return nil
	}
	b := math.Mod(math.Atan2(u, v)*180/math.Pi+360, 360)
	return &b
}
func readFlow(id string) (*FlowField, error) {
	raw, e := os.ReadFile(filepath.Join(systemsDir, id+"_snapshot.json"))
	if e != nil {
		return nil, e
	}
	var doc struct {
		Table struct {
			Names []string `json:"columnNames"`
			Rows  [][]any  `json:"rows"`
		} `json:"table"`
	}
	if e = json.Unmarshal(raw, &doc); e != nil {
		return nil, e
	}
	col := map[string]int{}
	for i, n := range doc.Table.Names {
		col[n] = i
	}
	u, v := "u", "v"
	if id == "wind" {
		u, v = "wind_u", "wind_v"
	}
	for _, n := range []string{"time", "longitude", "latitude", u, v} {
		if _, ok := col[n]; !ok {
			return nil, fmt.Errorf("missing %s", n)
		}
	}
	h := sha256.Sum256(raw)
	f := &FlowField{ID: id, SHA: hex.EncodeToString(h[:]), Points: []FlowPoint{}}
	if id == "wind" {
		f.Title = "Metop-C ASCAT monthly ocean surface winds"
		f.Source = "https://coastwatch.pfeg.noaa.gov/erddap/info/erdQCwindproductsMonthly/index.html"
		f.Native = "Approximately 1/3° provider grid; sampled every 3° (not an area average)"
		f.SampleStep = 3
		f.Note = "Satellite scatterometer monthly ocean winds from Metop-C ASCAT, via NOAA ERDDAP; no valid land vectors are supplied. Not a live forecast or pollutant transport model. Speed is magnitude of the monthly mean vector, not mean instantaneous speed."
	} else {
		f.Title = "NASA / JPL OSCAR v1 ocean currents · archive"
		f.Source = "https://coastwatch.pfeg.noaa.gov/erddap/info/jplOscar/index.html"
		f.Native = "1/3°; sampled every 2°; nominal 15 m depth"
		f.SampleStep = 2
		f.Note = "Historical 2014 archive from the NOAA mirror, NOT present-day currents. Coverage 80°S–80°N; missing land/invalid vectors are excluded. Use current OSCAR products for contemporary research."
	}
	for _, r := range doc.Table.Rows {
		if f.Date == "" {
			f.Date, _ = r[col["time"]].(string)
		}
		a, aok := r[col[u]].(float64)
		b, bok := r[col[v]].(float64)
		lon, lok := r[col["longitude"]].(float64)
		lat, tok := r[col["latitude"]].(float64)
		if !aok || !bok || !lok || !tok || !finite(a) || !finite(b) {
			continue
		}
		lon = math.Mod(lon+180, 360) - 180
		f.Points = append(f.Points, FlowPoint{lon, lat, a, b, math.Hypot(a, b), vectorBearing(a, b)})
	}
	nonzero := 0
	for _, p := range f.Points {
		if p.Speed > 0 {
			nonzero++
		}
	}
	if nonzero == 0 {
		return nil, fmt.Errorf("source contains no nonzero vectors; refusing misleading zero field")
	}
	return f, nil
}
func initSystems(datasetPath string) {
	systemsDir = filepath.Join(filepath.Dir(datasetPath), "systems")
	for _, id := range []string{"wind", "currents"} {
		f, e := readFlow(id)
		if e != nil {
			fmt.Printf("Layer %s unavailable: %v\n", id, e)
		} else {
			flowFields[id] = f
		}
	}
	raw, e := os.ReadFile(filepath.Join(systemsDir, "indicators.json"))
	if e == nil {
		var all []Indicator
		if json.Unmarshal(raw, &all) == nil {
			for _, s := range all {
				indicators[s.ID] = s
			}
		}
	}
}
func registerSystems(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/systems", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"flows": flowFields, "indicators": indicators, "version": "0.2.0", "capabilities": map[string]any{"temperature": "quantitative time-series trend and uncertainty", "wind": "vector snapshot and sampled regional summary", "currents": "historical vector snapshot and sampled regional summary", "air": "satellite indicator imagery only", "water": "satellite indicator imagery only", "habitat": "vegetation imagery only; not species suitability"}})
	})
	mux.HandleFunc("GET /api/flow", func(w http.ResponseWriter, r *http.Request) {
		f := flowFields[r.URL.Query().Get("id")]
		if f == nil {
			fail(w, 503, "Requested vector dataset is not installed")
			return
		}
		writeJSON(w, f)
	})
	mux.HandleFunc("GET /api/flow/analyze", serveFlowAnalysis)
	mux.HandleFunc("GET /api/indicator/{id}/{asset}", serveIndicator)
	mux.HandleFunc("GET /api/tiles/{id}/{date}/{z}/{y}/{x}", serveIndicatorTile)
}
func serveFlowAnalysis(w http.ResponseWriter, r *http.Request) {
	f := flowFields[r.URL.Query().Get("id")]
	if f == nil {
		fail(w, 400, "choose wind or currents")
		return
	}
	b, e := bounds(r)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	sum, us, vs, ss, n := 0., 0., 0., 0., 0
	for _, p := range f.Points {
		if p.Lon < b.West || p.Lon > b.East || p.Lat < b.South || p.Lat > b.North {
			continue
		}
		weight := math.Cos(p.Lat * math.Pi / 180)
		sum += weight
		us += weight * p.U
		vs += weight * p.V
		ss += weight * p.Speed
		n++
	}
	if sum <= 0 {
		fail(w, 422, "No valid sampled vectors inside these bounds; enlarge the region or choose an ocean region")
		return
	}
	u, v := us/sum, vs/sum
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", "attachment; filename=merobiman-flow-analysis.json")
	}
	writeJSON(w, map[string]any{"id": f.ID, "date": f.Date, "bounds": b, "sampleCount": n, "meanSampleSpeed": ss / sum, "meanU": u, "meanV": v, "meanVectorSpeed": math.Hypot(u, v), "bearingTo": vectorBearing(u, v), "units": "m/s", "method": "Cos(latitude)-weighted summary of valid sampled grid centers inside bounds; not exact region-integrated flux. Direction is TO, clockwise from north; opposite flows can cancel in the mean vector.", "source": f.Source, "sha256": f.SHA, "nativeGrid": f.Native, "limitations": f.Note, "significance": "Not estimated: a single temporal snapshot cannot establish a trend or its significance."})
}
func serveIndicator(w http.ResponseWriter, r *http.Request) {
	id, asset := r.PathValue("id"), r.PathValue("asset")
	if _, ok := indicators[id]; !ok {
		fail(w, 404, "unknown indicator")
		return
	}
	file := ""
	if asset == "overview.png" {
		file = id + "_overview.png"
	} else if asset == "legend.svg" {
		file = id + "_legend.svg"
	} else {
		fail(w, 404, "unknown asset")
		return
	}
	http.ServeFile(w, r, filepath.Join(systemsDir, file))
}
func serveIndicatorTile(w http.ResponseWriter, r *http.Request) {
	s, ok := indicators[r.PathValue("id")]
	if !ok {
		fail(w, 404, "unknown indicator")
		return
	}
	date := r.PathValue("date")
	if _, e := time.Parse("2006-01-02", date); e != nil || date < s.Min || date > s.Max {
		fail(w, 400, "date outside source coverage")
		return
	}
	allowed := false
	for _, span := range s.Intervals {
		parts := strings.Split(span, "/")
		if len(parts) >= 2 && date >= parts[0] && date <= parts[1] {
			allowed = true
			break
		}
	}
	if !allowed || (s.ID == "habitat" && !strings.HasSuffix(date, "-01")) {
		fail(w, 400, "date unavailable in source timeline")
		return
	}
	z, e := strconv.Atoi(r.PathValue("z"))
	y, e2 := strconv.Atoi(r.PathValue("y"))
	x, e3 := strconv.Atoi(strings.TrimSuffix(r.PathValue("x"), ".png"))
	limit := 7
	if s.ID == "air" {
		limit = 6
	}
	if e != nil || e2 != nil || e3 != nil || z < 0 || z > limit || x < 0 || y < 0 || x >= (1<<z) || y >= (1<<z) {
		fail(w, 400, "invalid tile")
		return
	}
	if z == 0 && date == s.Date {
		http.ServeFile(w, r, filepath.Join(systemsDir, s.ID+"_overview.png"))
		return
	}
	url := fmt.Sprintf("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/%s/default/%s/%s/%d/%d/%d.png", s.Layer, date, s.Matrix, z, y, x)
	client := &http.Client{Timeout: 18 * time.Second}
	resp, e := client.Get(url)
	if e != nil {
		fail(w, 502, "NASA imagery unavailable; no substitute date was used")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Type"), "image/") {
		fail(w, 502, "NASA returned no imagery for this tile/date")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	io.Copy(w, io.LimitReader(resp.Body, 8<<20))
}
