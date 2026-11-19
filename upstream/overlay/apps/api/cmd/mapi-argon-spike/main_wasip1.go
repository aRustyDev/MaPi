//go:build wasip1

// This reactor is an isolated capacity spike; it is not an authentication API.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"runtime/debug"
	"unsafe"

	"github.com/zitadel/nextgen/internal/crypto"
	"github.com/zitadel/nextgen/internal/domain"
)

var input, output []byte
var hasher *crypto.PasswapHasher

//go:wasmexport mapi_alloc
func alloc(size uint32) uint32 {
	input = make([]byte, size)
	return uint32(uintptr(unsafe.Pointer(unsafe.SliceData(input))))
}

//go:wasmexport mapi_release
func release() { clear(input); clear(output); input = nil; output = nil }
func result(v any) uint64 {
	output, _ = json.Marshal(v)
	return uint64(uint32(uintptr(unsafe.Pointer(unsafe.SliceData(output)))))<<32 | uint64(len(output))
}

//go:wasmexport mapi_init
func initHasher() uint64 {
	debug.SetMemoryLimit(90 << 20)
	config := crypto.HashConfig{Hasher: crypto.HasherConfig{Algorithm: crypto.HashNameArgon2id, Params: map[string]any{"Time": 3, "Memory": 64 * 1024, "Threads": 4}}, Verifiers: []crypto.HashName{crypto.HashNameArgon2}, Limits: crypto.HashLimitsConfig{Argon2: crypto.Argon2LimitsConfig{MinTime: 1, MaxTime: 10, MinMemory: 8 * 1024, MaxMemory: 512 * 1024, MinThreads: 1, MaxThreads: 16}}, Concurrency: crypto.HashConcurrencyConfig{MaxOperations: 1, MemoryBudget: 64 << 20}}
	factory, err := config.NewHasherFactory()
	if err != nil {
		return result(map[string]any{"error": "init"})
	}
	hasher = factory.Default()
	return result(map[string]any{"ok": true})
}

//go:wasmexport mapi_hash
func hash() uint64 {
	var data struct {
		Password string `json:"password"`
	}
	if json.Unmarshal(input, &data) != nil || hasher == nil {
		return result(map[string]any{"error": "input"})
	}
	hash, err := hasher.Hash(context.Background(), domain.NormalizePassword(data.Password))
	runtime.GC()
	if err != nil {
		return result(map[string]any{"error": "hash"})
	}
	return result(map[string]any{"hash": hash})
}

//go:wasmexport mapi_verify
func verify() uint64 {
	var data struct {
		Password string `json:"password"`
		Hash     string `json:"hash"`
	}
	if json.Unmarshal(input, &data) != nil || hasher == nil {
		return result(map[string]any{"error": "input"})
	}
	password := domain.UserPassword{EncodedHash: data.Hash}
	updated, err := password.Verify(context.Background(), data.Password, hasher)
	runtime.GC()
	return result(map[string]any{"verified": err == nil || errors.Is(err, crypto.ErrRehashFailed), "rehash": updated})
}
func main() {}
