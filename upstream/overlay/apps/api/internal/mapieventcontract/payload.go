// Package mapieventcontract protects local experimental audit reads from
// silently discarding unknown or differently typed historical fields.
package mapieventcontract

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strconv"
	"unicode/utf8"
)

func decode(raw []byte) (any, error) {
	if err := validStrings(raw); err != nil {
		return nil, err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	value, err := decodeValue(d)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errors.New("trailing JSON")
	}
	return value, nil
}

// encoding/json substitutes U+FFFD for invalid UTF-8 and unpaired surrogate
// escapes. Reject both so distinct stored strings cannot compare equal.
func validStrings(raw []byte) error {
	if !utf8.Valid(raw) {
		return errors.New("invalid UTF-8")
	}
	inString := false
	for i := 0; i < len(raw); i++ {
		if !inString {
			if raw[i] == '"' {
				inString = true
			}
			continue
		}
		if raw[i] == '"' {
			inString = false
			continue
		}
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return errors.New("invalid JSON escape")
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return errors.New("invalid Unicode escape")
		}
		value, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return err
		}
		i += 4
		if value >= 0xdc00 && value <= 0xdfff {
			return errors.New("unpaired low surrogate")
		}
		if value < 0xd800 || value > 0xdbff {
			continue
		}
		if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
			return errors.New("unpaired high surrogate")
		}
		low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return errors.New("unpaired high surrogate")
		}
		i += 6
	}
	return nil
}

func decodeValue(d *json.Decoder) (any, error) {
	token, err := d.Token()
	if err != nil {
		return nil, err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return token, nil
	}
	switch delim {
	case '{':
		object := make(map[string]any)
		for d.More() {
			keyToken, err := d.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, errors.New("invalid object key")
			}
			if _, exists := object[key]; exists {
				return nil, errors.New("duplicate object key")
			}
			value, err := decodeValue(d)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		end, err := d.Token()
		if err != nil || end != json.Delim('}') {
			return nil, errors.New("invalid object end")
		}
		return object, nil
	case '[':
		array := make([]any, 0)
		for d.More() {
			value, err := decodeValue(d)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		end, err := d.Token()
		if err != nil || end != json.Delim(']') {
			return nil, errors.New("invalid array end")
		}
		return array, nil
	default:
		return nil, errors.New("invalid JSON delimiter")
	}
}

// ValidatePayload compares the stored payload to a generated full event
// response without converting integers to floating point. Unknown fields or
// null/empty differences must fail closed, never silently alter history.
func ValidatePayload(stored, encoded []byte) error {
	var event struct {
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(encoded, &event); err != nil {
		return errors.New("invalid encoded audit event")
	}
	a, err := decode(stored)
	if err != nil {
		return errors.New("invalid stored audit payload")
	}
	b, err := decode(event.Payload)
	if err != nil {
		return errors.New("invalid encoded audit payload")
	}
	if !reflect.DeepEqual(a, b) {
		return errors.New("MaPi audit payload cannot be represented without loss")
	}
	return nil
}
