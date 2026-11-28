//go:build js && wasm

package main

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgproto3"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"
	"github.com/ory/hydra/v2/consent"
	hydra "github.com/ory/hydra/v2/driver"
	"github.com/ory/hydra/v2/driver/config"
	"github.com/ory/hydra/v2/fosite"
	"github.com/ory/hydra/v2/jwk"
	"github.com/ory/hydra/v2/oauth2"
	"github.com/ory/pop/v6"
	"github.com/ory/x/configx"
)

const driverName = "mapi-hydra-phase0-pgx"

type exchange struct {
	Method  string      `json:"method"`
	Path    string      `json:"path"`
	Headers http.Header `json:"headers"`
	Body    string      `json:"body"`
}

type reply struct {
	Status  int         `json:"status"`
	Headers http.Header `json:"headers,omitempty"`
	Body    string      `json:"body"`
}

type queryCounter struct{ host js.Value }

func (q queryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	q.host.Set("sqlOperations", q.host.Get("sqlOperations").Int()+1)
	return ctx
}

func (queryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// Count protocol synchronization messages without emitting trace data, which
// may contain SQL, bind parameters, and credentials. Tracing starts after the
// connection handshake, so these counts exclude connection establishment.
type protocolCounter struct{ host js.Value }

func (p protocolCounter) Write(b []byte) (int, error) {
	field := ""
	switch {
	case bytes.HasPrefix(b, []byte("F\tSync\t")):
		field = "pgSync"
	case bytes.HasPrefix(b, []byte("F\tQuery\t")):
		field = "pgSimpleQuery"
	case bytes.HasPrefix(b, []byte("B\tReadyForQuery\t")):
		field = "pgReady"
	}
	if field != "" {
		p.host.Set(field, p.host.Get(field).Int()+1)
	}
	return len(b), nil
}

type boundConnector struct {
	driver.Connector
}

// The SQL instrumentation obtains the driver from the connector before
// reopening the connection. Retain the request-scoped dialer at that seam.
func (c boundConnector) Driver() driver.Driver {
	return pgDriver{connector: c}
}

type pgDriver struct {
	connector driver.Connector
}

func (d pgDriver) Open(_ string) (driver.Conn, error) {
	return d.connector.Connect(context.Background())
}

func (d pgDriver) OpenConnector(_ string) (driver.Connector, error) {
	return d.connector, nil
}

func main() {
	host := js.Global().Get("mapiHydraRequests").Call("get", os.Getenv("MAPI_HYDRA_REQUEST"))
	if host.IsUndefined() {
		return
	}
	result, err := run(host)
	if err != nil {
		host.Set("failure", err.Error())
		return
	}
	payload, err := json.Marshal(result)
	if err != nil {
		host.Set("failure", "serialize Hydra response")
		return
	}
	host.Set("response", string(payload))
}

func run(host js.Value) (reply, error) {
	var input exchange
	if err := json.Unmarshal([]byte(host.Get("request").String()), &input); err != nil {
		return reply{}, errors.New("decode private host request")
	}
	path := strings.SplitN(input.Path, "?", 2)[0]
	switch {
	case input.Method == http.MethodGet && path == "/.well-known/openid-configuration":
	case input.Method == http.MethodGet && path == "/.well-known/jwks.json":
	case input.Method == http.MethodGet && path == "/oauth2/auth":
	case input.Method == http.MethodPost && path == "/oauth2/token":
	case input.Method == http.MethodPost && path == "/phase0/fence":
	case input.Method == http.MethodPost && path == "/phase0/code":
	case input.Method == http.MethodPost && path == "/phase0/access":
	case (input.Method == http.MethodGet || input.Method == http.MethodPut) && strings.HasPrefix(path, "/admin/oauth2/auth/requests/"):
	default:
		return reply{Status: http.StatusNotFound, Body: "route outside Phase 0 probe"}, nil
	}

	dsn := host.Get("dsn").String()
	pg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return reply{}, errors.New("parse private Postgres connection")
	}
	pg.Tracer = queryCounter{host: host}
	pg.LookupFunc = func(_ context.Context, host string) ([]string, error) {
		return []string{host}, nil
	}
	pg.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" {
			return nil, errors.New("the Worker bridge supports TCP only")
		}
		name, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		// The host validates that the resolved endpoint is the bound database.
		timeout := 5 * time.Second
		if deadline, ok := ctx.Deadline(); ok {
			timeout = min(timeout, time.Until(deadline))
		}
		if timeout <= 0 {
			return nil, context.DeadlineExceeded
		}
		socket, err := wait(host.Call("dial", name, port, timeout.Milliseconds()))
		if err != nil {
			return nil, err
		}
		return &socketConn{socket: socket, remote: socketAddr(address), host: host}, nil
	}
	sql.Register(driverName, pgDriver{connector: boundConnector{Connector: stdlib.GetConnector(*pg,
		stdlib.OptionAfterConnect(func(_ context.Context, conn *pgx.Conn) error {
			host.Set("pgConnections", host.Get("pgConnections").Int()+1)
			conn.PgConn().Frontend().Trace(protocolCounter{host}, pgproto3.TracerOptions{SuppressTimestamps: true})
			return nil
		}))}})
	sqlx.BindDriver(driverName, sqlx.DOLLAR)

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	issuer := host.Get("issuer").String()
	systemSecret := host.Get("systemSecret").String()
	if !strings.HasPrefix(issuer, "https://") || len(systemSecret) < 32 {
		return reply{}, errors.New("invalid spike issuer or system secret")
	}

	registry, err := hydra.New(ctx,
		hydra.DisablePreloading(),
		hydra.WithConfigOptions(configx.WithValues(map[string]interface{}{
			config.KeyDSN:                             dsn,
			config.KeyIssuerURL:                       issuer,
			config.KeyLoginURL:                        issuer + "/phase0/login",
			config.KeyConsentURL:                      issuer + "/phase0/consent",
			config.KeyGetCookieSecrets:                []string{systemSecret},
			config.KeyCookieSecure:                    true,
			config.KeyGetSystemSecret:                 []string{systemSecret},
			config.KeyPKCEEnforced:                    true,
			config.KeyRefreshTokenRotationGracePeriod: "0s",
			config.KeyLogLevel:                        "panic",
			config.KeyCGroupsV1AutoMaxProcsEnabled:    false,
		})),
		hydra.WithDBOptionsModifier(func(details *pop.ConnectionDetails) {
			details.Driver = driverName
			details.Pool = 2
			details.IdlePool = 1
		}),
	)
	if err != nil {
		return reply{}, errors.New("initialize pinned Hydra registry")
	}
	defer registry.BasePersister().Connection(ctx).Close()
	if path == "/phase0/fence" {
		return fenceDatabase(ctx, registry, input.Body)
	}
	if path == "/phase0/code" {
		return bindAuthorizationCode(ctx, registry, input.Body)
	}
	if path == "/phase0/access" {
		var accessInput struct {
			Token string `json:"token"`
		}
		if json.Unmarshal([]byte(input.Body), &accessInput) != nil || accessInput.Token == "" || len(accessInput.Token) > 8192 {
			return reply{Status: http.StatusUnauthorized}, nil
		}
		session := oauth2.NewSessionWithCustomClaims(ctx, registry.Config(), "")
		kind, access, err := registry.OAuth2Provider().IntrospectToken(ctx, accessInput.Token, fosite.AccessToken, session)
		if err != nil || kind != fosite.AccessToken {
			return reply{Status: http.StatusUnauthorized}, nil
		}
		var sessionID string
		if err := registry.BasePersister().Connection(ctx).Store.GetContext(ctx, &sessionID,
			"SELECT session_id FROM mapi_hydra_grant WHERE grant_id = $1", access.GetID()); err != nil || !opaqueID.MatchString(sessionID) {
			return reply{Status: http.StatusUnauthorized}, nil
		}
		return reply{Status: http.StatusOK, Body: sessionID}, nil
	}
	ctx = oauth2.WithPhase0RefreshFence(ctx, refreshFence(registry, host))
	var router http.Handler = oauth2.Phase0Routes(registry)
	if path == "/oauth2/auth" {
		router = oauth2.Phase0Authorization(registry)
	} else if path == "/.well-known/jwks.json" {
		router = jwk.Phase0JWKS(registry)
	} else if strings.HasPrefix(path, "/admin/oauth2/auth/requests/") {
		router = consent.Phase0Admin(registry)
	}
	request := httptest.NewRequestWithContext(ctx, input.Method, issuer+input.Path, strings.NewReader(input.Body))
	for name, values := range input.Headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	response := recorder.Result()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return reply{}, errors.New("read Hydra response")
	}
	return reply{Status: response.StatusCode, Headers: response.Header, Body: string(body)}, nil
}

