package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"unsafe"
)

//go:wasmimport mapi sql
func hostSQL(ptr unsafe.Pointer, n uint32) uint32

//go:wasmimport mapi result
func hostResult(ptr unsafe.Pointer, n uint32)
func call(v any) map[string]any {
	b, _ := json.Marshal(v)
	n := hostSQL(unsafe.Pointer(&b[0]), uint32(len(b)))
	out := make([]byte, n)
	hostResult(unsafe.Pointer(&out[0]), n)
	var res map[string]any
	if json.Unmarshal(out, &res) != nil {
		panic("invalid frame")
	}
	return res
}
func next(id string) map[string]any { return call(map[string]any{"op": "next", "id": id}) }

type connector struct{}
type connection struct{}
type resultRows struct {
	id      string
	columns []string
	ended   bool
}

func (connector) Connect(context.Context) (driver.Conn, error) { return connection{}, nil }
func (connector) Driver() driver.Driver                        { return connection{} }
func (connection) Open(string) (driver.Conn, error)            { return connection{}, nil }
func (connection) Prepare(string) (driver.Stmt, error)         { return nil, errors.ErrUnsupported }
func (connection) Close() error                                { return nil }
func (connection) Begin() (driver.Tx, error)                   { return nil, errors.ErrUnsupported }
func (connection) QueryContext(_ context.Context, _ string, _ []driver.NamedValue) (driver.Rows, error) {
	id := call(map[string]any{"op": "open", "query": "vertical"})["id"].(string)
	cols := make([]string, 100)
	for i := range cols {
		cols[i] = fmt.Sprintf("column_%d", i)
	}
	return &resultRows{id: id, columns: cols}, nil
}
func (r *resultRows) Columns() []string { return r.columns }
func (r *resultRows) Close() error {
	if !r.ended {
		call(map[string]any{"op": "close", "id": r.id})
		r.ended = true
	}
	return nil
}
func (r *resultRows) Next(dest []driver.Value) error {
	if r.ended {
		return io.EOF
	}
	for slot := range dest {
		data := make([]byte, 0)
		var typ string
		for {
			f := next(r.id)
			if f["done"] == true {
				r.ended = true
				if slot == 0 {
					return io.EOF
				}
				return errors.New("truncated row")
			}
			if int(f["slot"].(float64)) != slot {
				return errors.New("bad slot")
			}
			typ = f["type"].(string)
			switch typ {
			case "text", "blob":
				bytes, e := base64.StdEncoding.DecodeString(f["data"].(string))
				if e != nil || int(f["offset"].(float64)) != len(data) {
					return errors.New("bad fragment")
				}
				data = append(data, bytes...)
			case "integer":
				n, e := strconv.ParseInt(f["value"].(string), 10, 64)
				if e != nil {
					return e
				}
				dest[slot] = n
			case "real":
				dest[slot] = f["value"].(float64)
			case "null":
				dest[slot] = nil
			default:
				return errors.New("unexpected type")
			}
			if f["end"] == true {
				break
			}
		}
		if typ == "text" {
			dest[slot] = string(data)
		} else if typ == "blob" {
			dest[slot] = data
		}
	}
	return nil
}

//go:wasmexport mapi_stream_test
func streamTest(mode uint32) uint32 {
	if mode == 3 {
		db := sql.OpenDB(connector{})
		defer db.Close()
		rows, e := db.Query("prototype")
		if e != nil {
			return 31
		}
		defer rows.Close()
		if !rows.Next() {
			return 32
		}
		vals := make([]any, 100)
		dest := make([]any, 100)
		for i := range vals {
			dest[i] = &vals[i]
		}
		if rows.Scan(dest...) != nil {
			return 33
		}
		text, ok := vals[0].(string)
		if !ok || len(text) != 8388608 {
			return 34
		}
		if vals[1] != int64(9223372036854775807) {
			return 35
		}
		blob, ok := vals[2].([]byte)
		if !ok || len(blob) != 2 || blob[1] != 255 {
			return 36
		}
		empty, ok := vals[4].([]byte)
		if vals[3] != "" || !ok || empty == nil || len(empty) != 0 {
			return 40
		}
		if vals[5] != "a\x00😀" || vals[6] != 1.25 || vals[7] != int64(-9223372036854775808) {
			return 41
		}
		if rows.Next() || rows.Err() != nil {
			return 37
		}
		early, e := db.Query("prototype")
		if e != nil {
			return 38
		}
		if early.Close() != nil {
			return 39
		}
		return 0
	}
	if mode == 2 {
		id := call(map[string]any{"op": "open", "query": "vertical"})["id"].(string)
		slot := 0
		total := 0
		for {
			f := next(id)
			if f["done"] == true {
				break
			}
			if int(f["slot"].(float64)) != slot {
				return 11
			}
			typ := f["type"].(string)
			if slot == 0 {
				if typ != "text" {
					return 12
				}
				data, e := base64.StdEncoding.DecodeString(f["data"].(string))
				if e != nil || int(f["offset"].(float64)) != total {
					return 13
				}
				for _, v := range data {
					if v != 0 {
						return 14
					}
				}
				total += len(data)
			}
			if slot == 1 && (typ != "integer" || f["value"] != "9223372036854775807") {
				return 15
			}
			if slot == 2 {
				data, e := base64.StdEncoding.DecodeString(f["data"].(string))
				if typ != "blob" || e != nil || len(data) != 2 || data[0] != 0 || data[1] != 255 {
					return 16
				}
			}
			if f["end"] == true {
				slot++
			}
		}
		if slot != 100 || total != 8388608 {
			return 17
		}
		return 0
	}
	if mode == 1 {
		id := call(map[string]any{"op": "open", "query": "returning"})["id"].(string)
		next(id)
		return 1
	}
	id := call(map[string]any{"op": "open", "query": "blob"})["id"].(string)
	total := 0
	for {
		f := next(id)
		if f["done"] == true {
			break
		}
		data, e := base64.StdEncoding.DecodeString(f["data"].(string))
		if e != nil || int(f["offset"].(float64)) != total {
			return 2
		}
		for _, v := range data {
			if v != 0 {
				return 3
			}
		}
		total += len(data)
	}
	if total != 8000000 {
		return 4
	}
	id = call(map[string]any{"op": "open", "query": "returning"})["id"].(string)
	count, sum := 0, 0
	for {
		f := next(id)
		if f["done"] == true {
			break
		}
		count++
		sum += int(f["value"].(float64))
	}
	if count != 10000 || sum != 50015000 {
		return 5
	}
	return 0
}
func main() {}
