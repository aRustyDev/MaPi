package cloudflarewasm

import (
	"database/sql/driver"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"unicode/utf8"
)

// Keep in sync with worker/sql-result-frames.js. The transport bounds scratch
// space per callback. The snapshot remains owned by Go across rollback.
const resultFrameBytes = 32 * 1024

type frameSnapshot struct {
	chunks    [][]byte
	offset    int
	remaining uint64
}

func (s *frameSnapshot) append(frame []byte) {
	s.chunks = append(s.chunks, append([]byte(nil), frame...))
	s.remaining += uint64(len(frame))
}

func (s *frameSnapshot) Read(dest []byte) (int, error) {
	if s.remaining == 0 {
		return 0, io.EOF
	}
	var read int
	for read < len(dest) && len(s.chunks) != 0 {
		chunk := s.chunks[0]
		count := copy(dest[read:], chunk[s.offset:])
		read += count
		s.offset += count
		if s.offset == len(chunk) {
			s.chunks[0] = nil
			s.chunks = s.chunks[1:]
			s.offset = 0
		}
	}
	s.remaining -= uint64(read)
	return read, nil
}

type framedRows struct {
	columns       []string
	data          *frameSnapshot
	remainingRows uint64
	err           error
}

var _ driver.Rows = (*framedRows)(nil)

func (r *framedRows) Columns() []string { return r.columns }

func (r *framedRows) Close() error {
	r.data = nil
	return nil
}

func (r *framedRows) Next(dest []driver.Value) error {
	if r.err != nil {
		return r.err
	}
	if r.data == nil || r.remainingRows == 0 {
		return io.EOF
	}
	if len(dest) != len(r.columns) {
		return r.fail(errors.New("invalid framed SQLite response row width"))
	}
	row := make([]driver.Value, len(dest))
	for i := range row {
		value, err := r.data.readValue()
		if err != nil {
			return r.fail(fmt.Errorf("invalid framed SQLite response at column %d: %w", i, err))
		}
		row[i] = value
	}
	r.remainingRows--
	if (r.remainingRows == 0) != (r.data.remaining == 0) {
		return r.fail(errors.New("framed SQLite response does not match its row count"))
	}
	copy(dest, row)
	return nil
}

func (r *framedRows) fail(err error) error {
	r.err = err
	r.Close()
	return err
}

func (s *frameSnapshot) readValue() (driver.Value, error) {
	var buffer [8]byte
	if _, err := io.ReadFull(s, buffer[:1]); err != nil {
		return nil, err
	}
	switch buffer[0] {
	case 0:
		return nil, nil
	case 1, 2:
		tag := buffer[0]
		if _, err := io.ReadFull(s, buffer[:]); err != nil {
			return nil, err
		}
		bits := binary.LittleEndian.Uint64(buffer[:])
		if tag == 1 {
			return int64(bits), nil
		}
		value := math.Float64frombits(bits)
		if math.IsNaN(value) {
			return nil, errors.New("invalid SQLite REAL")
		}
		return value, nil
	case 3:
		return s.readText()
	case 4:
		if _, err := io.ReadFull(s, buffer[:4]); err != nil {
			return nil, err
		}
		length := uint64(binary.LittleEndian.Uint32(buffer[:4]))
		if length > s.remaining || length > uint64(^uint(0)>>1) {
			return nil, io.ErrUnexpectedEOF
		}
		value := make([]byte, int(length))
		_, err := io.ReadFull(s, value)
		return value, err
	default:
		return nil, errors.New("invalid SQLite result type")
	}
}

func (s *frameSnapshot) readText() (string, error) {
	var text strings.Builder
	var header [2]byte
	var bytes []byte
	for {
		if _, err := io.ReadFull(s, header[:]); err != nil {
			return "", err
		}
		count := int(binary.LittleEndian.Uint16(header[:]))
		if count == 0 {
			return text.String(), nil
		}
		if count > resultFrameBytes || uint64(count) > s.remaining {
			return "", errors.New("invalid SQLite text segment length")
		}
		if cap(bytes) < count {
			bytes = make([]byte, count)
		}
		segment := bytes[:count]
		if _, err := io.ReadFull(s, segment); err != nil {
			return "", err
		}
		if !utf8.Valid(segment) {
			return "", errors.New("invalid UTF-8 in SQLite text segment")
		}
		text.Write(segment)
	}
}
