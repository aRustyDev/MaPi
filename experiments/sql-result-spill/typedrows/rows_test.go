package typedrows

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"reflect"
	"testing"
)

type memorySource struct {
	frames        []Frame
	index, closes int
	scratch       []byte
	err           error
}

func (s *memorySource) NextFrame() (Frame, error) {
	if s.index == len(s.frames) {
		if s.err != nil {
			return Frame{}, s.err
		}
		return Frame{}, io.EOF
	}
	f := s.frames[s.index]
	s.index++
	// Model a host that reuses its input buffer for every frame.
	s.scratch = append(s.scratch[:0], f.Data...)
	f.Data = s.scratch
	return f, nil
}
func (s *memorySource) Close() error { s.closes++; return nil }

func word(v uint64) []byte { b := make([]byte, 8); binary.BigEndian.PutUint64(b, v); return b }
func frames(row, col uint64, kind Kind, data []byte, step int) []Frame {
	var out []Frame
	if len(data) == 0 {
		return []Frame{{Row: row, Column: col, Kind: kind, Final: true}}
	}
	for offset := 0; offset < len(data); offset += step {
		end := offset + step
		if end > len(data) {
			end = len(data)
		}
		out = append(out, Frame{Row: row, Column: col, Offset: uint64(offset), Total: uint64(len(data)), Kind: kind, Final: end == len(data), Data: data[offset:end]})
	}
	return out
}
func add(dst []Frame, row, col uint64, k Kind, b []byte) []Frame {
	return append(dst, frames(row, col, k, b, 3)...)
}
func limits() Limits {
	return Limits{MaxColumns: 100, MaxMetadata: 100000, MaxFrame: 32768, MaxCell: 8388700, MaxRow: 8388700}
}

func TestMixedTypesAndOrderedMultirow(t *testing.T) {
	var input []Frame
	input = add(input, 0, 0, Integer, word(uint64(1<<63)))
	input = add(input, 0, 1, Integer, word(uint64(math.MaxInt64)))
	input = add(input, 0, 2, Text, []byte("9223372036854775807"))
	input = add(input, 0, 3, Blob, []byte{0, 255, 1})
	input = add(input, 0, 4, Real, word(math.Float64bits(math.Inf(1))))
	input = add(input, 0, 5, Null, nil)
	input = add(input, 1, 0, Integer, word(0))
	input = add(input, 1, 1, Integer, word(1))
	input = add(input, 1, 2, Text, []byte{0xff, 0, 0xc3, 0xa9})
	input = add(input, 1, 3, Blob, nil)
	input = add(input, 1, 4, Real, word(math.Float64bits(math.Copysign(0, -1))))
	input = add(input, 1, 5, Text, nil)
	s := &memorySource{frames: input}
	r, err := New([]string{"same", "same", "text", "blob", "real", "null"}, s, 2, limits())
	if err != nil {
		t.Fatal(err)
	}
	cols := r.Columns()
	cols[0] = "modified"
	if r.Columns()[0] != "same" {
		t.Fatal("column aliases mutated")
	}
	dest := make([]driver.Value, 6)
	if err = r.Next(dest); err != nil {
		t.Fatal(err)
	}
	if dest[0] != int64(math.MinInt64) || dest[1] != int64(math.MaxInt64) || dest[2] != "9223372036854775807" || !bytes.Equal(dest[3].([]byte), []byte{0, 255, 1}) || !math.IsInf(dest[4].(float64), 1) || dest[5] != nil {
		t.Fatalf("first row: %#v", dest)
	}
	firstBlob := dest[3].([]byte)
	if err = r.Next(dest); err != nil {
		t.Fatal(err)
	}
	if dest[0] != int64(0) || dest[1] != int64(1) || !bytes.Equal([]byte(dest[2].(string)), []byte{0xff, 0, 0xc3, 0xa9}) || dest[3] == nil || len(dest[3].([]byte)) != 0 || !math.Signbit(dest[4].(float64)) || dest[5] != "" {
		t.Fatalf("second row: %#v", dest)
	}
	if !bytes.Equal(firstBlob, []byte{0, 255, 1}) {
		t.Fatal("source reuse mutated previously returned BLOB")
	}
	if err = r.Next(dest); !errors.Is(err, io.EOF) {
		t.Fatalf("end: %v", err)
	}
	if err = r.Close(); err != nil {
		t.Fatal(err)
	}
	if err = r.Close(); err != nil || s.closes != 1 {
		t.Fatal("close not idempotent")
	}
}

