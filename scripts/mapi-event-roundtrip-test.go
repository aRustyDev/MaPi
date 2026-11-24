package api_test

import (
	"encoding/json"
	"fmt"
	"testing"

	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/mapieventcontract"
	"github.com/zitadel/nextgen/internal/storage/events"
)

func TestMaPiAuditPayloadRoundTrip(t *testing.T) {
	cases := []struct{ kind, payload string }{
		{"mapi.oauth.signing_key.rotated", `{}`}, {"mapi.oauth.code.issued", `{}`}, {"mapi.oauth.refresh.reuse", `{}`},
		{"mapi.oauth.client_credential.rotated", `{}`}, {"mapi.oauth.client_credential.revoked", `{}`},
		{"mapi.oauth.logout_uri.registered", `{"uri":"https://example.test/logout"}`}, {"mapi.oauth.profile_client.assigned", `{"profile":"bearer"}`},
		{"mapi.fapi.resource_policy.updated", `{"audience":"https://resource.test","scopes":null,"enabled":false,"version":0}`},
		{"mapi.fapi.resource_policy.updated", `{"audience":"a","scopes":[],"enabled":true,"version":9223372036854775807}`},
		{"mapi.fapi.resource_policy.updated", `{"audience":"a","scopes":["a","b"],"enabled":false,"version":-9223372036854775808}`},
		{"mapi.fapi.client_keys.changed", `{"kids":null}`}, {"mapi.fapi.client_keys.changed", `{"kids":[]}`}, {"mapi.fapi.client_keys.changed", `{"kids":["key1","key2"]}`},
		{"mapi.fapi.client_assertion.accepted", `{"kid":"key1"}`}, {"mapi.fapi.dpop.nonce.issued", `{"purpose":"par"}`},
		{"mapi.fapi.par.pushed", `{}`}, {"mapi.fapi.par.consumed", `{}`}, {"mapi.fapi.signing_key.rotated", `{}`},
		{"mapi.fapi.access.validated", `{}`}, {"mapi.fapi.token.exchanged", `{}`}, {"mapi.fapi.code.reused", `{}`},
		{"mapi.fapi.login_started", `{}`}, {"mapi.fapi.code_issued", `{}`}, {"mapi.fapi.login_denied", `{}`},
		{"mapi.recovery.session_checks_invalidated", `{"recovery_id":"r1","count":0}`},
		{"mapi.recovery.session_tokens_invalidated", `{"recovery_id":"r1","count":1}`},
		{"mapi.recovery.orphan_tokens_invalidated", `{"recovery_id":"r1","count":9223372036854775807}`},
		{"mapi.recovery.credential_invalidated", `{"recovery_id":"r1","count":1}`},
		{"mapi.recovery.attempt_checks_invalidated", `{"recovery_id":"r1","count":1}`},
		{"mapi.recovery.attempt_invalidated", `{"recovery_id":"r1","count":1}`},
		{"mapi.recovery.completed", `{"expired_handoffs":0,"revoked_sessions":1}`},
		{"mapi.recovery.completed", `{"recovery_id":"r1","invalidated_attempts":0,"invalidated_handoffs":1,"revoked_sessions":9223372036854775807,"revoked_credentials":2}`},
	}
	for i, tc := range cases {
		t.Run(fmt.Sprintf("%s/%d", tc.kind, i), func(t *testing.T) {
			input := fmt.Sprintf(`{"id":"evt_test","project_id":"proj_test","event_type":%q,"category":"auth","occurred_at":"2024-01-01T00:00:00Z","created_at":"2024-01-01T00:00:00Z","client_id":"","payload":%s}`, tc.kind, tc.payload)
			var event generated.Event
			if err := event.UnmarshalJSON([]byte(input)); err != nil {
				t.Fatal(err)
			}
			output, err := event.MarshalJSON()
			if err != nil {
				t.Fatal(err)
			}
			var envelope struct {
				Type string `json:"event_type"`
			}
			if err := json.Unmarshal(output, &envelope); err != nil || envelope.Type != tc.kind {
				t.Fatalf("event type changed: %s (%v)", envelope.Type, err)
			}
			if err := mapieventcontract.ValidatePayload([]byte(tc.payload), output); err != nil {
				t.Fatal(err)
			}
		})
	}
	if payload, err := events.MarshalPayload(nil); err != nil || string(payload) != `{}` {
		t.Fatalf("nil audit payload: %s %v", payload, err)
	}
}

