//go:build wasip1

// Isolated local spike: synchronously plan and replay upstream OIDC discovery.
// It has no network imports and no public API.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"unsafe"

	"github.com/zitadel/nextgen/internal/httputil"
	"github.com/zitadel/nextgen/internal/idp"
)

var input, output []byte

//go:wasmexport mapi_alloc
func alloc(size uint32) uint32 {
	input = make([]byte, size)
	return uint32(uintptr(unsafe.Pointer(unsafe.SliceData(input))))
}

//go:wasmexport mapi_release
func release() { clear(input); clear(output); input = nil; output = nil }
func send(value any) uint64 {
	var err error
	output, err = json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return uint64(uint32(uintptr(unsafe.Pointer(unsafe.SliceData(output)))))<<32 | uint64(len(output))
}

type args struct {
	Issuer        string `json:"issuer"`
	URL           string `json:"url"`
	Body          string `json:"body"`
	Status        int    `json:"status"`
	AllowLoopback bool   `json:"allowLoopback"`
	Host          string `json:"host"`
}
type replay struct {
	expected string
	body     string
	status   int
	seen     string
}

func (r *replay) RoundTrip(req *http.Request) (*http.Response, error) {
	r.seen = req.URL.String()
	if req.Method != http.MethodGet {
		return nil, errors.New("unexpected method")
	}
	if r.expected == "" {
		return nil, errors.New("intent requested")
	}
	if r.seen != r.expected {
		return nil, errors.New("unexpected request")
	}
	return &http.Response{StatusCode: r.status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(r.body)), Request: req}, nil
}
func parse(a args) (idp.Connection, error) {
	u, err := url.Parse(a.Issuer)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return idp.Connection{}, errors.New("invalid issuer")
	}
	allow := []string{}
	if a.AllowLoopback {
		allow = []string{"127.0.0.1"}
	}
	policy, err := httputil.NewPolicy(httputil.DefaultDenyList, allow)
	if err != nil {
		return idp.Connection{}, err
	}
	if err := policy.CheckAddress(u.Hostname()); err != nil {
		return idp.Connection{}, err
	}
	body, err := json.Marshal(map[string]any{"protocol": "oidc", "oidc": map[string]any{"issuer": a.Issuer, "client_id": "synthetic", "scopes": []string{"openid"}}})
	if err != nil {
		return idp.Connection{}, err
	}
	return idp.ParseConnection("revision_synthetic", body)
}

//go:wasmexport mapi_egress_check
func check() uint64 {
	var a args
	if json.Unmarshal(input, &a) != nil {
		return send(map[string]any{"error": "invalid"})
	}
	p, err := httputil.NewPolicy(httputil.DefaultDenyList, nil)
	if err != nil {
		return send(map[string]any{"error": "policy"})
	}
	return send(map[string]any{"allowed": p.CheckAddress(a.Host) == nil})
}

//go:wasmexport mapi_prepare
func prepare() uint64 {
	var a args
	if json.Unmarshal(input, &a) != nil {
		return send(map[string]any{"error": "invalid"})
	}
	conn, err := parse(a)
	if err != nil {
		return send(map[string]any{"error": "denied"})
	}
	transport := &replay{}
	client := &http.Client{Transport: transport} //egress:allow test transport only records an intent; it cannot dial
	_, _ = idp.NewOIDCClient(context.Background(), conn, "https://app.example.test/callback", client)
	if transport.seen == "" {
		return send(map[string]any{"error": "no_intent"})
	}
	return send(map[string]any{"url": transport.seen})
}

//go:wasmexport mapi_resume
func resume() uint64 {
	var a args
	if json.Unmarshal(input, &a) != nil {
		return send(map[string]any{"error": "invalid"})
	}
	conn, err := parse(a)
	if err != nil {
		return send(map[string]any{"error": "denied"})
	}
	transport := &replay{expected: a.URL, body: a.Body, status: a.Status}
	client := &http.Client{Transport: transport} //egress:allow test transport only replays bounded in-memory data
	party, err := idp.NewOIDCClient(context.Background(), conn, "https://app.example.test/callback", client)
	if err != nil || transport.seen != a.URL {
		return send(map[string]any{"error": "discovery_failed"})
	}
	return send(map[string]any{"userinfo": party.UserinfoEndpoint()})
}
func main() {}

