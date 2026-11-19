package main

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"runtime/debug"
	"strings"
	"time"
	"unsafe"

	"github.com/zitadel/nextgen/internal/api"
	"github.com/zitadel/nextgen/internal/cache"
	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/crypto"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	"github.com/zitadel/oidc/v3/pkg/op"
)

var input []byte
var output []byte
var handler http.Handler
var hasher *crypto.PasswapHasher
var runtimePool *service.DB
var runtimeKeys service.KeyService
var runtimeTokens service.TokenService
var runtimeHashers *crypto.HasherFactory

type configuration struct {
	KeyID             string          `json:"id"`
	PEM               string          `json:"pem"`
	ProjectID         string          `json:"projectId"`
	SessionDefaultTTL durationSetting `json:"sessionDefaultTTL"`
	SessionMaxTTL     durationSetting `json:"sessionMaxTTL"`
}

// A pointer to string treats JSON null as omitted. Explicit null must fail
// closed even if a future host bypasses the Worker's binding-type checks.
type durationSetting struct {
	Present bool
	Value   string
}

func (s *durationSetting) UnmarshalJSON(value []byte) error {
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return errors.New("invalid session duration configuration")
	}
	if err := json.Unmarshal(value, &s.Value); err != nil {
		return errors.New("invalid session duration configuration")
	}
	s.Present = true
	return nil
}

// sessionConfig keeps the native defaults and validation while allowing the
// Worker deployment to opt in to the native server's duration settings.
func (c configuration) sessionConfig() (service.SessionConfig, error) {
	config := service.SessionConfig{DefaultTTL: domain.SessionDefaultTTL, MaxTTL: 720 * time.Hour}
	for _, value := range []struct {
		setting durationSetting
		target  *time.Duration
	}{{c.SessionDefaultTTL, &config.DefaultTTL}, {c.SessionMaxTTL, &config.MaxTTL}} {
		if !value.setting.Present {
			continue
		}
		duration, err := time.ParseDuration(value.setting.Value)
		if err != nil {
			return service.SessionConfig{}, errors.New("invalid session duration configuration")
		}
		*value.target = duration
	}
	if err := config.Validate(); err != nil {
		return service.SessionConfig{}, err
	}
	return config, nil
}

type request struct {
	Method  string      `json:"method"`
	URL     string      `json:"url"`
	Headers http.Header `json:"headers"`
	Body    []byte      `json:"body"`
	Peer    string      `json:"peer"`
}

type response struct {
	Status  int         `json:"status"`
	Headers http.Header `json:"headers"`
	Body    []byte      `json:"body"`
}

//go:wasmexport mapi_alloc
func alloc(size uint32) uint32 {
	input = make([]byte, size)
	return uint32(uintptr(unsafe.Pointer(unsafe.SliceData(input))))
}

//go:wasmexport mapi_release
func release() {
	clear(input)
	clear(output)
	input = nil
	output = nil
}

func marshal(value any) uint64 {
	var err error
	output, err = json.Marshal(value)
	if err != nil {
		panic(err)
	}
	ptr := uint32(uintptr(unsafe.Pointer(unsafe.SliceData(output))))
	return uint64(ptr)<<32 | uint64(len(output))
}

func failure(err error) uint64 {
	var domainError domain.Error
	if errors.As(err, &domainError) {
		return marshal(map[string]string{"error": err.Error(), "code": domainError.Code})
	}
	return marshal(map[string]string{"error": err.Error()})
}

func defaultHashers() (*crypto.HasherFactory, error) {
	// v0.7.0 server defaults for the synthetic Argon2id project.
	config := crypto.HashConfig{
		Hasher: crypto.HasherConfig{
			Algorithm: crypto.HashNameArgon2id,
			Params:    map[string]any{"Time": 3, "Memory": 64 * 1024, "Threads": 4},
		},
		Verifiers: []crypto.HashName{crypto.HashNameArgon2},
		Limits: crypto.HashLimitsConfig{
			Argon2: crypto.Argon2LimitsConfig{MinTime: 1, MaxTime: 10, MinMemory: 8 * 1024, MaxMemory: 512 * 1024, MinThreads: 1, MaxThreads: 16},
		},
		Concurrency: crypto.HashConcurrencyConfig{MaxOperations: 1, MemoryBudget: 64 << 20},
	}
	return config.NewHasherFactory()
}