type socketAddr string

func (a socketAddr) Network() string { return "tcp" }
func (a socketAddr) String() string  { return string(a) }

type socketConn struct {
	socket        js.Value
	host          js.Value
	remote        socketAddr
	mu            sync.Mutex
	readBy        time.Time
	writeBy       time.Time
	pending       js.Value
	dropCommitAck bool
}

func (c *socketConn) Read(buf []byte) (int, error) {
	if len(buf) == 0 {
		return 0, nil
	}
	for c.pending.IsUndefined() || c.pending.Get("byteLength").Int() == 0 {
		result, err := wait(c.socket.Call("read", remaining(c.deadline(true))))
		if err != nil {
			return 0, err
		}
		if result.Get("done").Bool() {
			return 0, io.EOF
		}
		c.pending = result.Get("value")
	}
	count := js.CopyBytesToGo(buf, c.pending)
	c.pending = c.pending.Call("subarray", count)
	if c.dropCommitAck && bytes.Contains(buf[:count], []byte("COMMIT")) {
		c.dropCommitAck = false
		c.host.Set("dropCommitAck", false)
		c.Close()
		return 0, errors.New("synthetic dropped PostgreSQL COMMIT acknowledgment")
	}
	return count, nil
}

func (c *socketConn) Write(buf []byte) (int, error) {
	if c.host.Get("dropCommitAck").Truthy() && bytes.Contains(bytes.ToUpper(buf), []byte("COMMIT")) {
		c.dropCommitAck = true
	}
	payload := js.Global().Get("Uint8Array").New(len(buf))
	js.CopyBytesToJS(payload, buf)
	if _, err := wait(c.socket.Call("write", payload, remaining(c.deadline(false)))); err != nil {
		return 0, err
	}
	return len(buf), nil
}

