package main

import (
	"math"
	"sort"
)

const methodVersion = "ols-hac-bh-v1"

type Observation struct {
	Year  int     `json:"year"`
	Value float64 `json:"value"`
}
type Trend struct {
	Slope     float64 `json:"slopePerDecade"`
	Low       float64 `json:"ciLow"`
	High      float64 `json:"ciHigh"`
	P         float64 `json:"pValue"`
	N         int     `json:"nYears"`
	Lag       int     `json:"hacLag"`
	Intercept float64 `json:"intercept"`
	R2        float64 `json:"rSquared"`
}

// OLS with Bartlett Newey-West covariance, finite-sample n/(n-2) scaling.
// Confidence intervals/p-values use the asymptotic normal approximation.
// Lag pairs are actual calendar-year distances, not compacted row indices.
func fit(series []Observation) *Trend {
	n := len(series)
	if n < 3 {
		return nil
	}
	var mx, my float64
	for _, p := range series {
		mx += float64(p.Year)
		my += p.Value
	}
	mx /= float64(n)
	my /= float64(n)
	var xx, xy float64
	for _, p := range series {
		x := float64(p.Year) - mx
		xx += x * x
		xy += x * (p.Value - my)
	}
	if xx == 0 {
		return nil
	}
	b := xy / xx
	lag := int(math.Floor(4 * math.Pow(float64(n)/100, 2.0/9.0)))
	lag = min(lag, n-2)
	u := make([]float64, n)
	var meat, sse, sst float64
	for i, p := range series {
		x := float64(p.Year) - mx
		res := p.Value - my - b*x
		u[i] = x * res
		meat += u[i] * u[i]
		sse += res * res
		sst += (p.Value - my) * (p.Value - my)
	}
	for i := 0; i < n; i++ {
		for j := i - 1; j >= 0; j-- {
			gap := series[i].Year - series[j].Year
			if gap > lag {
				break
			}
			if gap > 0 {
				meat += 2 * (1 - float64(gap)/float64(lag+1)) * u[i] * u[j]
			}
		}
	}
	variance := math.Max(meat, 0) / (xx * xx) * float64(n) / float64(n-2)
	se := math.Sqrt(variance)
	p := 1.0
	if se > 1e-15 {
		p = math.Erfc(math.Abs(b/se) / math.Sqrt2)
	} else if math.Abs(b) > 1e-15 {
		p = 0
	}
	r2 := 0.0
	if sst > 0 {
		r2 = 1 - sse/sst
	}
	return &Trend{Slope: b * 10, Low: (b - 1.959963984540054*se) * 10, High: (b + 1.959963984540054*se) * 10, P: p, N: n, Lag: lag, Intercept: my - b*mx, R2: r2}
}

// Benjamini-Hochberg adjusted q-values across every eligible native-grid cell.
// BH assumes independent or suitably positively dependent tests. It is not a
// guarantee of spatial field significance under arbitrary dependence.
func adjustBH(p []float64) []float64 {
	ids := make([]int, len(p))
	for i := range ids {
		ids[i] = i
	}
	sort.Slice(ids, func(i, j int) bool { return p[ids[i]] < p[ids[j]] })
	q := make([]float64, len(p))
	next := 1.0
	for k := len(ids) - 1; k >= 0; k-- {
		next = math.Min(next, p[ids[k]]*float64(len(ids))/float64(k+1))
		q[ids[k]] = math.Min(1, next)
	}
	return q
}