//go:wasmexport mapi_init
func initialize() uint64 {
	debug.SetMemoryLimit(96 << 20)
	var config configuration
	if err := json.Unmarshal(input, &config); err != nil {
		return failure(err)
	}
	sessionConfig, err := config.sessionConfig()
	if err != nil {
		return failure(err)
	}
	key, err := crypto.ParseRSAKey(config.PEM)
	if err != nil {
		return failure(errors.New("invalid prototype master key"))
	}
	master, err := domain.NewMasterKeys([]domain.MasterKey{domain.NewMasterKey(config.KeyID, *key, true)})
	if err != nil {
		return failure(err)
	}
	hashers, err := defaultHashers()
	if err != nil {
		return failure(err)
	}
	hasher = hashers.Default()

	pool := service.NewPool(sqlite.NewCloudflarePool())
	refs := service.StatementsUserRefResolver{Pool: pool}
	crypters, err := cache.NewMeteredLRU[service.CrypterCacheKey, op.Crypto](cache.NameCrypter, 64)
	if err != nil {
		return failure(err)
	}
	signing, err := cache.NewMeteredLRU[service.SigningKeyCacheKey, domain.SigningKey](cache.NameSigningKey, 64)
	if err != nil {
		return failure(err)
	}
	keys := service.NewKeyService(pool, *master, crypters, signing)
	runtimePool, runtimeKeys, runtimeHashers = pool, keys, hashers
	tokens := service.NewTokenService(keys, pool)
	runtimeTokens = tokens
	attempts := service.NewAuthAttemptService(pool,
		service.SessionStatementsResolver{Pool: pool}, service.UserStatementsLookup{Pool: pool},
		service.NewProjectHasherResolver(pool, hashers), hasher)
	sessions := service.NewSessionService(pool, refs, sessionConfig)
	releases := service.NewReleaseService(pool, nil, nil, nil, nil, nil, domain.BuiltinSchemaBases{})
	flows, projects, err := newFlowStack(pool, keys, hashers, attempts)
	if err != nil {
		return failure(err)
	}
	handler, err = api.CloudflareHandler(config.ProjectID, pool, attempts, sessions, keys, tokens, releases, service.NewRuntimeResolver(pool, releases), flows, projects)
	if err != nil {
		return failure(err)
	}
	return marshal(true)
}

//go:wasmexport mapi_request
func handleRequest() uint64 {
	var req request
	if err := json.Unmarshal(input, &req); err != nil {
		return failure(err)
	}
	r, err := http.NewRequest(req.Method, req.URL, bytes.NewReader(req.Body))
	if err != nil {
		return failure(err)
	}
	for name, values := range req.Headers {
		r.Header[http.CanonicalHeaderKey(name)] = values
	}
	r.RemoteAddr = net.JoinHostPort(req.Peer, "0")
	if r.URL.Scheme == "https" {
		r.TLS = &tls.ConnectionState{}
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, r)
	if strings.HasSuffix(r.URL.Path, "/verify") || strings.HasSuffix(r.URL.Path, "/submit") {
		// Go/Wasm linear memory can grow but cannot shrink. Reclaim the
		// Argon2 scratch space before another proof can allocate a second arena.
		runtime.GC()
	}
	return marshal(response{recorder.Code, recorder.Header(), recorder.Body.Bytes()})
}

//go:wasmexport mapi_probe
func probe() uint64 {
	ctx := context.Background()
	db := cloudflarewasm.Open()
	defer db.Close()
	if _, err := db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS mapi_probe(value INTEGER NOT NULL)"); err != nil {
		return failure(err)
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM mapi_probe"); err != nil {
		return failure(err)
	}
	abort := errors.New("probe transaction rollback")
	now := time.Now().UnixNano()
	err := cloudflarewasm.Transaction(func() error {
		_, err := db.ExecContext(ctx, "INSERT INTO mapi_probe VALUES (?)", now)
		if err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) {
		return failure(fmt.Errorf("rollback did not return the callback error: %w", err))
	}
	err = cloudflarewasm.Transaction(func() error {
		_, err := db.ExecContext(ctx, "INSERT INTO mapi_probe VALUES (?)", now)
		return err
	})
	if err != nil {
		return failure(err)
	}
	var count int
	var stored int64
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*), MAX(value) FROM mapi_probe").Scan(&count, &stored); err != nil {
		return failure(err)
	}
	if count != 1 || stored != now {
		return failure(errors.New("probe transaction did not preserve rollback and exact integers"))
	}

	secret := make([]byte, 24)
	if _, err := cryptorand.Read(secret); err != nil {
		return failure(err)
	}
	password := fmt.Sprintf("%x", secret)
	encoded, err := hasher.Hash(ctx, password)
	if err != nil {
		return failure(err)
	}
	runtime.GC()
	if err := hasher.VerifyHash(ctx, encoded, password); err != nil {
		return failure(err)
	}
	runtime.GC()
	return marshal(map[string]any{"transaction": true, "password": true, "clock": now > 0})
}

func main() {}
