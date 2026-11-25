package cloudflarewasm

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"unsafe"
)

//go:wasmimport mapi sql
func hostSQL(ptr unsafe.Pointer, size uint32) uint32

//go:wasmimport mapi result
func hostResult(ptr unsafe.Pointer, size uint32)

//go:wasmimport mapi transaction
func hostTransaction() uint32

var callback func() error
var callbackError error

//go:wasmexport mapi_transaction_body
func transactionBody() (status uint32) {
	defer func() {
		if recovered := recover(); recovered != nil {
			callbackError = fmt.Errorf("panic in SQLite transaction: %v", recovered)
			status = 1
		}
	}()
	callbackError = callback()
	if callbackError != nil {
		return 1
	}
	return 0
}

// Transaction lets Go's existing transaction callback decide when to commit.
// The JS host owns the SQLite transaction and invokes the callback on the
// same stack. A nested statement runs on the already-open transaction.
func Transaction(fn func() error) error {
	if callback != nil {
		return fn()
	}
	callback = fn
	defer func() {
		callback = nil
		callbackError = nil
	}()
	if hostTransaction() > 1 {
		return errors.New("Durable Object SQLite transaction failed")
	}
	return callbackError
}

type frameReceiver struct {
	buffer   *[resultFrameBytes]byte
	snapshot *frameSnapshot
}

var activeReceivers sync.Map
var reusableFrameBuffer = sync.Pool{New: func() any { return new([resultFrameBytes]byte) }}

//go:wasmexport mapi_sql_frame
func receiveSQLFrame(pointer, size uint32) uint32 {
	value, ok := activeReceivers.Load(pointer)
	if !ok || size == 0 || size > resultFrameBytes {
		return 1
	}
	receiver := value.(frameReceiver)
	receiver.snapshot.append(receiver.buffer[:size])
	return 0
}

func callSQL(input sqlRequest, output *sqlResponse) error {
	var snapshot *frameSnapshot
	if input.Query {
		buffer := reusableFrameBuffer.Get().(*[resultFrameBytes]byte)
		snapshot = new(frameSnapshot)
		input.FramePointer = uint32(uintptr(unsafe.Pointer(buffer)))
		activeReceivers.Store(input.FramePointer, frameReceiver{buffer, snapshot})
		defer func() {
			activeReceivers.Delete(input.FramePointer)
			clear(buffer[:])
			reusableFrameBuffer.Put(buffer)
		}()
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return err
	}
	size := hostSQL(unsafe.Pointer(&encoded[0]), uint32(len(encoded)))
	if size == 0 {
		return errors.New("missing SQLite response")
	}
	result := make([]byte, size)
	hostResult(unsafe.Pointer(&result[0]), size)
	if err := json.Unmarshal(result, output); err != nil {
		return err
	}
	if output.FrameRows != nil {
		if snapshot == nil || len(output.Rows) != 0 || (*output.FrameRows == 0) != (snapshot.remaining == 0) {
			return errors.New("invalid framed SQLite response")
		}
		output.snapshot = snapshot
	}
	return nil
}
