// Package mapiidpbridge contains an unmounted experiment. It adapts the
// pinned Nextgen FlowSSOCallback to synchronous Go/Wasm entry points while
// the host performs bounded, policy-checked network I/O between calls.
package mapiidpbridge

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
)

// Intent contains secrets in transit and must never be logged or sent to a
// browser. The Worker must enforce destination policy, redirect handling,
// deadlines, request/response bounds and TLS before dispatching it.
type Intent struct{ Method, URL, Authorization, ContentType, Body string }
type Response struct {
	Status            int
	ContentType, Body string
}
type responseRecord struct {
	Request  Intent
	Response Response
}

var ErrInvalidState = errors.New("invalid private callback bridge state")

// Bridge is one callback and must remain private to one request in one
// reactor. It must not be serialized to an untrusted client. Nextgen state is
// consumed once; reruns reuse the verified check only inside this instance.
// If the object is evicted after provider dispatch the attempt must fail
// closed rather than retry a potentially consumed provider code.
type Bridge struct {
	mu          sync.Mutex
	input       service.FlowSSOCallbackInput
	attempts    service.AuthAttemptService
	connections service.IDPConnectionService
	keys        service.KeyService
	variables   service.VariableService
	consumed    *domain.SSOCallbackCheck
	transcript  []responseRecord
	pending     *Intent
	done        bool
}

func New(input service.FlowSSOCallbackInput, attempts service.AuthAttemptService, connections service.IDPConnectionService, keys service.KeyService, variables service.VariableService) (*Bridge, error) {
	if input.State == "" || input.BindingNonce == "" || input.ConnectionSlug == "" || attempts == nil || connections == nil || keys == nil || variables == nil {
		return nil, ErrInvalidState
	}
	return &Bridge{input: input, attempts: attempts, connections: connections, keys: keys, variables: variables}, nil
}

type guardedAttempts struct {
	service.AuthAttemptService
	bridge    *Bridge
	transport *recordReplay
}

func (a guardedAttempts) ConsumeSSOState(ctx context.Context, project, state, binding string) (*domain.SSOCallbackCheck, error) {
	b := a.bridge
	if project != domain.SSOStateProjectID(b.input.State) || state != b.input.State || binding != b.input.BindingNonce {
		return nil, domain.ErrSSOStateInvalid()
	}
	if b.consumed != nil {
		return b.consumed, nil
	}
	check, err := a.AuthAttemptService.ConsumeSSOState(ctx, project, state, binding)
	if err != nil {
		return nil, err
	}
	if check == nil || check.Pending == nil {
		return nil, domain.ErrSSOStateInvalid()
	}
	b.consumed = check
	return check, nil
}
func (a guardedAttempts) SetSSOCallbackResult(ctx context.Context, project string, check *domain.SSOCallbackCheck, result *domain.SSOCallbackResult, event domain.EventType) error {
	// Nextgen parks a generic exchange failure when a synchronous transport
	// returns our missing-I/O sentinel. Suppress only this intermediate park.
	if a.transport.next != nil {
		return nil
	}
	return a.AuthAttemptService.SetSSOCallbackResult(ctx, project, check, result, event)
}

type recordReplay struct {
	records []responseRecord
	index   int
	next    *Intent
}

func (t *recordReplay) RoundTrip(r *http.Request) (*http.Response, error) {
	var body []byte
	var err error
	if r.Body != nil {
		body, err = io.ReadAll(io.LimitReader(r.Body, 8193))
		if err != nil || len(body) > 8192 {
			return nil, errors.New("request too large")
		}
	}
	req := Intent{Method: r.Method, URL: r.URL.String(), Authorization: r.Header.Get("Authorization"), ContentType: r.Header.Get("Content-Type"), Body: string(body)}
	if t.index == len(t.records) {
		t.next = &req
		return nil, errors.New("private outbound intent")
	}
	if t.index > len(t.records) || t.records[t.index].Request != req {
		return nil, errors.New("outbound transcript mismatch")
	}
	resp := t.records[t.index].Response
	t.index++
	return &http.Response{StatusCode: resp.Status, Header: http.Header{"Content-Type": []string{resp.ContentType}}, Body: io.NopCloser(strings.NewReader(resp.Body)), Request: r}, nil
}

// Advance runs upstream synchronously. On the first call response must be nil;
// afterward it must be the response to the immediately preceding intent.
// The host must never pass untrusted or unvalidated responses. No network
// fetch can occur through this bridge's transport.
func (b *Bridge) Advance(ctx context.Context, response *Response) (*Intent, *service.FlowSSOCallbackOutput, error) {
	if b == nil {
		return nil, nil, ErrInvalidState
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.done {
		return nil, nil, ErrInvalidState
	}
	defer func() {
		if b.done {
			b.clear()
		}
	}()
	if b.pending == nil && response != nil || b.pending != nil && response == nil {
		return nil, nil, ErrInvalidState
	}
	if response != nil {
		if response.Status < 100 || response.Status > 599 || len(response.Body) > 16384 || len(response.ContentType) > 256 {
			return nil, nil, ErrInvalidState
		}
		b.transcript = append(b.transcript, responseRecord{Request: *b.pending, Response: *response})
		b.pending = nil
	}
	if len(b.transcript) > 6 {
		b.done = true
		return nil, nil, ErrInvalidState
	}
	transport := &recordReplay{records: b.transcript}
	attempts := guardedAttempts{AuthAttemptService: b.attempts, bridge: b, transport: transport}
	engine := service.NewFlowSSOCallback(b.connections, attempts, b.keys, b.variables, &http.Client{Transport: transport}) //egress:allow the transport only records or replays in-memory bounded responses
	output, err := engine.Process(ctx, b.input)
	if transport.next != nil {
		if transport.index != len(b.transcript) || err != nil {
			b.done = true
			return nil, nil, ErrInvalidState
		}
		b.pending = transport.next
		next := *b.pending
		return &next, nil, nil
	}
	b.done = true
	if transport.index != len(b.transcript) {
		return nil, nil, ErrInvalidState
	}
	if err != nil {
		return nil, nil, err
	}
	return nil, &output, nil
}

// Abort parks an upstream generic failure and its audit after a known network
// failure. It cannot resolve an ambiguous crash; callers must start a fresh
// authorization flow rather than retry the external one-time code.
func (b *Bridge) Abort(ctx context.Context) error {
	if b == nil {
		return ErrInvalidState
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.done || b.consumed == nil {
		return ErrInvalidState
	}
	b.done = true
	defer b.clear()
	event := domain.EventTypeAuthSSOExchangeFailed
	if b.input.Code == "" {
		event = domain.EventTypeAuthSSOAuthorizationFailed
	}
	return b.attempts.SetSSOCallbackResult(ctx, domain.SSOStateProjectID(b.input.State), b.consumed, &domain.SSOCallbackResult{ErrorKey: domain.FlowStepErrorSSOFailed}, event)
}

// clear drops references to sensitive callback material after completion.
// Go strings cannot be reliably zeroed, so the hosting runtime must also
// constrain reactor lifetime and avoid retaining or logging transcript data.
func (b *Bridge) clear() {
	b.input = service.FlowSSOCallbackInput{}
	clear(b.transcript)
	b.transcript = nil
	b.pending = nil
	b.consumed = nil
}
