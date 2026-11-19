//go:build wasip1 && mapi_enumeration_test

package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"runtime"

	"github.com/zitadel/nextgen/internal/crypto"
	"github.com/zitadel/nextgen/internal/domain"
)

var dummyPasswordHash string

//go:wasmexport mapi_enumeration_dummy_init
func enumerationDummyInit() uint64 {
	if hasher == nil {
		return failure(errors.New("hasher not configured"))
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return failure(err)
	}
	var err error
	dummyPasswordHash, err = hasher.Hash(context.Background(), base64.RawURLEncoding.EncodeToString(secret[:]))
	clear(secret[:])
	runtime.GC()
	if err != nil {
		return failure(err)
	}
	return marshal(true)
}

//go:wasmexport mapi_enumeration_dummy_verify
func enumerationDummyVerify() uint64 {
	var req struct {
		Password string `json:"password"`
	}
	if err := json.Unmarshal(input, &req); err != nil {
		return failure(err)
	}
	if dummyPasswordHash == "" || hasher == nil {
		return failure(errors.New("dummy verifier not configured"))
	}
	// UserPassword.Verify applies upstream NFC normalization and error semantics.
	user := domain.UserPassword{EncodedHash: dummyPasswordHash}
	_, err := user.Verify(context.Background(), req.Password, hasher)
	runtime.GC()
	if err != nil && !errors.Is(err, domain.ErrUserPasswordInvalid()) && !errors.Is(err, crypto.ErrRehashFailed) {
		return failure(errors.New("dummy verification unavailable"))
	}
	return marshal(true)
}
