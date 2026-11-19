package mapioauth

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
)

// assertionClientHint extracts only an untrusted lookup candidate. It does
// not authenticate: callers must still verify the assertion signature, project,
// issuer/subject, audience, expiry and replay in the authoritative transaction.
func assertionClientHint(form url.Values) (string, error) {
	raw := form.Get("client_assertion")
	if raw == "" || len(raw) > 16384 {
		return "", ErrInvalidClient
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return "", ErrInvalidClient
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(payload) > 8192 {
		return "", ErrInvalidClient
	}
	object, err := strictObject(payload)
	if err != nil {
		return "", ErrInvalidClient
	}
	var issuer, subject string
	if json.Unmarshal(object["iss"], &issuer) != nil || json.Unmarshal(object["sub"], &subject) != nil || issuer == "" || len(issuer) > 512 || issuer != subject {
		return "", ErrInvalidClient
	}
	if values, present := form["client_id"]; present && (len(values) != 1 || values[0] == "" || values[0] != issuer) {
		return "", ErrInvalidClient
	}
	return issuer, nil
}
