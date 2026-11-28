// Package typedrows is an unmounted feasibility prototype. It consumes
// already authenticated, ordered typed frames; it does not obtain SQLite
// types, make snapshots, provide spill storage, or integrate with the app.
package typedrows

import (
	"database/sql/driver"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
)

type Kind uint8

const (
	Null Kind = iota
	Integer
	Real
	Text
	Blob
)

// Each frame belongs to one cell in a sealed snapshot. Row and Column are
// zero-based; Offset and Total count bytes in the typed cell, not JSON bytes.
// Integer and Real use exactly eight big-endian bytes. Text is the original
// byte sequence; any invalid-UTF-8 application policy belongs to the caller.
type Frame struct {
	Row, Column, Offset, Total uint64
	Kind                       Kind
	Final                      bool
	Data                       []byte
}

// Source must authenticate frame metadata, ordering and a complete terminal
// seal before presenting frames. This prototype does not implement that trust
// boundary. NextFrame may reuse its returned byte slice after the next call.
type Source interface {
	NextFrame() (Frame, error)
	Close() error
}

// Limits bound the consumer allocation; these values are test configuration,
// not a proposed production row limit or proof of SQLite internal memory.
type Limits struct {
	MaxColumns                             int
	MaxMetadata, MaxFrame, MaxCell, MaxRow uint64
}

type Rows struct {
	columns      []string
	source       Source
	limits       Limits
	expectedRows uint64
	row          uint64
	err          error
	ended        bool
	closed       bool
}

var _ driver.Rows = (*Rows)(nil)

// expectedRows must come from an authenticated, complete snapshot seal. This
// reader checks its count, but does not authenticate that seal itself.
func New(columns []string, source Source, expectedRows uint64, limits Limits) (*Rows, error) {
	if len(columns) == 0 || source == nil || limits.MaxColumns < 1 || len(columns) > limits.MaxColumns || limits.MaxMetadata == 0 || limits.MaxFrame == 0 || limits.MaxCell == 0 || limits.MaxRow == 0 || limits.MaxCell > limits.MaxRow {
		return nil, errors.New("invalid typed result configuration")
	}
	var metadata uint64
	for _, column := range columns {
		if uint64(len(column)) > limits.MaxMetadata-metadata {
			return nil, errors.New("typed result metadata exceeds limit")
		}
		metadata += uint64(len(column))
	}
	return &Rows{columns: append([]string(nil), columns...), source: source, expectedRows: expectedRows, limits: limits}, nil
}

func (r *Rows) Columns() []string { return append([]string(nil), r.columns...) }

func (r *Rows) Close() error {
	if r.closed {
		return nil
	}
	r.closed = true
	return r.source.Close()
}

func (r *Rows) fail(message string) error {
	r.err = errors.New(message)
	return r.err
}

func (r *Rows) Next(dest []driver.Value) error {
	if r.err != nil {
		return r.err
	}
	if r.closed || r.ended {
		return io.EOF
	}
	if len(dest) != len(r.columns) {
		return r.fail("typed result destination width mismatch")
	}
	if r.row == r.expectedRows {
		_, err := r.source.NextFrame()
		if errors.Is(err, io.EOF) {
			r.ended = true
			return io.EOF
		}
		if err == nil {
			return r.fail("typed result exceeds sealed row count")
		}
		r.err = fmt.Errorf("typed result source: %w", err)
		return r.err
	}
	row := make([]driver.Value, len(r.columns))
	var rowBytes uint64
	for col := range row {
		first, err := r.source.NextFrame()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return r.fail("truncated typed result row")
			}
			r.err = fmt.Errorf("typed result source: %w", err)
			return r.err
		}
		if first.Row != r.row || first.Column != uint64(col) || first.Offset != 0 {
			return r.fail("typed result frame position mismatch")
		}
		if first.Kind > Blob || first.Total > r.limits.MaxCell || first.Total > r.limits.MaxRow-rowBytes || first.Total > uint64(^uint(0)>>1) {
			return r.fail("invalid typed result kind or size")
		}
		if (first.Kind == Null && first.Total != 0) || ((first.Kind == Integer || first.Kind == Real) && first.Total != 8) {
			return r.fail("invalid typed result scalar size")
		}
		rowBytes += first.Total
		value := make([]byte, int(first.Total))
		frame := first
		var offset uint64
		for {
			if frame.Row != r.row || frame.Column != uint64(col) || frame.Kind != first.Kind || frame.Total != first.Total || frame.Offset != offset {
				return r.fail("typed result frame metadata mismatch")
			}
			size := uint64(len(frame.Data))
			if size > r.limits.MaxFrame || size > first.Total-offset || (size == 0 && !frame.Final) || frame.Final != (offset+size == first.Total) {
				return r.fail("invalid typed result frame length")
			}
			copy(value[int(offset):], frame.Data)
			offset += size
			if frame.Final {
				break
			}
			frame, err = r.source.NextFrame()
			if err != nil {
				if errors.Is(err, io.EOF) {
					return r.fail("truncated typed result cell")
				}
				r.err = fmt.Errorf("typed result source: %w", err)
				return r.err
			}
		}
		switch first.Kind {
		case Null:
			row[col] = nil
		case Integer:
			row[col] = int64(binary.BigEndian.Uint64(value))
		case Real:
			n := math.Float64frombits(binary.BigEndian.Uint64(value))
			if math.IsNaN(n) {
				return r.fail("invalid SQLite REAL NaN")
			}
			row[col] = n
		case Text:
			row[col] = string(value)
		case Blob:
			row[col] = value
		}
	}
	if r.row == math.MaxUint64 {
		return r.fail("typed result row overflow")
	}
	copy(dest, row)
	r.row++
	return nil
}
