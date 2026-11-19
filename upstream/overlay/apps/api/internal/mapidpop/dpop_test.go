package mapidpop

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	_ "modernc.org/sqlite"
)

func sign(t *testing.T, key *ecdsa.PrivateKey, claims map[string]any, typ string, public bool) string {
	t.Helper()
	material := any(&key.PublicKey)
	if !public {
		material = key
	}
	opts := (&jose.SignerOptions{}).WithHeader("typ", typ).WithHeader("jwk", jose.JSONWebKey{Key: material})
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, opts)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := signer.Sign(data)
	if err != nil {
		t.Fatal(err)
	}
	compact, err := signature.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return compact
}
func testOptions() Options {
	return Options{ProjectID: "proj_a", Method: "POST", URL: "https://example.test/token?x=1", Nonce: "server-nonce", Now: time.Unix(1700000000, 0), MaxAge: time.Minute, FutureSkew: 5 * time.Second}
}
func claims() map[string]any {
	return map[string]any{"jti": "proof-1", "htm": "POST", "htu": "https://example.test/token", "iat": 1700000000, "nonce": "server-nonce"}
}
func dbForTest(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	if err = InitReplaySchema(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return db
}
func verify(t *testing.T, db *sql.DB, proof string, opt Options) (Result, error) {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	result, err := Verify(context.Background(), []string{proof}, opt, SQLReplay{DB: tx})
	if err == nil {
		if err = tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	return result, err
}
func TestProofAndAtomicReplay(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	db := dbForTest(t)
	opt := testOptions()
	proof := sign(t, key, claims(), "dpop+jwt", true)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Verify(context.Background(), []string{proof}, opt, SQLReplay{DB: tx}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	result, err := verify(t, db, proof, opt)
	if err != nil {
		t.Fatal(err)
	}
	if result.Thumbprint == "" {
		t.Fatal("missing thumbprint")
	}
	if _, err = verify(t, db, proof, opt); !errors.Is(err, ErrInvalidProof) {
		t.Fatalf("replay: %v", err)
	}
	opt.ProjectID = "proj_b"
	if _, err = verify(t, db, proof, opt); err != nil {
		t.Fatalf("project isolation: %v", err)
	}
}
func TestProofValidation(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	base := claims()
	token := "access-token"
	h := sha256.Sum256([]byte(token))
	jktBytes, _ := (&jose.JSONWebKey{Key: &key.PublicKey}).Thumbprint(crypto.SHA256)
	jkt := base64.RawURLEncoding.EncodeToString(jktBytes)
	cases := []struct {
		name     string
		mutate   func(map[string]any, *Options)
		typ      string
		public   bool
		otherKey bool
		wantOK   bool
	}{
		{"valid", nil, "dpop+jwt", true, false, true}, {"bad type", nil, "JWT", true, false, false}, {"private JWK", nil, "dpop+jwt", false, false, false},
		{"wrong method", func(c map[string]any, o *Options) { c["htm"] = "GET" }, "dpop+jwt", true, false, false},
		{"wrong URI", func(c map[string]any, o *Options) { c["htu"] = "https://other.test/token" }, "dpop+jwt", true, false, false},
		{"claim query", func(c map[string]any, o *Options) { c["htu"] = "https://example.test/token?x=1" }, "dpop+jwt", true, false, true},
		{"claim fragment", func(c map[string]any, o *Options) { c["htu"] = "https://example.test/token#ignored" }, "dpop+jwt", true, false, true},
		{"query cannot hide wrong host", func(c map[string]any, o *Options) { c["htu"] = "https://other.test/token?https://example.test/token" }, "dpop+jwt", true, false, false},
		{"fragment cannot hide wrong path", func(c map[string]any, o *Options) { c["htu"] = "https://example.test/other#token" }, "dpop+jwt", true, false, false},
		{"normalization", func(c map[string]any, o *Options) { c["htu"] = "https://EXAMPLE.test:443/a/../%74oken" }, "dpop+jwt", true, false, true},
		{"encoded slash distinct", func(c map[string]any, o *Options) { c["htu"] = "https://example.test%2ftoken" }, "dpop+jwt", true, false, false},
		{"old", func(c map[string]any, o *Options) { c["iat"] = 1699999939 }, "dpop+jwt", true, false, false},
		{"future", func(c map[string]any, o *Options) { c["iat"] = 1700000006 }, "dpop+jwt", true, false, false},
		{"FAPI future ten seconds", func(c map[string]any, o *Options) { o.FutureSkew = 10 * time.Second; c["iat"] = 1700000010 }, "dpop+jwt", true, false, true},
		{"FAPI future eleven seconds", func(c map[string]any, o *Options) { o.FutureSkew = 10 * time.Second; c["iat"] = 1700000011 }, "dpop+jwt", true, false, false},
		{"FAPI nbf ten seconds", func(c map[string]any, o *Options) { o.FutureSkew = 10 * time.Second; c["nbf"] = 1700000010 }, "dpop+jwt", true, false, true},
		{"FAPI nbf eleven seconds", func(c map[string]any, o *Options) { o.FutureSkew = 10 * time.Second; c["nbf"] = 1700000011 }, "dpop+jwt", true, false, false},
		{"invalid nbf string", func(c map[string]any, o *Options) { c["nbf"] = "1700000000" }, "dpop+jwt", true, false, false},
		{"expired exp", func(c map[string]any, o *Options) { c["exp"] = 1700000000 }, "dpop+jwt", true, false, false},
		{"future exp", func(c map[string]any, o *Options) { c["exp"] = 1700000001 }, "dpop+jwt", true, false, true},
		{"fractional time", func(c map[string]any, o *Options) { c["iat"] = 1700000000.5 }, "dpop+jwt", true, false, true},
		{"string time", func(c map[string]any, o *Options) { c["iat"] = "1700000000" }, "dpop+jwt", true, false, false},
		{"bad nonce", func(c map[string]any, o *Options) { c["nonce"] = "wrong" }, "dpop+jwt", true, false, false},
		{"empty nonce policy", func(c map[string]any, o *Options) { o.Nonce = "" }, "dpop+jwt", true, false, false},
		{"ath success", func(c map[string]any, o *Options) {
			c["ath"] = base64.RawURLEncoding.EncodeToString(h[:])
			o.AccessToken = token
			o.ExpectedThumbprint = jkt
		}, "dpop+jwt", true, false, true},
		{"ath missing", func(c map[string]any, o *Options) { o.AccessToken = token; o.ExpectedThumbprint = jkt }, "dpop+jwt", true, false, false},
		{"unbound access token", func(c map[string]any, o *Options) {
			c["ath"] = base64.RawURLEncoding.EncodeToString(h[:])
			o.AccessToken = token
		}, "dpop+jwt", true, false, false},
		{"wrong thumbprint", func(c map[string]any, o *Options) { o.ExpectedThumbprint = jkt }, "dpop+jwt", true, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := dbForTest(t)
			c := map[string]any{}
			for k, v := range base {
				c[k] = v
			}
			o := testOptions()
			if tc.mutate != nil {
				tc.mutate(c, &o)
			}
			k := key
			if tc.otherKey {
				k = other
			}
			_, err := verify(t, db, sign(t, k, c, tc.typ, tc.public), o)
			if (err == nil) != tc.wantOK {
				t.Fatalf("want success=%v got %v", tc.wantOK, err)
			}
		})
	}
}
func TestHTUNormalization(t *testing.T) {
	cases := []struct {
		in, want string
		fail     bool
	}{
		{"https://EXAMPLE.test:443/a/../%74oken?foo=bar", "https://example.test/token", false},
		{"https://example.test//a/./b/../", "https://example.test//a/", false},
		{"https://example.test/a%2Fb", "https://example.test/a%2Fb", false},
		{"https://example.test/a?x=1#fragment", "https://example.test/a", false}, {"http://example.test/a", "", true},
	}
	for _, tc := range cases {
		got, err := normalizeHTU(tc.in)
		if (err != nil) != tc.fail || got != tc.want {
			t.Errorf("%q => %q %v", tc.in, got, err)
		}
	}
}
func TestDuplicateJSONAndHeaderCount(t *testing.T) {
	if uniqueJSON([]byte(`{"jti":"a","jti":"b"}`)) || uniqueJSON([]byte(`{"jwk":{"x":"a","x":"b"}}`)) || uniqueJSON([]byte(strings.Repeat("[", 70)+"0"+strings.Repeat("]", 70))) || !uniqueJSON([]byte(`{"one":[{"x":1}]}`)) {
		t.Fatal("duplicate detection")
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p := sign(t, key, claims(), "dpop+jwt", true)
	db := dbForTest(t)
	for _, headers := range [][]string{nil, {p, p}, {p + "," + p}, {strings.Repeat("a", 16385)}} {
		if _, err := Verify(context.Background(), headers, testOptions(), SQLReplay{DB: db}); !errors.Is(err, ErrInvalidProof) {
			t.Fatal(fmt.Sprint("accepted invalid header count/format: ", err))
		}
	}
}

func TestOtherAllowedAsymmetricAlgorithms(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		alg     jose.SignatureAlgorithm
		private any
		public  any
	}{{"PS256", jose.PS256, rsaKey, &rsaKey.PublicKey}, {"EdDSA", jose.EdDSA, private, pub}} {
		t.Run(tc.name, func(t *testing.T) {
			signer, err := jose.NewSigner(jose.SigningKey{Algorithm: tc.alg, Key: tc.private}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", jose.JSONWebKey{Key: tc.public}))
			if err != nil {
				t.Fatal(err)
			}
			payload, _ := json.Marshal(claims())
			signed, err := signer.Sign(payload)
			if err != nil {
				t.Fatal(err)
			}
			proof, err := signed.CompactSerialize()
			if err != nil {
				t.Fatal(err)
			}
			if _, err = verify(t, dbForTest(t), proof, testOptions()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRejectTamperingAndSymmetricProof(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	proof := sign(t, key, claims(), "dpop+jwt", true)
	parts := strings.Split(proof, ".")
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	sig[0] ^= 1
	parts[2] = base64.RawURLEncoding.EncodeToString(sig)
	if _, err = verify(t, dbForTest(t), strings.Join(parts, "."), testOptions()); !errors.Is(err, ErrInvalidProof) {
		t.Fatalf("altered signature: %v", err)
	}
	shared := []byte("synthetic shared key synthetic shared key")
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.HS256, Key: shared}, (&jose.SignerOptions{}).WithHeader("typ", "dpop+jwt").WithHeader("jwk", jose.JSONWebKey{Key: shared}))
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(claims())
	signed, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	symmetric, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = verify(t, dbForTest(t), symmetric, testOptions()); !errors.Is(err, ErrInvalidProof) {
		t.Fatalf("symmetric key accepted: %v", err)
	}
}
func TestReplayExpirationBoundary(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	db := dbForTest(t)
	opt := testOptions()
	opt.Now = opt.Now.Add(time.Minute)
	proof := sign(t, key, claims(), "dpop+jwt", true)
	if _, err = verify(t, db, proof, opt); err != nil {
		t.Fatal(err)
	}
	if _, err = verify(t, db, proof, opt); !errors.Is(err, ErrInvalidProof) {
		t.Fatalf("final-second replay accepted: %v", err)
	}
	opt.Now = opt.Now.Add(time.Second)
	if _, err = verify(t, db, proof, opt); !errors.Is(err, ErrInvalidProof) {
		t.Fatalf("expired proof accepted: %v", err)
	}
}

func TestReplayCleanupIsBoundedAndProjectScoped(t *testing.T) {
	db := dbForTest(t)
	ctx := context.Background()
	for i := 0; i < 250; i++ {
		hash := sha256.Sum256([]byte(fmt.Sprintf("old-%d", i)))
		if _, err := db.Exec(`INSERT INTO mapi_dpop_replay VALUES (?,?,?,?)`, "proj_a", "key", hash[:], 1); err != nil {
			t.Fatal(err)
		}
	}
	other := sha256.Sum256([]byte("other"))
	if _, err := db.Exec(`INSERT INTO mapi_dpop_replay VALUES (?,?,?,?)`, "proj_b", "key", other[:], 1); err != nil {
		t.Fatal(err)
	}
	fresh := sha256.Sum256([]byte("fresh"))
	if err := (SQLReplay{DB: db}).Consume(ctx, "proj_a", "key", fresh, 100, 2); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM mapi_dpop_replay WHERE project_id='proj_a' AND expires_at=1`).Scan(&n); err != nil || n != 150 {
		t.Fatalf("cleanup not bounded: %d %v", n, err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM mapi_dpop_replay WHERE project_id='proj_b'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("other project affected: %d %v", n, err)
	}
	var reused []byte
	if err := db.QueryRow(`SELECT jti_hash FROM mapi_dpop_replay WHERE project_id='proj_a' AND expires_at=1 LIMIT 1`).Scan(&reused); err != nil {
		t.Fatal(err)
	}
	var id [32]byte
	copy(id[:], reused)
	if err := (SQLReplay{DB: db}).Consume(ctx, "proj_a", "key", id, 100, 2); err != nil {
		t.Fatalf("expired exact-key reuse: %v", err)
	}
}
