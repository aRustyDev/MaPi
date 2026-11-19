// Package mapidpop provides an unmounted RFC 9449 proof verification core.
package mapidpop

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

var ErrInvalidProof = errors.New("invalid DPoP proof")
var ErrReplay = errors.New("DPoP proof replay")

// The caller must run Verify and its protected mutation in the same owning
// Durable Object transaction; Replay.Consume must not open another transaction.
type Replay interface {
	Consume(context.Context, string, string, [32]byte, int64, int64) error
}
type Options struct {
	ProjectID          string
	Method             string
	URL                string // trusted effective external request URL, never an untrusted forwarding header
	Nonce              string // required, issued and bound to this context by the caller
	AccessToken        string // required for a protected-resource proof; empty for the token endpoint
	ExpectedThumbprint string // required by the caller when redeeming a bound code or token
	Now                time.Time
	MaxAge             time.Duration
	FutureSkew         time.Duration
}
type Result struct{ Thumbprint string }

// InitReplaySchema installs only the proof-of-concept replay table. The
// caller owns migrations and schema verification when integrating it.
type Execer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func InitReplaySchema(ctx context.Context, db Execer) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_dpop_replay (
  project_id TEXT NOT NULL, jkt TEXT NOT NULL, jti_hash BLOB NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(project_id,jkt,jti_hash))`)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS mapi_dpop_replay_expiry ON mapi_dpop_replay (project_id, expires_at)`)
	return err
}

