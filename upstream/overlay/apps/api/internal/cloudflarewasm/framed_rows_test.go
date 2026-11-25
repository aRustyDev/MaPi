package cloudflarewasm

import (
	"database/sql/driver"
	"io"
	"testing"
)

func TestFramedRowsRejectIncompleteSnapshot(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		rows uint64
	}{
		{"invalid tag", []byte{0, 255}, 1},
		{"truncated BLOB", []byte{0, 4, 3, 0, 0, 0, 1}, 1},
		{"unterminated text", []byte{0, 3, 1, 0, 'a'}, 1},
		{"invalid UTF-8", []byte{0, 3, 1, 0, 255, 0, 0}, 1},
		{"missing sealed row", []byte{0, 0}, 2},
		{"trailing data", []byte{0, 0, 0}, 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			snapshot := new(frameSnapshot)
			// Deliberately split the stream at byte boundaries.
			for _, value := range test.data {
				snapshot.append([]byte{value})
			}
			rows := &framedRows{columns: []string{"a", "b"}, data: snapshot, remainingRows: test.rows}
			dest := []driver.Value{"a", "b"}
			err := rows.Next(dest)
			if err == nil || dest[0] != "a" || dest[1] != "b" || rows.data != nil {
				t.Fatalf("malformed row leaked values or retained data: err=%v dest=%v", err, dest)
			}
			if later := rows.Next(dest); later != err {
				t.Fatalf("later Next returned %v, want %v", later, err)
			}
		})
	}
}

func TestFramedRowsCloseDropsUnreadSnapshot(t *testing.T) {
	snapshot := new(frameSnapshot)
	snapshot.append([]byte{0, 0})
	rows := &framedRows{columns: []string{"value"}, data: snapshot, remainingRows: 2}
	if err := rows.Next(make([]driver.Value, 1)); err != nil {
		t.Fatal(err)
	}
	if err := rows.Close(); err != nil || rows.data != nil {
		t.Fatalf("Close retained the unread result: %v", err)
	}
	if err := rows.Next(make([]driver.Value, 1)); err != io.EOF {
		t.Fatalf("Next after Close returned %v", err)
	}
}