func TestMaPiUnknownAuditDataFailsClosed(t *testing.T) {
	for _, tc := range []struct{ kind, payload string }{
		{"mapi.oauth.signing_key.rotated", `{"unknown":"preserve"}`},
		{"mapi.recovery.completed", `{"revoked_sessions":1,"future_counter":2}`},
		{"mapi.oauth.logout_uri.registered", `{"uri":"first","uri":"second"}`},
		{"mapi.unknown.future", `{}`},
	} {
		input := fmt.Sprintf(`{"id":"evt_test","project_id":"proj_test","event_type":%q,"category":"auth","occurred_at":"2024-01-01T00:00:00Z","created_at":"2024-01-01T00:00:00Z","client_id":"","payload":%s}`, tc.kind, tc.payload)
		var event generated.Event
		if event.UnmarshalJSON([]byte(input)) != nil {
			continue
		}
		output, err := event.MarshalJSON()
		if err != nil {
			continue
		}
		if mapieventcontract.ValidatePayload([]byte(tc.payload), output) == nil {
			t.Fatalf("unknown data was accepted without preservation: %s", tc.kind)
		}
	}
	if err := mapieventcontract.ValidatePayload([]byte(`{"outer":{"x":1,"x":2}}`), []byte(`{"payload":{"outer":{"x":2}}}`)); err == nil {
		t.Fatal("nested duplicate key accepted")
	}
	if err := mapieventcontract.ValidatePayload([]byte(`{"x":"\ud800"}`), []byte(`{"payload":{"x":"�"}}`)); err == nil {
		t.Fatal("unpaired surrogate accepted")
	}
	if err := mapieventcontract.ValidatePayload([]byte(`{"x":"\udc00"}`), []byte(`{"payload":{"x":"�"}}`)); err == nil {
		t.Fatal("unpaired low surrogate accepted")
	}
	if err := mapieventcontract.ValidatePayload([]byte(`{"x":"\ud800\u1234"}`), []byte(`{"payload":{"x":"�ሴ"}}`)); err == nil {
		t.Fatal("invalid surrogate pair accepted")
	}
	if err := mapieventcontract.ValidatePayload([]byte(`{"x":"\\ud800"}`), []byte(`{"payload":{"x":"\\ud800"}}`)); err != nil {
		t.Fatal("literal escape rejected", err)
	}
	if err := mapieventcontract.ValidatePayload([]byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'}, []byte(`{"payload":{"x":"�"}}`)); err == nil {
		t.Fatal("invalid UTF-8 accepted")
	}
	if err := mapieventcontract.ValidatePayload([]byte(`{"x":"\ud83d\ude00"}`), []byte(`{"payload":{"x":"😀"}}`)); err != nil {
		t.Fatal("valid surrogate pair rejected", err)
	}
}

func TestMaPiDuplicateIsRejectedByPayloadGuard(t *testing.T) {
	payload := `{"uri":"first","uri":"second"}`
	input := fmt.Sprintf(`{"id":"evt_test","project_id":"proj_test","event_type":"mapi.oauth.logout_uri.registered","category":"admin","occurred_at":"2024-01-01T00:00:00Z","created_at":"2024-01-01T00:00:00Z","client_id":"","payload":%s}`, payload)
	var event generated.Event
	if err := event.UnmarshalJSON([]byte(input)); err != nil {
		t.Fatalf("decoder rejected duplicate before guard: %v", err)
	}
	output, err := event.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if err := mapieventcontract.ValidatePayload([]byte(payload), output); err == nil {
		t.Fatal("guard accepted duplicate payload keys")
	}
}
