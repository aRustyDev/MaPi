package mapioauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
)

func TestPromptNoneNeverStartsInteractiveLogin(t *testing.T) {
	store, grant := fixture(t)
	apps := applicationStatementsFixture{
		client: &domain.ApplicationClient{ProjectID: "proj_A", ApplicationID: "app_A", ID: "row_A", Slug: "web", ClientID: "client_A"},
		app:    &domain.Application{ID: "app_A", RevisionID: "rev_A", Document: []byte(`{"slug":"shop","name":"Shop","clients":[{"slug":"web","client_id":"client_A","grant_types":["authorization_code"],"redirect_uris":["https://app.example/callback"]}]}`)},
	}
	provider := &Provider{ProjectID: "proj_A", LoginOrigin: "https://issuer.example", Registry: ClientRegistry{Statements: apps}, Store: store}
	provider.BeginLogin = func(context.Context, *op.ClientRequest[oidc.AuthRequest]) (*op.Redirect, error) {
		t.Error("prompt=none attempted interactive login")
		return op.NewRedirect("https://issuer.example/login"), nil
	}
	query := url.Values{"client_id": {"client_A"}, "redirect_uri": {grant.RedirectURI}, "response_type": {"code"}, "scope": {"openid"}, "state": {"state-value"}, "code_challenge": {grant.CodeChallenge}, "code_challenge_method": {"S256"}, "prompt": {"none"}}
	request := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		provider.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "https://issuer.example/authorize?"+query.Encode(), nil))
		return w
	}
	w := request()
	location, err := url.Parse(w.Header().Get("Location"))
	if err != nil || w.Code != http.StatusFound || location.Host != "app.example" || location.Query().Get("error") != "interaction_required" || location.Query().Get("state") != "state-value" {
		t.Fatalf("prompt=none did not return interaction_required: status=%d", w.Code)
	}
	query.Del("code_challenge")
	query.Del("code_challenge_method")
	w = request()
	location, err = url.Parse(w.Header().Get("Location"))
	if err != nil || w.Code != http.StatusFound || location.Query().Get("error") != "invalid_request" {
		t.Fatalf("missing PKCE did not remain invalid: status=%d", w.Code)
	}
	query.Set("code_challenge", grant.CodeChallenge)
	query.Set("code_challenge_method", "S256")
	query.Set("prompt", "none login")
	w = request()
	location, err = url.Parse(w.Header().Get("Location"))
	if err != nil || w.Code != http.StatusFound || location.Query().Get("error") != "invalid_request" {
		t.Fatalf("conflicting prompts were accepted: status=%d", w.Code)
	}
}
