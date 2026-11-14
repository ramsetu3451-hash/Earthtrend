package main

import (
	"math"
	"testing"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }
func TestExactLinearTrend(t *testing.T) {
	s := []Observation{}
	for y := 1980; y < 2020; y++ {
		s = append(s, Observation{y, 2 + 0.03*float64(y-1980)})
	}
	r := fit(s)
	if !near(r.Slope, .3) || r.P != 0 || r.R2 < .999999 {
		t.Fatalf("linear fit %+v", r)
	}
}
func TestConstantNoEvidence(t *testing.T) {
	s := []Observation{}
	for y := 1980; y < 2020; y++ {
		s = append(s, Observation{y, 1.0})
	}
	r := fit(s)
	if r.Slope != 0 || r.P != 1 {
		t.Fatal(r)
	}
}
func TestInsufficientFit(t *testing.T) {
	if fit([]Observation{{2000, 1}, {2001, 2}}) != nil {
		t.Fatal("accepted insufficient observations")
	}
}
func TestBH(t *testing.T) {
	q := adjustBH([]float64{.01, .04, .03, .8})
	want := []float64{.04, .05333333333333334, .05333333333333334, .8}
	for i := range q {
		if !near(q[i], want[i]) {
			t.Fatalf("q %v", q)
		}
	}
}
func TestAreaWeight(t *testing.T) {
	b := Bounds{-1, -1, 1, 1}
	w := areaWeight(0, 0, b)
	if !near(w, 2*math.Sin(math.Pi/180)*2*math.Pi/180) {
		t.Fatal(w)
	}
	if areaWeight(10, 10, b) != 0 {
		t.Fatal("nonoverlap has area")
	}
}
func TestRejectUnknownNC(t *testing.T) {
	if _, e := parseNC([]byte("not ncdf")); e == nil {
		t.Fatal("accepted invalid format")
	}
}
