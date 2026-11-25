//go:build wasip1

// Test-only Go/Wasm consumer for a small, explicitly typed SQL projection.
package main

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"math"
	"unsafe"

	"mapi-typedrows-probe/typedrows"
)

//go:wasmimport mapi next
func hostNext() uint32

//go:wasmimport mapi result
func hostResult(ptr unsafe.Pointer, size uint32)

//go:wasmimport mapi close
func hostClose() uint32

type source struct{}

func (source) NextFrame() (typedrows.Frame, error) {
	n := hostNext()
	if n == 0 {
		return typedrows.Frame{}, io.EOF
	}
	if n > 65536 {
		return typedrows.Frame{}, errors.New("oversized host frame")
	}
	data := make([]byte, n)
	hostResult(unsafe.Pointer(&data[0]), n)
	var f typedrows.Frame
	if err := json.Unmarshal(data, &f); err != nil {
		return typedrows.Frame{}, err
	}
	return f, nil
}
func (source) Close() error {
	if hostClose() != 0 {
		return errors.New("host close failed")
	}
	return nil
}

var expectedRows uint64 = 10

type connector struct{}
type conn struct{}

func (connector) Connect(context.Context) (driver.Conn, error) { return conn{}, nil }
func (connector) Driver() driver.Driver                        { return conn{} }
func (conn) Open(string) (driver.Conn, error)                  { return conn{}, nil }
func (conn) Prepare(string) (driver.Stmt, error)               { return nil, errors.ErrUnsupported }
func (conn) Close() error                                      { return nil }
func (conn) Begin() (driver.Tx, error)                         { return nil, errors.ErrUnsupported }
func (conn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return typedrows.New([]string{"id", "value"}, source{}, expectedRows, typedrows.Limits{MaxColumns: 100, MaxMetadata: 100000, MaxFrame: 32768, MaxCell: 8388700, MaxRow: 8388700})
}

//go:wasmexport mapi_typed_check
func check(flags uint32) uint32 {
	expectedRows = 10
	if flags&1 != 0 {
		expectedRows--
	}
	if flags&2 != 0 {
		expectedRows--
	}
	db := sql.OpenDB(connector{})
	defer db.Close()
	rows, err := db.QueryContext(context.Background(), "synthetic")
	if err != nil {
		return 1
	}
	defer rows.Close()
	seen := make(map[int64]bool)
	for rows.Next() {
		var id int64
		var value any
		if err = rows.Scan(&id, &value); err != nil || id < 1 || id > 10 || seen[id] {
			return 2
		}
		seen[id] = true
		switch id {
		case 1:
			if v, ok := value.(int64); !ok || v != math.MaxInt64 {
				return 3
			}
		case 2:
			if v, ok := value.(int64); !ok || v != math.MinInt64 {
				return 4
			}
		case 3:
			if v, ok := value.(string); !ok || v != "9223372036854775807" {
				return 5
			}
		case 4:
			if v, ok := value.([]byte); !ok || !bytes.Equal(v, []byte{0, 255}) {
				return 6
			}
		case 5:
			if v, ok := value.(float64); !ok || v != 3.5 {
				return 7
			}
		case 6:
			if value != nil {
				return 8
			}
		case 7:
			if v, ok := value.([]byte); !ok || v == nil || len(v) != 0 {
				return 9
			}
		case 8:
			if v, ok := value.(string); !ok || v != "" {
				return 10
			}
		case 9:
			if v, ok := value.(float64); !ok || !math.IsInf(v, 1) {
				return 11
			}
		case 10:
			v, ok := value.([]byte)
			if !ok || len(v) != 8388530 {
				return 12
			}
			expected := make([]byte, len(v))
			copy(expected, []byte{255, 0, 0, 0, 0, 0, 0, 0, 0})
			copy(expected[9:], "@MaPiRun1")
			for i := 0; i < 65; i++ {
				expected[18+(len(expected)-18-64)*(i+1)/66] = byte(i + 1)
			}
			if !bytes.Equal(v, expected) {
				return 13
			}
		}
		if flags&4 != 0 {
			if rows.Close() != nil {
				return 15
			}
			return 0
		}
	}
	if rows.Err() != nil || uint64(len(seen)) != expectedRows || (flags&1 != 0 && seen[2]) {
		return 14
	}
	return 0
}
func main() {}