// The callback probe replays an ephemeral transcript through the real pinned
// Nextgen OIDC engine. A missing request is returned to the host as an intent;
// no asynchronous I/O or host callback runs inside Go or a SQL transaction.
type callbackMessage struct {
	Issuer    string             `json:"issuer"`
	Responses []callbackResponse `json:"responses"`
	Code      string             `json:"code"`
	Nonce     string             `json:"nonce"`
	Verifier  string             `json:"verifier"`
	Secret    string             `json:"secret"`
}
type callbackRequest struct {
	Method        string `json:"method"`
	URL           string `json:"url"`
	Authorization string `json:"authorization,omitempty"`
	ContentType   string `json:"contentType,omitempty"`
	Body          string `json:"body,omitempty"`
}
type callbackResponse struct {
	Request     callbackRequest `json:"request"`
	Status      int             `json:"status"`
	Body        string          `json:"body"`
	ContentType string          `json:"contentType"`
}
type callbackTransport struct {
	responses []callbackResponse
	seen      int
	next      *callbackRequest
}

func (t *callbackTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	var err error
	if req.Body != nil {
		body, err = io.ReadAll(io.LimitReader(req.Body, 8193))
		if err != nil || len(body) > 8192 {
			return nil, errors.New("request too large")
		}
	}
	intent := callbackRequest{Method: req.Method, URL: req.URL.String(), Authorization: req.Header.Get("Authorization"), ContentType: req.Header.Get("Content-Type"), Body: string(body)}
	if t.seen >= len(t.responses) {
		t.next = &intent
		return nil, errors.New("next request")
	}
	recorded := t.responses[t.seen]
	t.seen++
	if recorded.Request != intent || len(recorded.Body) > 16384 {
		return nil, errors.New("transcript mismatch")
	}
	return &http.Response{StatusCode: recorded.Status, Header: http.Header{"Content-Type": []string{recorded.ContentType}}, Body: io.NopCloser(strings.NewReader(recorded.Body)), Request: req}, nil
}

//go:wasmexport mapi_idp_callback
func idpCallback() uint64 {
	var a callbackMessage
	if json.Unmarshal(input, &a) != nil || len(a.Responses) > 4 || a.Code == "" || a.Nonce == "" || a.Verifier == "" || a.Secret == "" {
		return send(map[string]any{"error": "invalid"})
	}
	conn, err := parse(args{Issuer: a.Issuer, AllowLoopback: true})
	if err != nil {
		return send(map[string]any{"error": "denied"})
	}
	conn.ClaimMapping = map[string]string{"email": "email"}
	transport := &callbackTransport{responses: a.Responses}
	client := &http.Client{Transport: transport} //egress:allow isolated in-memory record/replay transport never dials
	party, err := idp.NewOIDCClient(context.Background(), conn, "https://app.example.test/callback", client)
	if err == nil {
		var identity idp.ExternalIdentity
		identity, err = party.Callback(context.Background(), idp.CallbackRequest{Code: a.Code, Nonce: a.Nonce, PKCEVerifier: a.Verifier, RedirectURI: "https://app.example.test/callback", RevisionID: "revision_synthetic", ClientSecret: a.Secret})
		if err == nil {
			if transport.seen != len(a.Responses) {
				return send(map[string]any{"error": "unused response"})
			}
			return send(map[string]any{"subject": identity.Subject, "email": identity.Claims["email"]})
		}
	}
	if transport.next != nil {
		return send(map[string]any{"next": transport.next})
	}
	return send(map[string]any{"error": "callback_failed"})
}
