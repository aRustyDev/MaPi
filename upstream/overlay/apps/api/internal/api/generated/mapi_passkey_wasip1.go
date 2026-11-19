//go:build wasip1 && mapi_passkey && !mapi_management && !mapi_account

package api

import "net/http"

// Test-only mounts retain upstream Ogen security and handler contracts.
func (s *Server) MountMaPiPasskey(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("POST "+prefix+"/users/{user}/passkeys/registrations", func(w http.ResponseWriter, r *http.Request) {
		s.handleCreateUserPasskeyRegistrationRequest([1]string{r.PathValue("user")}, false, w, r)
	})
	mux.HandleFunc("POST "+prefix+"/users/{user}/passkeys/registrations/{registration}", func(w http.ResponseWriter, r *http.Request) {
		s.handleCompleteUserPasskeyRegistrationRequest([2]string{r.PathValue("user"), r.PathValue("registration")}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/users/{user}/passkeys", func(w http.ResponseWriter, r *http.Request) {
		s.handleListUserPasskeysRequest([1]string{r.PathValue("user")}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/users/me/passkeys", func(w http.ResponseWriter, r *http.Request) { s.handleListMyPasskeysRequest([0]string{}, false, w, r) })
}
