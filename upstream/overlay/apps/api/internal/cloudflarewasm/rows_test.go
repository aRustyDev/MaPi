package cloudflarewasm

import (
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestRowsRejectMalformedHostResponses(t *testing.T) {
	cases := []struct {
		name    string
		columns []string
		row     []json.RawMessage
		dest    []driver.Value
	}{
		{"short row", []string{"a", "b"}, []json.RawMessage{[]byte(`1`)}, []driver.Value{"unchanged", "unchanged"}},
		{"long row", []string{"a"}, []json.RawMessage{[]byte(`1`), []byte(`2`)}, []driver.Value{"unchanged"}},
		{"short destination", []string{"a", "b"}, []json.RawMessage{[]byte(`1`), []byte(`2`)}, []driver.Value{"unchanged"}},
		{"empty cell", []string{"a"}, []json.RawMessage{nil}, []driver.Value{"unchanged"}},
		{"malformed JSON", []string{"a"}, []json.RawMessage{[]byte(`"synthetic-secret`)}, []driver.Value{"unchanged"}},
		{"invalid integer", []string{"a"}, []json.RawMessage{[]byte(`{"integer":"synthetic-secret"}`)}, []driver.Value{"unchanged"}},
		{"invalid blob", []string{"a"}, []json.RawMessage{[]byte(`{"blob":"synthetic-secret"}`)}, []driver.Value{"unchanged"}},
		{"late overflow", []string{"a", "b"}, []json.RawMessage{[]byte(`1`), []byte(`{"integer":"9223372036854775808"}`)}, []driver.Value{"unchanged", "unchanged"}},
		{"late invalid blob", []string{"a", "b"}, []json.RawMessage{[]byte(`1`), []byte(`{"blob":"synthetic-secret"}`)}, []driver.Value{"unchanged", "unchanged"}},
		{"empty object", []string{"a"}, []json.RawMessage{[]byte(`{}`)}, []driver.Value{"unchanged"}},
		{"unknown tag", []string{"a"}, []json.RawMessage{[]byte(`{"other":"x"}`)}, []driver.Value{"unchanged"}},
		{"both tags", []string{"a"}, []json.RawMessage{[]byte(`{"blob":"YQ==","integer":"1"}`)}, []driver.Value{"unchanged"}},
		{"duplicate tag", []string{"a"}, []json.RawMessage{[]byte(`{"integer":"1","integer":"2"}`)}, []driver.Value{"unchanged"}},
		{"empty integer", []string{"a"}, []json.RawMessage{[]byte(`{"integer":""}`)}, []driver.Value{"unchanged"}},
		{"null blob", []string{"a"}, []json.RawMessage{[]byte(`{"blob":null}`)}, []driver.Value{"unchanged"}},
		{"array", []string{"a"}, []json.RawMessage{[]byte(`[]`)}, []driver.Value{"unchanged"}},
		{"boolean", []string{"a"}, []json.RawMessage{[]byte(`true`)}, []driver.Value{"unchanged"}},
		{"noncanonical base64", []string{"a"}, []json.RawMessage{[]byte(`{"blob":"YR=="}`)}, []driver.Value{"unchanged"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &rows{columns: tc.columns, data: [][]json.RawMessage{tc.row}}
			before := append([]driver.Value(nil), tc.dest...)
			err := r.Next(tc.dest)
			if err == nil || strings.Contains(err.Error(), "synthetic-secret") {
				t.Fatalf("expected sanitized error, got %v", err)
			}
			if !reflect.DeepEqual(tc.dest, before) {
				t.Fatal("malformed row changed destination")
			}
			if again := r.Next(tc.dest); again != err {
				t.Fatalf("malformed row did not retain failure: %v", again)
			}
		})
	}
}

func TestRowsDecodeValidHostValues(t *testing.T) {
	r := &rows{columns: []string{"null", "empty", "integer", "blob", "real", "bytes"}, data: [][]json.RawMessage{{
		[]byte(`null`), []byte(`""`), []byte(` {"integer":"9007199254740993"} `), []byte(`{"blob":""}`), []byte(`1.25`), []byte(`{"blob":"YQ=="}`),
	}}}
	dest := make([]driver.Value, len(r.columns))
	if err := r.Next(dest); err != nil {
		t.Fatal(err)
	}
	if dest[0] != nil || dest[1] != "" || dest[2] != int64(9007199254740993) || dest[4] != 1.25 {
		t.Fatalf("unexpected decoded scalar values: %#v", dest)
	}
	if blob, ok := dest[3].([]byte); !ok || blob == nil || len(blob) != 0 {
		t.Fatalf("empty blob lost its type: %#v", dest[3])
	}
	if blob, ok := dest[5].([]byte); !ok || !reflect.DeepEqual(blob, []byte("a")) {
		t.Fatalf("unexpected decoded blob: %#v", dest[5])
	}
	if err := r.Next(dest); !errors.Is(err, io.EOF) {
		t.Fatalf("expected EOF, got %v", err)
	}
}

func TestRowsDecodeCanonicalBlobLengths(t *testing.T) {
	for _, blob := range [][]byte{{}, {0}, {0, 255}, {0, 127, 255}, {255, 1, 2, 3}} {
		encoded := base64.StdEncoding.EncodeToString(blob)
		r := &rows{columns: []string{"blob"}, data: [][]json.RawMessage{{json.RawMessage(`{"blob":"` + encoded + `"}`)}}}
		dest := make([]driver.Value, 1)
		if err := r.Next(dest); err != nil {
			t.Fatal(err)
		}
		if got, ok := dest[0].([]byte); !ok || !reflect.DeepEqual(got, blob) {
			t.Fatalf("blob mismatch for %d bytes", len(blob))
		}
	}
}

func TestRowsReleaseHostResponseOnAdvanceAndClose(t *testing.T) {
	response := [][]json.RawMessage{
		{json.RawMessage(`{"blob":"AAH/"}`)},
		{json.RawMessage(`"unread"`)},
	}
	r := &rows{columns: []string{"value"}, data: response}
	dest := make([]driver.Value, 1)
	if err := r.Next(dest); err != nil {
		t.Fatal(err)
	}
	if response[0] != nil {
		t.Fatal("consumed raw row is retained by the response backing array")
	}
	if response[1] == nil {
		t.Fatal("unread row was released before close")
	}
	blob, ok := dest[0].([]byte)
	if !ok || !reflect.DeepEqual(blob, []byte{0, 1, 255}) {
		t.Fatalf("decoded blob changed: %#v", dest[0])
	}
	if err := r.Close(); err != nil || r.data != nil {
		t.Fatalf("close did not release unread response: %v", err)
	}
	if err := r.Close(); err != nil {
		t.Fatalf("repeated close: %v", err)
	}
	if !reflect.DeepEqual(blob, []byte{0, 1, 255}) {
		t.Fatal("closing rows changed an already returned blob")
	}
	if err := r.Next(dest); !errors.Is(err, io.EOF) {
		t.Fatalf("closed rows returned unread data: %v", err)
	}
}