func TestHundredColumnNearLimitBlob(t *testing.T) {
	value := make([]byte, 8388530)
	copy(value, []byte{255, 0, 0, 0, 0, 0, 0, 0, 0})
	copy(value[9:], "@MaPiRun1")
	for i := 0; i < 65; i++ {
		value[18+(len(value)-18-64)*(i+1)/66] = byte(i + 1)
	}
	input := frames(0, 0, Blob, value, 32768)
	for col := uint64(1); col < 100; col++ {
		input = append(input, frames(0, col, Null, nil, 32768)...)
	}
	s := &memorySource{frames: input}
	r, err := New(make([]string, 100), s, 1, limits())
	if err != nil {
		t.Fatal(err)
	}
	dest := make([]driver.Value, 100)
	if err = r.Next(dest); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(dest[0].([]byte), value) {
		t.Fatal("near-limit BLOB changed")
	}
	for _, cell := range dest[1:] {
		if cell != nil {
			t.Fatal("NULL changed")
		}
	}
	if err = r.Next(dest); !errors.Is(err, io.EOF) {
		t.Fatalf("end: %v", err)
	}
}

func TestRejectsMalformedFramesWithoutPartialRows(t *testing.T) {
	good := []Frame{{Row: 0, Column: 0, Kind: Text, Total: 2, Data: []byte("a")}, {Row: 0, Column: 0, Offset: 1, Total: 2, Kind: Text, Data: []byte("b"), Final: true}, {Row: 0, Column: 1, Kind: Null, Final: true}}
	cases := []struct {
		name string
		edit func([]Frame) []Frame
	}{
		{"row", func(f []Frame) []Frame { f[0].Row = 1; return f }},
		{"column", func(f []Frame) []Frame { f[0].Column = 1; return f }},
		{"initial offset", func(f []Frame) []Frame { f[0].Offset = 1; return f }},
		{"continuation offset", func(f []Frame) []Frame { f[1].Offset = 0; return f }},
		{"changed type", func(f []Frame) []Frame { f[1].Kind = Blob; return f }},
		{"changed total", func(f []Frame) []Frame { f[1].Total = 3; return f }},
		{"premature final", func(f []Frame) []Frame { f[0].Final = true; return f }},
		{"missing final", func(f []Frame) []Frame { f[1].Final = false; return f }},
		{"zero progress", func(f []Frame) []Frame { f[0].Data = nil; return f }},
		{"oversize frame", func(f []Frame) []Frame { f[0].Data = make([]byte, 32769); return f }},
		{"over cell budget", func(f []Frame) []Frame { f[0].Total = 8388701; return f }},
		{"bad kind", func(f []Frame) []Frame { f[0].Kind = 99; return f }},
		{"invalid null", func(f []Frame) []Frame { f[2].Total = 1; f[2].Data = []byte{0}; return f }},
		{"short integer", func(f []Frame) []Frame {
			f[0] = Frame{Row: 0, Column: 0, Kind: Integer, Total: 1, Data: []byte{1}, Final: true}
			return f
		}},
		{"truncated cell", func(f []Frame) []Frame { return f[:1] }},
		{"truncated row", func(f []Frame) []Frame { return f[:2] }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := append([]Frame(nil), good...)
			s := &memorySource{frames: tc.edit(input)}
			r, err := New([]string{"a", "b"}, s, 1, limits())
			if err != nil {
				t.Fatal(err)
			}
			dest := []driver.Value{"unchanged-1", "unchanged-2"}
			err = r.Next(dest)
			if err == nil || errors.Is(err, io.EOF) {
				t.Fatalf("accepted malformed frames: %v", err)
			}
			if !reflect.DeepEqual(dest, []driver.Value{"unchanged-1", "unchanged-2"}) {
				t.Fatalf("partial row published: %#v", dest)
			}
			if again := r.Next(dest); again != err {
				t.Fatal("error was not retained")
			}
			if err = r.Close(); err != nil || s.closes != 1 {
				t.Fatal("source not closed")
			}
		})
	}
}

