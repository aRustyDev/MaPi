//go:build wasip1 && mapi_self && !mapi_account && !mapi_management && !mapi_passkey

package api

import "net/http"

func (s *Server) MountMaPiSelf(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/users/me/schema", func(w http.ResponseWriter, r *http.Request) { s.handleGetMyUserSchemaRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/users/me/teams", func(w http.ResponseWriter, r *http.Request) { s.handleListMyTeamsRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/users/me/identity_links", func(w http.ResponseWriter, r *http.Request) {
		s.handleListMyIdentityLinksRequest([0]string{}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/users/{user}/teams", func(w http.ResponseWriter, r *http.Request) {
		s.handleListUserTeamsRequest([1]string{r.PathValue("user")}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/users/{user}/identity_links", func(w http.ResponseWriter, r *http.Request) {
		s.handleListUserIdentityLinksRequest([1]string{r.PathValue("user")}, false, w, r)
	})
}
