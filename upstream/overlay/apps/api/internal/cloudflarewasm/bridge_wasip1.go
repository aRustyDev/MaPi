package cloudflarewasm

import (
	"encoding/json"
	"errors"
	"fmt"
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

func callSQL(input any, output any) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return err
	}
	size := hostSQL(unsafe.Pointer(&encoded[0]), uint32(len(encoded)))
	result := make([]byte, size)
	hostResult(unsafe.Pointer(&result[0]), size)
	return json.Unmarshal(result, output)
}
