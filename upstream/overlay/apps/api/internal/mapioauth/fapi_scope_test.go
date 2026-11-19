package mapioauth

import (
	"testing"
)

func TestFAPIResourceScopesAreClientScoped(t *testing.T) {
	for _, tc := range []struct {
		input, want string
		valid       bool
	}{{"openid payments.read offline_access", "openid offline_access payments.read", true}, {"openid", "openid", true}, {"payments.read", "", false}, {"openid openid", "", false}, {"openid\tpayments.read", "", false}, {"openid bad\\scope", "", false}, {"openid bad\"scope", "", false}} {
		got, err := canonicalFAPIScopes(tc.input)
		if (err == nil) != tc.valid || got != tc.want {
			t.Errorf("scope %q got %q err %v", tc.input, got, err)
		}
	}
	if got, err := canonicalFAPIRefreshScopes("payments.read offline_access"); err != nil || got != "offline_access payments.read" {
		t.Fatal("refresh scope subset without openid rejected")
	}

}
