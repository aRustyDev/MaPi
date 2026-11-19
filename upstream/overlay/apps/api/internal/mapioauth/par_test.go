package mapioauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPARAtomicityBindingAndReplay(t *testing.T) {
	ctx := context.Background()
	store, grant := fixture(t)
	now := store.Now()
	store.Now = func() time.Time { return now }
	for _, statement := range []string{"CREATE TABLE par_audit (stage TEXT)", "CREATE TABLE par_assertions (value TEXT UNIQUE)", "CREATE TABLE par_proofs (value TEXT UNIQUE)", "CREATE TABLE par_login (value TEXT)"} {
		if _, err := store.DB.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	key := sha256.Sum256([]byte("test DPoP key"))
	jkt := base64.RawURLEncoding.EncodeToString(key[:])
	auditFails := false
	clientAllowed := true
	p := PARStore{Store: store, ProjectID: grant.ProjectID, Endpoint: "https://issuer.example/oauth/proj_A/par", TTL: time.Minute,
		PolicyVersion: func(context.Context, string, string, string) (int64, error) { return 1, nil },
		Authenticate: func(ctx context.Context, _ *http.Request, form url.Values) (string, error) {
			if !strings.HasPrefix(form.Get("client_assertion"), "signed-") {
				return "", ErrInvalidClient
			}
			if _, err := store.DB.ExecContext(ctx, "INSERT INTO par_assertions VALUES (?)", form.Get("client_assertion")); err != nil {
				return "", ErrInvalidClient
			}
			return grant.ClientID, nil
		},
		VerifyDPoP: func(ctx context.Context, clientID, proof, claimed, endpoint string) (string, error) {
			if clientID != grant.ClientID || endpoint != "https://issuer.example/oauth/proj_A/par" {
				return "", ErrInvalidDPoP
			}
			if proof == "" {
				return claimed, nil
			}
			if !strings.HasPrefix(proof, "proof-") || claimed != jkt {
				return "", ErrInvalidDPoP
			}
			if _, err := store.DB.ExecContext(ctx, "INSERT INTO par_proofs VALUES (?)", proof); err != nil {
				return "", ErrInvalidDPoP
			}
			return jkt, nil
		},
		CheckClient: func(_ context.Context, project, client, redirect, scope string) error {
			if !clientAllowed || project != grant.ProjectID || client != grant.ClientID || redirect != grant.RedirectURI || scope != "openid" {
				return ErrInvalidClient
			}
			return nil
		},
		Audit: func(ctx context.Context, stage string, _ PushedAuthorizationRequest) error {
			if _, err := store.DB.ExecContext(ctx, "INSERT INTO par_audit VALUES (?)", stage); err != nil {
				return err
			}
			if auditFails {
				return errors.New("injected audit failure")
			}
			return nil
		},
	}
	if err := p.CreatePARSchema(ctx); err != nil {
		t.Fatal(err)
	}
	form := url.Values{"client_id": {grant.ClientID}, "client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"}, "client_assertion": {"signed-1"}, "response_type": {"code"}, "redirect_uri": {grant.RedirectURI}, "scope": {"openid"}, "state": {"state"}, "nonce": {"nonce"}, "code_challenge": {grant.CodeChallenge}, "code_challenge_method": {"S256"}, "dpop_jkt": {jkt}}
	request := func(values url.Values, proof string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, p.Endpoint, strings.NewReader(values.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if proof != "" {
			r.Header.Set("DPoP", proof)
		}
		w := httptest.NewRecorder()
		(PARHTTP{PAR: p}).ServeHTTP(w, r)
		return w
	}
	auditFails = true
	if w := request(form, "proof-1"); w.Code != 500 {
		t.Fatalf("audit failure status %d", w.Code)
	}
	for _, table := range []string{"mapi_oauth_par", "mapi_fapi_policy_bindings", "par_audit", "par_assertions", "par_proofs"} {
		var count int
		if err := store.DB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("push rollback %s: %d %v", table, count, err)
		}
	}
	auditFails = false
	w := request(form, "proof-1")
	if w.Code != 201 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("PAR status %d", w.Code)
	}
	var response struct {
		RequestURI string `json:"request_uri"`
		ExpiresIn  int    `json:"expires_in"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || !strings.HasPrefix(response.RequestURI, parPrefix) || response.ExpiresIn != 60 {
		t.Fatal("invalid PAR response")
	}
	if w := request(form, "proof-1"); w.Code != 400 {
		t.Fatalf("assertion replay accepted: %d", w.Code)
	}
	wrongForm := url.Values{}
	for k, v := range form {
		wrongForm[k] = append([]string(nil), v...)
	}
	wrongForm.Set("client_assertion", "signed-2")
	wrongKey := sha256.Sum256([]byte("other DPoP key"))
	wrongForm.Set("dpop_jkt", base64.RawURLEncoding.EncodeToString(wrongKey[:]))
	if w := request(wrongForm, "proof-2"); w.Code != 400 {
		t.Fatalf("DPoP mismatch accepted: %d", w.Code)
	}
	var stored []byte
	if err := store.DB.QueryRow("SELECT handle_hash FROM mapi_oauth_par").Scan(&stored); err != nil || strings.Contains(string(stored), strings.TrimPrefix(response.RequestURI, parPrefix)) {
		t.Fatal("PAR handle not hashed")
	}
	begin := func(ctx context.Context, r PushedAuthorizationRequest) error {
		if r.DPoPJKT != jkt || r.ClientID != grant.ClientID || r.State != "state" {
			t.Error("incorrect request binding")
		}
		_, err := store.DB.ExecContext(ctx, "INSERT INTO par_login VALUES ('login')")
		return err
	}
	if err := p.Consume(ctx, "proj_other", grant.ClientID, response.RequestURI, begin); !errors.Is(err, ErrInvalidPAR) {
		t.Fatalf("wrong project: %v", err)
	}
	if err := p.Consume(ctx, grant.ProjectID, "other", response.RequestURI, begin); !errors.Is(err, ErrInvalidPAR) {
		t.Fatalf("wrong client: %v", err)
	}
	clientAllowed = false
	if err := p.Consume(ctx, grant.ProjectID, grant.ClientID, response.RequestURI, begin); !errors.Is(err, ErrInvalidClient) {
		t.Fatalf("revoked client: %v", err)
	}
	clientAllowed = true
	auditFails = true
	if err := p.Consume(ctx, grant.ProjectID, grant.ClientID, response.RequestURI, begin); err == nil {
		t.Fatal("consume audit failure committed")
	}
	var count int
	if err := store.DB.QueryRow("SELECT COUNT(*) FROM par_login").Scan(&count); err != nil || count != 0 {
		t.Fatal("login write survived rollback")
	}
	auditFails = false
	var successes atomic.Int32
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := p.Consume(ctx, grant.ProjectID, grant.ClientID, response.RequestURI, begin)
			if err == nil {
				successes.Add(1)
			} else if !errors.Is(err, ErrInvalidPAR) {
				t.Errorf("unexpected consume: %v", err)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("expected one PAR consume, got %d", successes.Load())
	}
	if err := store.DB.QueryRow("SELECT COUNT(*) FROM par_login").Scan(&count); err != nil || count != 1 {
		t.Fatal("expected exactly one login")
	}
	form.Set("client_assertion", "signed-expiry")
	w = request(form, "proof-expiry")
	if w.Code != 201 {
		t.Fatalf("expiry fixture: %d", w.Code)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if err := p.Consume(ctx, grant.ProjectID, grant.ClientID, response.RequestURI, begin); !errors.Is(err, ErrInvalidPAR) {
		t.Fatalf("expired PAR accepted: %v", err)
	}
	// FAPI clients may omit optional authorization-code DPoP binding; an
	// unfamiliar OAuth parameter is ignored, while duplicates and recognized
	// unsupported semantics fail closed.
	form.Set("client_assertion", "signed-optional")
	form.Del("dpop_jkt")
	form.Set("unknown_extension", "ignored")
	w = request(form, "")
	if w.Code != 201 {
		t.Fatalf("optional DPoP or unknown extension: %d", w.Code)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if err := p.Consume(ctx, grant.ProjectID, grant.ClientID, response.RequestURI, func(_ context.Context, r PushedAuthorizationRequest) error {
		if r.DPoPJKT != "" {
			t.Error("unexpected DPoP binding")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	form.Set("client_assertion", "signed-duplicate")
	form.Add("client_id", grant.ClientID)
	if w := request(form, ""); w.Code != 400 {
		t.Fatalf("duplicate parameter accepted: %d", w.Code)
	}
	form.Del("client_id")
	form.Set("client_id", grant.ClientID)
	form.Set("prompt", "none")
	if w := request(form, ""); w.Code != 400 {
		t.Fatalf("unsupported prompt accepted: %d", w.Code)
	}
	form.Del("prompt")
	form.Set("client_assertion", "unsigned")
	if w := request(form, ""); w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_client") {
		t.Fatalf("invalid client assertion accepted: %d", w.Code)
	}
	form.Set("client_assertion", "signed-missing-pkce")
	form.Del("code_challenge")
	if w := request(form, ""); w.Code != 400 {
		t.Fatalf("missing PKCE accepted: %d", w.Code)
	}
}

func TestPARHTTPRejectsUntrustedRequests(t *testing.T) {
	store, grant := fixture(t)
	p := PARStore{Store: store, ProjectID: grant.ProjectID, Endpoint: "https://issuer.example/par", TTL: time.Minute}
	r := httptest.NewRequest(http.MethodGet, p.Endpoint, nil)
	w := httptest.NewRecorder()
	(PARHTTP{PAR: p}).ServeHTTP(w, r)
	if w.Code != 405 || w.Header().Get("Allow") != "POST" {
		t.Fatal("wrong method accepted")
	}
	r = httptest.NewRequest(http.MethodPost, p.Endpoint, strings.NewReader(strings.Repeat("a", 65537)))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w = httptest.NewRecorder()
	(PARHTTP{PAR: p}).ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatalf("oversized form: %d", w.Code)
	}
	r = httptest.NewRequest(http.MethodPost, p.Endpoint, strings.NewReader("a=b"))
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	(PARHTTP{PAR: p}).ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("wrong content type: %d", w.Code)
	}
}
