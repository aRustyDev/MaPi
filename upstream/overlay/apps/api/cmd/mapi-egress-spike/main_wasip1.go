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