func TestRowBudgetAndNaN(t *testing.T) {
	for _, tc := range []struct {
		name   string
		input  []Frame
		budget uint64
	}{
		{"row budget", []Frame{{Row: 0, Column: 0, Kind: Text, Total: 2, Final: true, Data: []byte("ab")}, {Row: 0, Column: 1, Kind: Text, Total: 2, Final: true, Data: []byte("cd")}}, 3},
		{"nan", []Frame{{Row: 0, Column: 0, Kind: Real, Total: 8, Final: true, Data: word(math.Float64bits(math.NaN()))}}, 8},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cols := []string{"a", "b"}
			if tc.name == "nan" {
				cols = cols[:1]
			}
			s := &memorySource{frames: tc.input}
			r, err := New(cols, s, 1, Limits{MaxColumns: 100, MaxMetadata: 100000, MaxFrame: 16, MaxCell: tc.budget, MaxRow: tc.budget})
			if err != nil {
				t.Fatal(err)
			}
			dest := make([]driver.Value, len(cols))
			if err = r.Next(dest); err == nil || errors.Is(err, io.EOF) {
				t.Fatalf("accepted %s", tc.name)
			}
		})
	}
}

type generatedSource struct {
	index  int
	closed bool
}

func (s *generatedSource) NextFrame() (Frame, error) {
	if s.index == 20000 {
		return Frame{}, io.EOF
	}
	n := s.index
	s.index++
	if n%2 == 0 {
		return Frame{Row: uint64(n / 2), Column: 0, Kind: Integer, Total: 8, Final: true, Data: word(uint64(n / 2))}, nil
	}
	return Frame{Row: uint64(n / 2), Column: 1, Kind: Text, Total: 1, Final: true, Data: []byte("x")}, nil
}
func (s *generatedSource) Close() error { s.closed = true; return nil }
func TestNoWholeResultPrefetch(t *testing.T) {
	s := &generatedSource{}
	r, err := New([]string{"n", "v"}, s, 10000, limits())
	if err != nil {
		t.Fatal(err)
	}
	dest := make([]driver.Value, 2)
	for i := 0; i < 10000; i++ {
		if err = r.Next(dest); err != nil {
			t.Fatal(err)
		}
		if s.index != 2*(i+1) || dest[0] != int64(i) || dest[1] != "x" {
			t.Fatalf("unexpected prefetch or value at %d", i)
		}
	}
	if err = r.Next(dest); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	if err = r.Close(); err != nil || !s.closed {
		t.Fatal("source did not close")
	}
}

func TestConfigurationAndMetadataBounds(t *testing.T) {
	valid := limits()
	if _, err := New(nil, &memorySource{}, 1, valid); err == nil {
		t.Fatal("accepted no columns")
	}
	if _, err := New(make([]string, 101), &memorySource{}, 1, valid); err == nil {
		t.Fatal("accepted too many columns")
	}
	if _, err := New([]string{string(make([]byte, 100001))}, &memorySource{}, 1, valid); err == nil {
		t.Fatal("accepted oversized metadata")
	}
	valid.MaxCell = valid.MaxRow + 1
	if _, err := New([]string{"v"}, &memorySource{}, 1, valid); err == nil {
		t.Fatal("accepted inconsistent limits")
	}
}

func TestSourceFailureAndRowReplay(t *testing.T) {
	boom := errors.New("injected source failure")
	s := &memorySource{frames: []Frame{{Row: 0, Column: 0, Kind: Text, Total: 2, Data: []byte("a")}}, err: boom}
	r, err := New([]string{"v"}, s, 1, limits())
	if err != nil {
		t.Fatal(err)
	}
	dest := []driver.Value{"unchanged"}
	if err = r.Next(dest); !errors.Is(err, boom) || dest[0] != "unchanged" {
		t.Fatalf("source failure: %v %#v", err, dest)
	}
	if err = r.Close(); err != nil || s.closes != 1 {
		t.Fatal("failed source was not closed")
	}

	first := frames(0, 0, Text, []byte("one"), 3)[0]
	s = &memorySource{frames: []Frame{first, first}}
	r, err = New([]string{"v"}, s, 1, limits())
	if err != nil {
		t.Fatal(err)
	}
	if err = r.Next(dest); err != nil || dest[0] != "one" {
		t.Fatalf("valid first row: %v", err)
	}
	dest[0] = "unchanged"
	if err = r.Next(dest); err == nil || errors.Is(err, io.EOF) || dest[0] != "unchanged" {
		t.Fatalf("accepted repeated row: %v %#v", err, dest)
	}
}

// This adapter exercises database/sql against a synthetic already-typed
// source. It does not implement the production host or establish a snapshot.
type testDriver struct{ source *memorySource }
type testConn struct{ source *memorySource }
type testConnector struct{ source *memorySource }

