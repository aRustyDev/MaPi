package cloudflarewasm

import (
	"bytes"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
)

// rows owns a materialized response from the synchronous host bridge. The
// host normally produces every cell itself, but a malformed response must not
// panic or hand database/sql a partially shaped row.
type rows struct {
	columns []string
	data    [][]json.RawMessage
	err     error
}

func base64Digit(b byte) int {
	switch {
	case b >= 'A' && b <= 'Z':
		return int(b - 'A')
	case b >= 'a' && b <= 'z':
		return int(b-'a') + 26
	case b >= '0' && b <= '9':
		return int(b-'0') + 52
	case b == '+':
		return 62
	case b == '/':
		return 63
	default:
		return -1
	}
}

// The host emits tagged objects with one integer or blob field. Inspect the
// already-validated JSON bytes before allocating the decoded value; malformed
// tags and invalid base64 must not trigger an allocation proportional to an
// untrusted payload. The output of JSON.stringify contains no escaped
// characters in these field names or in decimal/base64 values.
func decodeTagged(value []byte) (driver.Value, error) {
	inside := bytes.TrimSpace(value[1 : len(value)-1])
	name, raw, found := bytes.Cut(inside, []byte(":"))
	name, raw = bytes.TrimSpace(name), bytes.TrimSpace(raw)
	if !found || len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		return nil, errors.New("invalid tagged value")
	}
	data := raw[1 : len(raw)-1]
	switch {
	case bytes.Equal(name, []byte(`"integer"`)):
		if len(data) == 0 || len(data) > 20 {
			return nil, errors.New("invalid tagged integer")
		}
		return strconv.ParseInt(string(data), 10, 64)
	case bytes.Equal(name, []byte(`"blob"`)):
		if len(data)%4 != 0 {
			return nil, errors.New("invalid tagged blob")
		}
		// Validate characters, padding and unused tail bits in one pass before
		// allocating. Host-produced base64 is canonical and never contains
		// whitespace or padding in the middle.
		padding := 0
		for i, b := range data {
			if b == '=' {
				if i < len(data)-2 || padding == 2 {
					return nil, errors.New("invalid tagged blob")
				}
				padding++
			} else if base64Digit(b) < 0 || padding != 0 {
				return nil, errors.New("invalid tagged blob")
			}
		}
		if (padding == 1 && base64Digit(data[len(data)-2])&3 != 0) ||
			(padding == 2 && base64Digit(data[len(data)-3])&15 != 0) {
			return nil, errors.New("invalid tagged blob")
		}
		size := base64.StdEncoding.DecodedLen(len(data)) - padding
		decoded := make([]byte, size)
		if _, err := base64.StdEncoding.Strict().Decode(decoded, data); err != nil {
			return nil, errors.New("invalid tagged blob")
		}
		return decoded, nil
	default:
		return nil, errors.New("invalid tagged value")
	}
}

func (r *rows) Columns() []string { return r.columns }
func (r *rows) Close() error {
	// database/sql can retain the driver.Rows after Close. Drop unread host
	// JSON immediately instead of retaining the materialized response until
	// the sql.Rows itself is collected.
	r.data = nil
	return nil
}
func (r *rows) Next(dest []driver.Value) error {
	if r.err != nil {
		return r.err
	}
	if len(r.data) == 0 {
		return io.EOF
	}
	row := r.data[0]
	if len(row) != len(r.columns) || len(dest) != len(r.columns) {
		r.err = errors.New("invalid SQLite response row width")
		return r.err
	}
	// Validate all JSON before decoding any value or changing a destination.
	// json.Valid scans the existing RawMessage without copying its contents.
	for i, value := range row {
		if len(value) == 0 || !json.Valid(value) {
			r.err = fmt.Errorf("invalid SQLite response value at column %d", i)
			return r.err
		}
	}
	// Decode separately and publish only a complete row. A later type or
	// integer conversion error must not leave earlier destination cells changed.
	decodedRow := make([]driver.Value, len(row))
	for i, value := range row {
		value = bytes.TrimSpace(value)
		if value[0] == '{' {
			decoded, err := decodeTagged(value)
			if err != nil {
				r.err = fmt.Errorf("invalid SQLite response value at column %d", i)
				return r.err
			}
			decodedRow[i] = decoded
			continue
		}
		if value[0] == '[' || value[0] == 't' || value[0] == 'f' {
			r.err = fmt.Errorf("invalid SQLite response value at column %d", i)
			return r.err
		}
		var decoded any
		if err := json.Unmarshal(value, &decoded); err != nil {
			r.err = fmt.Errorf("invalid SQLite response value at column %d", i)
			return r.err
		}
		decodedRow[i] = decoded
	}
	copy(dest, decodedRow)
	// Reslicing alone leaves the consumed row reachable through the backing
	// array while later rows are still being scanned.
	r.data[0] = nil
	r.data = r.data[1:]
	return nil
}
