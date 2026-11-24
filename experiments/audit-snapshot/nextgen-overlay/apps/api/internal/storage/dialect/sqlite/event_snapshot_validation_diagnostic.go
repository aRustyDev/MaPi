package sqlite

// This is an unmounted diagnostic, not an authorization or snapshot API.
// It validates SQL scan destinations without returning full text/blob values.
// It does not claim workerd driver parity or preserve complete error messages.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
)

var snapshotScanColumns = []struct {
	name              string
	nullable, integer bool
}{
	{"project_id", false, false}, {"id", false, false}, {"event_type", false, false}, {"category", false, false},
	{"occurred_at", false, true}, {"created_at", false, true},
	{"team_id", true, false}, {"actor_id", true, false}, {"actor_type", true, false}, {"entity_type", true, false}, {"entity_id", true, false}, {"user_id", true, false},
	{"client_id", false, false}, {"token_id", false, false}, {"delegation_type", false, false}, {"delegation_id", false, false}, {"grantor", false, false}, {"fingerprint", false, false},
	{"request_id", true, false}, {"session_id", true, false}, {"flow_id", true, false}, {"operation_status", true, false}, {"status_class", true, false},
	{"payload", false, false}, {"metadata", false, false},
}

type snapshotScanFailure struct {
	column       int
	name, reason string
}

func (e *snapshotScanFailure) Error() string {
	return fmt.Sprintf("diagnostic event scan column %d %s: %s", e.column, e.name, e.reason)
}

// Caller must hold a transaction that keeps the row stable for every query.
// Only first-failure column/reason are returned; exact raw errors are not yet
// reproduced. The source must independently enforce the route/auth fence.
func (e eventStatements) diagnosticValidateEventRow(ctx context.Context, rowid int64) error {
	for i, col := range snapshotScanColumns {
		// Column names are fixed constants above, never caller-supplied SQL.
		q := fmt.Sprintf("SELECT typeof(%s), CASE WHEN typeof(%s) IN ('integer','real') THEN %s END, CASE WHEN typeof(%s) IN ('text','blob') THEN length(CAST(%s AS BLOB)) ELSE 0 END FROM events WHERE rowid=?", col.name, col.name, col.name, col.name, col.name)
		var kind string
		var scalar any
		var length int64
		if err := e.client.QueryRow(ctx, q, rowid).Scan(&kind, &scalar, &length); err != nil {
			return err
		}
		failure := func(reason string) error { return &snapshotScanFailure{column: i, name: col.name, reason: reason} }
		if kind == "null" {
			if col.nullable {
				continue
			}
			return failure("null")
		}
		if !col.integer {
			if kind != "text" && kind != "blob" && kind != "integer" && kind != "real" {
				return failure("unsupported type")
			}
			continue
		}
		switch kind {
		case "integer":
			if _, ok := scalar.(int64); !ok {
				return failure("unexpected integer representation")
			}
		case "real":
			f, ok := scalar.(float64)
			if !ok {
				return failure("unexpected real representation")
			}
			if _, err := strconv.ParseInt(strconv.FormatFloat(f, 'g', -1, 64), 10, 64); err != nil {
				return failure("integer conversion")
			}
		case "text", "blob":
			reader := &snapshotFieldReader{ctx: ctx, client: e.client, rowid: rowid, name: col.name, length: length}
			if err := parseSnapshotInt64(reader); err != nil {
				if errors.Is(err, strconv.ErrSyntax) || errors.Is(err, strconv.ErrRange) {
					return failure("integer conversion")
				}
				return err
			}
		default:
			return failure("unsupported type")
		}
	}
	return nil
}

// snapshotFieldReader transfers no more than 64 KiB in one SQL result. SQL is
// scoped to a fixed identifier and rowid, and offsets are in bytes.
type snapshotFieldReader struct {
	ctx            context.Context
	client         queryExecutor
	rowid          int64
	name           string
	offset, length int64
	data           []byte
	pos            int
}

func (r *snapshotFieldReader) ReadByte() (byte, error) {
	if r.pos == len(r.data) {
		if r.offset >= r.length {
			return 0, io.EOF
		}
		q := fmt.Sprintf("SELECT substr(CAST(%s AS BLOB), ?, ?) FROM events WHERE rowid=?", r.name)
		var p []byte
		if err := r.client.QueryRow(r.ctx, q, r.offset+1, 65536, r.rowid).Scan(&p); err != nil {
			return 0, err
		}
		if len(p) == 0 || int64(len(p)) > r.length-r.offset {
			return 0, fmt.Errorf("invalid fragment length")
		}
		r.offset += int64(len(p))
		r.data = p
		r.pos = 0
	}
	b := r.data[r.pos]
	r.pos++
	return b, nil
}

// parseSnapshotInt64 follows strconv.ParseInt base-10 magnitude handling with
// bounded input; it never stores the source value or reproduces its error text.
func parseSnapshotInt64(r interface{ ReadByte() (byte, error) }) error {
	first, err := r.ReadByte()
	if err != nil {
		if err == io.EOF {
			return strconv.ErrSyntax
		}
		return err
	}
	negative := false
	if first == '+' || first == '-' {
		negative = first == '-'
		first, err = r.ReadByte()
		if err != nil {
			if err == io.EOF {
				return strconv.ErrSyntax
			}
			return err
		}
	}
	var n uint64
	digit := first
	for {
		if digit < '0' || digit > '9' {
			return strconv.ErrSyntax
		}
		d := uint64(digit - '0')
		if n > math.MaxUint64/10 || n == math.MaxUint64/10 && d > math.MaxUint64%10 {
			return strconv.ErrRange
		}
		n = n*10 + d
		digit, err = r.ReadByte()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	if !negative && n >= 1<<63 || negative && n > 1<<63 {
		return strconv.ErrRange
	}
	return nil
}