type ReplayDB interface {
	Execer
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type SQLReplay struct{ DB ReplayDB }

func (s SQLReplay) Consume(ctx context.Context, project, jkt string, jti [32]byte, expires, now int64) error {
	if s.DB == nil {
		return errors.New("missing replay database")
	}
	// A proof at its final allowed second must remain present until the next second.
	// Clear this exact expired key first; a bounded batch alone could otherwise
	// reject a fresh proof that reuses a jti after its prior replay window.
	if _, err := s.DB.ExecContext(ctx, `DELETE FROM mapi_dpop_replay WHERE project_id = ? AND jkt = ? AND jti_hash = ? AND expires_at <= ?`, project, jkt, jti[:], now); err != nil {
		return err
	}
	// Bound opportunistic work per authentication; production still needs a
	// rate limit, scheduled cleanup and storage monitoring.
	if _, err := s.DB.ExecContext(ctx, `DELETE FROM mapi_dpop_replay WHERE rowid IN (SELECT rowid FROM mapi_dpop_replay WHERE project_id = ? AND expires_at <= ? ORDER BY expires_at LIMIT 100)`, project, now); err != nil {
		return err
	}
	// DO rowsWritten can count index writes, so use RETURNING cardinality.
	var admitted string
	err := s.DB.QueryRowContext(ctx, `INSERT INTO mapi_dpop_replay (project_id,jkt,jti_hash,expires_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING RETURNING project_id`, project, jkt, jti[:], expires).Scan(&admitted)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrReplay
	}
	return err
}
func constant(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// Verify requires one compact JWS, an asymmetric public JWK and the selected
// local policy PS256, ES256 or EdDSA (Ed25519). No remote key reference is read.
func Verify(ctx context.Context, headers []string, opt Options, replay Replay) (Result, error) {
	invalid := func() (Result, error) { return Result{}, ErrInvalidProof }
	if len(headers) != 1 || len(headers[0]) == 0 || len(headers[0]) > 16384 || strings.ContainsAny(headers[0], " \t\r\n,") || replay == nil || opt.ProjectID == "" || opt.Method == "" || opt.Nonce == "" || len(opt.Nonce) > 512 || opt.Now.IsZero() || opt.MaxAge < time.Second || opt.MaxAge > 5*time.Minute || opt.FutureSkew < 0 || opt.FutureSkew > time.Minute {
		return invalid()
	}
	parts := strings.Split(headers[0], ".")
	if len(parts) != 3 {
		return invalid()
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || !uniqueJSON(header) {
		return invalid()
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(header, &raw) != nil {
		return invalid()
	}
	for _, forbidden := range []string{"crit", "b64", "jku", "x5u", "x5c"} {
		if _, ok := raw[forbidden]; ok {
			return invalid()
		}
	}
	var typ string
	if json.Unmarshal(raw["typ"], &typ) != nil || !strings.EqualFold(typ, "dpop+jwt") {
		return invalid()
	}
	var jwkObject map[string]json.RawMessage
	if json.Unmarshal(raw["jwk"], &jwkObject) != nil || jwkObject == nil {
		return invalid()
	}
	for _, secret := range []string{"d", "p", "q", "dp", "dq", "qi", "oth", "k"} {
		if _, ok := jwkObject[secret]; ok {
			return invalid()
		}
	}
	sig, err := jose.ParseSignedCompact(headers[0], []jose.SignatureAlgorithm{jose.PS256, jose.ES256, jose.EdDSA})
	if err != nil || len(sig.Signatures) != 1 {
		return invalid()
	}
	protected := sig.Signatures[0].Protected
	if protected.JSONWebKey == nil || !protected.JSONWebKey.IsPublic() || !protected.JSONWebKey.Valid() {
		return invalid()
	}
	switch key := protected.JSONWebKey.Key.(type) {
	case *rsa.PublicKey:
		if protected.Algorithm != string(jose.PS256) || key.N.BitLen() < 2048 || key.N.BitLen() > 8192 || key.N.Bit(0) == 0 || key.E < 3 || key.E%2 == 0 {
			return invalid()
		}
	case *ecdsa.PublicKey:
		if protected.Algorithm != string(jose.ES256) || key.Curve != elliptic.P256() {
			return invalid()
		}
	case ed25519.PublicKey:
		if protected.Algorithm != string(jose.EdDSA) {
			return invalid()
		}
	default:
		return invalid()
	}
	payload, err := sig.Verify(protected.JSONWebKey.Key)
	if err != nil || !uniqueJSON(payload) {
		return invalid()
	}
	var rawClaims map[string]json.RawMessage
	if json.Unmarshal(payload, &rawClaims) != nil || len(rawClaims["iat"]) == 0 || rawClaims["iat"][0] == '"' || string(rawClaims["iat"]) == "null" {
		return invalid()
	}
	var claims struct {
		JTI   string      `json:"jti"`
		HTM   string      `json:"htm"`
		HTU   string      `json:"htu"`
		IAT   json.Number `json:"iat"`
		Nonce string      `json:"nonce"`
		ATH   string      `json:"ath"`
	}
	dec := json.NewDecoder(strings.NewReader(string(payload)))
	dec.UseNumber()
	if dec.Decode(&claims) != nil || claims.JTI == "" || len(claims.JTI) > 256 || strings.ContainsAny(claims.JTI, "\x00\r\n") || claims.HTM != opt.Method || !constant(claims.Nonce, opt.Nonce) {
		return invalid()
	}
	claimURL, err := normalizeHTU(claims.HTU, true)
	if err != nil {
		return invalid()
	}
	requestURL, err := normalizeHTU(opt.URL, false)
	if err != nil || claimURL != requestURL {
		return invalid()
	}
	stamp, err := strconv.ParseFloat(string(claims.IAT), 64)
	if err != nil || math.IsNaN(stamp) || math.IsInf(stamp, 0) || stamp < 0 || stamp > 253402300799 {
		return invalid()
	}
	seconds, fraction := math.Modf(stamp)
	issued := time.Unix(int64(seconds), int64(fraction*1e9))
	if issued.Before(opt.Now.Add(-opt.MaxAge)) || issued.After(opt.Now.Add(opt.FutureSkew)) {
		return invalid()
	}
	// Optional JWT time constraints still apply when clients include them.
	// FAPI adapters allow exactly ten seconds of future clock skew.
	for _, name := range []string{"nbf", "exp"} {
		value, present := rawClaims[name]
		if !present {
			continue
		}
		if len(value) == 0 || value[0] == '"' || string(value) == "null" {
			return invalid()
		}
		number, err := strconv.ParseFloat(string(value), 64)
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > 253402300799 {
			return invalid()
		}
		whole, fraction := math.Modf(number)
		instant := time.Unix(int64(whole), int64(fraction*1e9))
		if name == "nbf" && instant.After(opt.Now.Add(opt.FutureSkew)) {
			return invalid()
		}
		if name == "exp" && !instant.After(opt.Now) {
			return invalid()
		}
	}
	if opt.AccessToken != "" {
		if opt.ExpectedThumbprint == "" {
			return invalid()
		}
		h := sha256.Sum256([]byte(opt.AccessToken))
		if !constant(claims.ATH, base64.RawURLEncoding.EncodeToString(h[:])) {
			return invalid()
		}
	}
	thumb, err := protected.JSONWebKey.Thumbprint(crypto.SHA256)
	if err != nil {
		return invalid()
	}
	jkt := base64.RawURLEncoding.EncodeToString(thumb)
	if opt.ExpectedThumbprint != "" && !constant(jkt, opt.ExpectedThumbprint) {
		return invalid()
	}
	// Floor-plus-one avoids deleting a replay record during the final accepted second.
	expiry := issued.Add(opt.MaxAge).Unix() + 1
	if err := replay.Consume(ctx, opt.ProjectID, jkt, sha256.Sum256([]byte(claims.JTI)), expiry, opt.Now.Unix()); err != nil {
		if errors.Is(err, ErrReplay) {
			return invalid()
		}
		return Result{}, fmt.Errorf("DPoP replay storage: %w", err)
	}
	return Result{Thumbprint: jkt}, nil
}

// uniqueJSON rejects duplicate object members at every nesting level.
func uniqueJSON(data []byte) bool {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if depth > 64 {
			return ErrInvalidProof
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return ErrInvalidProof
				}
				seen[name] = true
				if err := value(depth + 1); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim('}') {
				return ErrInvalidProof
			}
			return nil
		case '[':
			for decoder.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim(']') {
				return ErrInvalidProof
			}
			return nil
		default:
			return ErrInvalidProof
		}
	}
	if value(0) != nil {
		return false
	}
	_, err := decoder.Token()
	return errors.Is(err, io.EOF)
}

func normalizeHTU(raw string, claim bool) (string, error) {
	if claim && strings.ContainsAny(raw, "?#") {
		return "", ErrInvalidProof
	}
	u, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(u.Scheme, "https") || u.User != nil || u.Host == "" || u.Opaque != "" {
		return "", ErrInvalidProof
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || strings.Contains(host, "%") {
		return "", ErrInvalidProof
	}
	for _, r := range host {
		if r > 127 {
			return "", ErrInvalidProof
		}
	}
	port := u.Port()
	if port == "443" {
		port = ""
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	path, err = normalizePercent(path)
	if err != nil {
		return "", err
	}
	return "https://" + host + removeDotSegments(path), nil
}
func normalizePercent(path string) (string, error) {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(path); i++ {
		if path[i] != '%' {
			b.WriteByte(path[i])
			continue
		}
		if i+2 >= len(path) {
			return "", ErrInvalidProof
		}
		n, err := strconv.ParseUint(path[i+1:i+3], 16, 8)
		if err != nil {
			return "", ErrInvalidProof
		}
		c := byte(n)
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", rune(c)) {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
		i += 2
	}
	return b.String(), nil
}
func removeDotSegments(input string) string {
	output := ""
	for input != "" {
		switch {
		case strings.HasPrefix(input, "../"):
			input = input[3:]
		case strings.HasPrefix(input, "./"):
			input = input[2:]
		case strings.HasPrefix(input, "/./"):
			input = input[2:]
		case input == "/.":
			input = "/"
		case strings.HasPrefix(input, "/../"):
			input = input[3:]
			if i := strings.LastIndex(output, "/"); i >= 0 {
				output = output[:i]
			} else {
				output = ""
			}
		case input == "/..":
			input = "/"
			if i := strings.LastIndex(output, "/"); i >= 0 {
				output = output[:i]
			} else {
				output = ""
			}
		case input == "." || input == "..":
			input = ""
		default:
			n := len(input)
			start := 0
			if input[0] == '/' {
				start = 1
			}
			if i := strings.IndexByte(input[start:], '/'); i >= 0 {
				n = start + i
			}
			output += input[:n]
			input = input[n:]
		}
	}
	if output == "" {
		return "/"
	}
	return output
}
