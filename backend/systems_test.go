package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestVectorBearing(t *testing.T) {
	for _, s := range []struct{ u, v, w float64 }{{1, 0, 90}, {0, 1, 0}, {-1, 0, 270}, {0, -1, 180}} {
		b := vectorBearing(s.u, s.v)
		if b == nil || math.Abs(*b-s.w) > 1e-9 {
			t.Fatal(s, b)
		}
	}
	if vectorBearing(0, 0) != nil {
		t.Fatal("calm direction must be null")
	}
}
func TestRealFlowSnapshots(t *testing.T) {
	systemsDir = "../data/systems"
	for _, id := range []string{"wind", "currents"} {
		f, e := readFlow(id)
		if e != nil {
			t.Fatal(e)
		}
		if len(f.Points) < 1000 {
			t.Fatal("unexpected empty field")
		}
		for _, p := range f.Points {
			if p.Lon < -180 || p.Lon >= 180 || p.Lat < -90 || p.Lat > 90 || math.Abs(p.Speed-math.Hypot(p.U, p.V)) > 1e-12 {
				t.Fatal("invalid vector", p)
			}
		}
		flowFields[id] = f
	}
	r := httptest.NewRequest("GET", "/api/flow/analyze?id=currents&west=-70&east=0&south=10&north=60", nil)
	w := httptest.NewRecorder()
	serveFlowAnalysis(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	if result["date"] != "2014-09-26T00:00:00Z" {
		t.Fatal("archive date lost", result["date"])
	}
	r = httptest.NewRequest("GET", "/api/flow/analyze?id=wind&west=40&east=-40", nil)
	w = httptest.NewRecorder()
	serveFlowAnalysis(w, r)
	if w.Code != 400 {
		t.Fatal("invalid bounds accepted")
	}
}
func TestRelativeDataPath(t *testing.T) {
	p := resolveDataPath("data/gistemp.nc.gz")
	if _, e := os.Stat(p); e != nil {
		t.Fatal("go run from backend path failed", p)
	}
	if filepath.Clean(p) != filepath.Clean("../data/gistemp.nc.gz") {
		t.Fatal(p)
	}
}
func TestTileValidation(t *testing.T) {
	indicators["air"] = Indicator{ID: "air", Min: "2000-01-01", Max: "2026-11-01", Intervals: []string{"2000-01-01/2026-11-01/P1D"}}
	mux := http.NewServeMux()
	registerSystems(mux)
	for _, url := range []string{"/api/tiles/air/2027-01-01/0/0/0.png", "/api/tiles/air/2026-10-28/8/0/0.png", "/api/tiles/air/2026-10-28/2/9/0.png"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", url, nil))
		if w.Code != 400 {
			t.Fatal(url, w.Code)
		}
	}
}