func (c testConnector) Connect(context.Context) (driver.Conn, error) {
	return testConn{source: c.source}, nil
}
func (c testConnector) Driver() driver.Driver { return testDriver{source: c.source} }

func (d testDriver) Open(string) (driver.Conn, error)  { return testConn{source: d.source}, nil }
func (c testConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not implemented") }
func (c testConn) Close() error                        { return nil }
func (c testConn) Begin() (driver.Tx, error)           { return nil, errors.New("not implemented") }
func (c testConn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return New([]string{"int", "text", "blob", "real", "null"}, c.source, 1, limits())
}

func TestDatabaseSQLConsumesTypedFrames(t *testing.T) {
	var input []Frame
	input = add(input, 0, 0, Integer, word(uint64(math.MaxInt64)))
	input = add(input, 0, 1, Text, []byte("9223372036854775807"))
	input = add(input, 0, 2, Blob, []byte{0, 255})
	input = add(input, 0, 3, Real, word(math.Float64bits(math.Inf(-1))))
	input = add(input, 0, 4, Null, nil)
	source := &memorySource{frames: input}
	db := sql.OpenDB(testConnector{source: source})
	defer db.Close()
	result, err := db.QueryContext(context.Background(), "synthetic")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Next() {
		t.Fatalf("missing row: %v", result.Err())
	}
	var i int64
	var text string
	var blob []byte
	var real float64
	var null any
	if err = result.Scan(&i, &text, &blob, &real, &null); err != nil {
		t.Fatal(err)
	}
	if i != math.MaxInt64 || text != "9223372036854775807" || !bytes.Equal(blob, []byte{0, 255}) || !math.IsInf(real, -1) || null != nil {
		t.Fatalf("scanned wrong values: %d %q %v %v %#v", i, text, blob, real, null)
	}
	if result.Next() || result.Err() != nil {
		t.Fatalf("unexpected next row: %v", result.Err())
	}
	if err = result.Close(); err != nil || source.closes != 1 {
		t.Fatal("database/sql did not release source")
	}
}

func TestSealedRowCount(t *testing.T) {
	one := Frame{Row: 0, Column: 0, Kind: Text, Total: 1, Final: true, Data: []byte("a")}
	two := Frame{Row: 1, Column: 0, Kind: Text, Total: 1, Final: true, Data: []byte("b")}
	for _, tc := range []struct {
		name      string
		expected  uint64
		input     []Frame
		success   int
		wantError bool
	}{
		{"empty", 0, nil, 0, false},
		{"unexpected row", 0, []Frame{one}, 0, true},
		{"missing row", 2, []Frame{one}, 1, true},
		{"extra row", 1, []Frame{one, two}, 1, true},
		{"complete", 2, []Frame{one, two}, 2, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &memorySource{frames: tc.input}
			r, err := New([]string{"v"}, s, tc.expected, limits())
			if err != nil {
				t.Fatal(err)
			}
			dest := []driver.Value{"untouched"}
			for i := 0; i < tc.success; i++ {
				if err = r.Next(dest); err != nil {
					t.Fatal(err)
				}
			}
			dest[0] = "untouched"
			err = r.Next(dest)
			if tc.wantError {
				if err == nil || errors.Is(err, io.EOF) || dest[0] != "untouched" {
					t.Fatalf("accepted invalid terminal sequence: %v %#v", err, dest)
				}
			} else if !errors.Is(err, io.EOF) {
				t.Fatalf("expected EOF, got %v", err)
			}
		})
	}
}

func TestEarlyCloseDoesNotPrefetch(t *testing.T) {
	one := Frame{Row: 0, Column: 0, Kind: Text, Total: 1, Final: true, Data: []byte("a")}
	two := Frame{Row: 1, Column: 0, Kind: Text, Total: 1, Final: true, Data: []byte("b")}
	s := &memorySource{frames: []Frame{one, two}}
	r, err := New([]string{"v"}, s, 2, limits())
	if err != nil {
		t.Fatal(err)
	}
	dest := make([]driver.Value, 1)
	if err = r.Next(dest); err != nil || dest[0] != "a" {
		t.Fatalf("first row: %v %#v", err, dest)
	}
	if err = r.Close(); err != nil || s.closes != 1 || s.index != 1 {
		t.Fatal("early close prefetched or leaked source")
	}
	if err = r.Next(dest); !errors.Is(err, io.EOF) {
		t.Fatalf("closed reader returned %v", err)
	}
}
