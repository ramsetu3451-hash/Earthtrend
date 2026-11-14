package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const dataURL = "https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz"
const sourceURL = "https://data.giss.nasa.gov/gistemp/data_v4.html"

type Dataset struct {
	Lat, Lon                 []float64
	Years                    []int
	Annual                   [][]float64
	First, Last              int
	SHA, History, Downloaded string
	MonthlyRecords           int
}

func ensureData(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	log.Printf("Downloading real NASA data: %s", dataURL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", dataURL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("NASA download HTTP %d", resp.StatusCode)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "nasa-*.part")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	_, err = io.Copy(tmp, io.LimitReader(resp.Body, 256<<20))
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, path)
}
func loadDataset(path string) (*Dataset, error) {
	if err := ensureData(path); err != nil {
		return nil, err
	}
	compressed, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(compressed)
	z, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(z, 512<<20))
	z.Close()
	if err != nil {
		return nil, err
	}
	nc, err := parseNC(raw)
	if err != nil {
		return nil, err
	}
	d := &Dataset{SHA: hex.EncodeToString(sum[:]), History: nc.Attr["history"].Text}
	stat, _ := os.Stat(path)
	if stat != nil {
		d.Downloaded = stat.ModTime().UTC().Format(time.RFC3339)
	}
	coords := func(name string) ([]float64, error) {
		v, ok := nc.Vars[name]
		if !ok {
			return nil, fmt.Errorf("missing coordinate %s", name)
		}
		n := nc.Dims[v.Dims[0]].Size
		a := make([]float64, n)
		for i := range a {
			a[i], err = nc.raw(v, i)
			if err != nil {
				return nil, err
			}
		}
		return a, nil
	}
	if d.Lat, err = coords("lat"); err != nil {
		return nil, err
	}
	if d.Lon, err = coords("lon"); err != nil {
		return nil, err
	}
	tv, ok := nc.Vars["time"]
	if !ok {
		return nil, fmt.Errorf("missing time")
	}
	if tv.Attr["units"].Text != "days since 1800-01-01 00:00:00" {
		return nil, fmt.Errorf("unexpected time units %q", tv.Attr["units"].Text)
	}
	temp, ok := nc.Vars["tempanomaly"]
	if !ok {
		return nil, fmt.Errorf("missing tempanomaly")
	}
	if len(temp.Dims) != 3 || nc.Dims[temp.Dims[0]].Name != "time" || nc.Dims[temp.Dims[1]].Name != "lat" || nc.Dims[temp.Dims[2]].Name != "lon" {
		return nil, fmt.Errorf("unexpected temperature dimensions")
	}
	nt := nc.Dims[tv.Dims[0]].Size
	d.MonthlyRecords = nt
	years := make([]int, nt)
	monthsPerYear := map[int]int{}
	base := time.Date(1800, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < nt; i++ {
		days, e := nc.raw(tv, i)
		if e != nil {
			return nil, e
		}
		date := base.AddDate(0, 0, int(days))
		years[i] = date.Year()
		monthsPerYear[date.Year()]++
	}
	for y := years[0]; y <= years[nt-1]; y++ {
		if monthsPerYear[y] == 12 && y < time.Now().UTC().Year() {
			d.Years = append(d.Years, y)
		}
	}
	if len(d.Years) == 0 {
		return nil, fmt.Errorf("no complete calendar years")
	}
	d.First = d.Years[0]
	d.Last = d.Years[len(d.Years)-1]
	cells := len(d.Lat) * len(d.Lon)
	d.Annual = make([][]float64, len(d.Years))
	index := map[int]int{}
	counts := make([][]int, len(d.Years))
	for i, y := range d.Years {
		index[y] = i
		d.Annual[i] = make([]float64, cells)
		counts[i] = make([]int, cells)
	}
	scale, offset, fill := attrNumber(temp, "scale_factor", 1), attrNumber(temp, "add_offset", 0), attrNumber(temp, "_FillValue", math.NaN())
	for t, y := range years {
		yi, ok := index[y]
		if !ok {
			continue
		}
		for c := 0; c < cells; c++ {
			v, e := nc.raw(temp, t*cells+c)
			if e != nil {
				return nil, e
			}
			if v == fill || math.IsNaN(v) || math.IsInf(v, 0) {
				continue
			}
			d.Annual[yi][c] += v*scale + offset
			counts[yi][c]++
		}
	}
	for i := range d.Annual {
		for c := range d.Annual[i] {
			if counts[i][c] == 12 {
				d.Annual[i][c] /= 12
			} else {
				d.Annual[i][c] = math.NaN()
			}
		}
	}
	log.Printf("NASA loaded: %d x %d, %d monthly records, complete years %d–%d; SHA256 %s", len(d.Lat), len(d.Lon), nt, d.First, d.Last, d.SHA)
	return d, nil
}
func (d *Dataset) series(cell, start, end int) []Observation {
	out := []Observation{}
	for i, y := range d.Years {
		if y >= start && y <= end && !math.IsNaN(d.Annual[i][cell]) {
			out = append(out, Observation{y, d.Annual[i][cell]})
		}
	}
	return out
}
