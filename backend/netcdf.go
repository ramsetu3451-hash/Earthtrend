package main

// Minimal, bounded NetCDF classic reader. Deliberately rejects unsupported
// encodings rather than silently interpreting NetCDF4/HDF5 incorrectly.
import (
	"encoding/binary"
	"fmt"
	"math"
)

type ncDim struct {
	Name string
	Size int
}
type ncVar struct {
	Name       string
	Dims       []int
	Attr       map[string]ncAttr
	Type, Size int
	Offset     int
}
type ncAttr struct {
	Text    string
	Numbers []float64
}
type ncFile struct {
	Data    []byte
	Dims    []ncDim
	Vars    map[string]ncVar
	Attr    map[string]ncAttr
	Records int
}
type ncReader struct {
	data    []byte
	pos     int
	version byte
	err     error
}

func (r *ncReader) read(n int) []byte {
	if r.err != nil {
		return make([]byte, n)
	}
	if n < 0 || r.pos+n > len(r.data) {
		r.err = fmt.Errorf("truncated NetCDF header at %d", r.pos)
		return make([]byte, max(n, 0))
	}
	b := r.data[r.pos : r.pos+n]
	r.pos += n
	return b
}
func (r *ncReader) u32() int { return int(binary.BigEndian.Uint32(r.read(4))) }
func (r *ncReader) name() string {
	n := r.u32()
	if n > 1<<20 {
		r.err = fmt.Errorf("invalid NetCDF name")
		return ""
	}
	b := r.read(n)
	r.read((4 - n%4) % 4)
	return string(b)
}
func typeSize(t int) int {
	switch t {
	case 1, 2:
		return 1
	case 3:
		return 2
	case 4, 5:
		return 4
	case 6:
		return 8
	}
	return 0
}
func number(b []byte, t int) float64 {
	switch t {
	case 1:
		return float64(int8(b[0]))
	case 3:
		return float64(int16(binary.BigEndian.Uint16(b)))
	case 4:
		return float64(int32(binary.BigEndian.Uint32(b)))
	case 5:
		return float64(math.Float32frombits(binary.BigEndian.Uint32(b)))
	case 6:
		return math.Float64frombits(binary.BigEndian.Uint64(b))
	}
	return math.NaN()
}
func (r *ncReader) attrs() map[string]ncAttr {
	a := map[string]ncAttr{}
	tag, n := r.u32(), r.u32()
	if tag == 0 && n == 0 {
		return a
	}
	if tag != 12 || n > 10000 {
		r.err = fmt.Errorf("invalid attributes")
		return a
	}
	for i := 0; i < n && r.err == nil; i++ {
		name := r.name()
		t, count := r.u32(), r.u32()
		size := typeSize(t) * count
		if typeSize(t) == 0 || size > 1<<24 {
			r.err = fmt.Errorf("unsupported attribute type/length")
			return a
		}
		b := r.read(size)
		r.read((4 - size%4) % 4)
		v := ncAttr{}
		if t == 2 {
			v.Text = string(b)
		} else {
			for j := 0; j < count; j++ {
				v.Numbers = append(v.Numbers, number(b[j*typeSize(t):], t))
			}
		}
		a[name] = v
	}
	return a
}
func parseNC(data []byte) (*ncFile, error) {
	if len(data) < 8 || string(data[:3]) != "CDF" || (data[3] != 1 && data[3] != 2) {
		return nil, fmt.Errorf("only NetCDF classic CDF1/CDF2 is supported")
	}
	r := ncReader{data: data, pos: 4, version: data[3]}
	f := &ncFile{Data: data, Records: r.u32(), Vars: map[string]ncVar{}}
	tag, n := r.u32(), r.u32()
	if tag != 10 || n > 100 {
		return nil, fmt.Errorf("invalid dimensions")
	}
	for i := 0; i < n; i++ {
		f.Dims = append(f.Dims, ncDim{r.name(), r.u32()})
	}
	f.Attr = r.attrs()
	tag, n = r.u32(), r.u32()
	if tag != 11 || n > 1000 {
		return nil, fmt.Errorf("invalid variable table")
	}
	for i := 0; i < n && r.err == nil; i++ {
		v := ncVar{Name: r.name()}
		nd := r.u32()
		if nd > 20 {
			return nil, fmt.Errorf("too many dimensions")
		}
		for j := 0; j < nd; j++ {
			d := r.u32()
			if d >= len(f.Dims) {
				return nil, fmt.Errorf("invalid dimension index")
			}
			v.Dims = append(v.Dims, d)
		}
		v.Attr = r.attrs()
		v.Type = r.u32()
		v.Size = r.u32()
		if r.version == 1 {
			v.Offset = r.u32()
		} else {
			v.Offset = int(binary.BigEndian.Uint64(r.read(8)))
		}
		if typeSize(v.Type) == 0 {
			return nil, fmt.Errorf("unsupported variable type")
		}
		f.Vars[v.Name] = v
	}
	if r.err != nil {
		return nil, r.err
	}
	return f, nil
}
func (f *ncFile) raw(v ncVar, i int) (float64, error) { // NASA's file has fixed-size, non-record variables.
	for _, d := range v.Dims {
		if f.Dims[d].Size == 0 {
			return 0, fmt.Errorf("record variables not supported by this dataset adapter")
		}
	}
	offset := v.Offset + i*typeSize(v.Type)
	if offset < 0 || offset+typeSize(v.Type) > len(f.Data) {
		return 0, fmt.Errorf("variable %s out of bounds", v.Name)
	}
	return number(f.Data[offset:], v.Type), nil
}
func attrNumber(v ncVar, k string, fallback float64) float64 {
	if a, ok := v.Attr[k]; ok && len(a.Numbers) > 0 {
		return a.Numbers[0]
	}
	return fallback
}
