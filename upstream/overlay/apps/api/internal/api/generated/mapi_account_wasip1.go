//go:build wasip1 && mapi_account && !mapi_management

package api

import "net/http"

// MountMaPiAccount is test-only opt-in. It uses upstream Ogen request
// decoders, security handlers and encoders; it does not provide ingress.
func (s *Server) MountMaPiAccount(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/users/me", func(w http.ResponseWriter, r *http.Request) { s.handleGetMyUserRequest([0]string{}, false, w, r) })
	mux.HandleFunc("PATCH "+prefix+"/users/me", func(w http.ResponseWriter, r *http.Request) { s.handleUpdateMyUserRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/users/me/password", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetMyPasswordStateRequest([0]string{}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/users/{user}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetUserRequest([1]string{r.PathValue("user")}, false, w, r)
	})
	mux.HandleFunc("PATCH "+prefix+"/users/{user}", func(w http.ResponseWriter, r *http.Request) {
		s.handleUpdateUserRequest([1]string{r.PathValue("user")}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/users/{user}/password", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetUserPasswordStateRequest([1]string{r.PathValue("user")}, false, w, r)
	})
	mux.HandleFunc("PUT "+prefix+"/users/{user}/password", func(w http.ResponseWriter, r *http.Request) {
		s.handleSetUserPasswordRequest([1]string{r.PathValue("user")}, false, w, r)
	})
}
