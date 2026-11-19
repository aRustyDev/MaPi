package mapioauth

import (
	"slices"
	"strings"
)

// OAuth scope-token is restricted to printable ASCII excluding space, quote
// and backslash. Custom scopes require an authoritative client policy.
func validFAPIScopeToken(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if r < 0x21 || r > 0x7e || r == 0x22 || r == 0x5c {
			return false
		}
	}
	return true
}
func canonicalFAPIScopes(raw string) (string, error) {
	if len(raw) > 2048 {
		return "", ErrInvalidPAR
	}
	for _, r := range raw {
		if r != ' ' && (r < 0x21 || r > 0x7e || r == 0x22 || r == 0x5c) {
			return "", ErrInvalidPAR
		}
	}
	fields := strings.Fields(raw)
	if len(fields) == 0 || len(fields) > 20 {
		return "", ErrInvalidPAR
	}
	seen := map[string]bool{}
	extras := []string{}
	for _, scope := range fields {
		if !validFAPIScopeToken(scope) || seen[scope] {
			return "", ErrInvalidPAR
		}
		seen[scope] = true
		if scope != "openid" && scope != "offline_access" {
			extras = append(extras, scope)
		}
	}
	if !seen["openid"] {
		return "", ErrInvalidPAR
	}
	slices.Sort(extras)
	result := []string{"openid"}
	if seen["offline_access"] {
		result = append(result, "offline_access")
	}
	result = append(result, extras...)
	return strings.Join(result, " "), nil
}