func (c *socketConn) Close() error {
	c.socket.Call("close")
	return nil
}

func (c *socketConn) LocalAddr() net.Addr  { return socketAddr("worker") }
func (c *socketConn) RemoteAddr() net.Addr { return c.remote }

func (c *socketConn) SetDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.readBy, c.writeBy = t, t
	return nil
}

func (c *socketConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.readBy = t
	return nil
}

func (c *socketConn) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writeBy = t
	return nil
}

func (c *socketConn) deadline(read bool) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if read {
		return c.readBy
	}
	return c.writeBy
}

func remaining(deadline time.Time) int64 {
	timeout := 5 * time.Second
	if !deadline.IsZero() {
		timeout = min(timeout, time.Until(deadline))
	}
	if timeout <= 0 {
		return 0
	}
	return max(1, timeout.Milliseconds())
}

func wait(promise js.Value) (js.Value, error) {
	type outcome struct {
		value js.Value
		err   error
	}
	done := make(chan outcome, 1)
	resolve := js.FuncOf(func(_ js.Value, arguments []js.Value) any {
		result := js.Undefined()
		if len(arguments) != 0 {
			result = arguments[0]
		}
		done <- outcome{value: result}
		return nil
	})
	reject := js.FuncOf(func(_ js.Value, _ []js.Value) any {
		done <- outcome{err: errors.New("private Postgres transport failed")}
		return nil
	})
	defer resolve.Release()
	defer reject.Release()
	promise.Call("then", resolve, reject)
	result := <-done
	return result.value, result.err
}
