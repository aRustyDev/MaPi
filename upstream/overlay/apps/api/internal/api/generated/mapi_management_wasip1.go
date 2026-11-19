//go:build wasip1 && mapi_management

package api

import "net/http"

// MountMaPiManagement invokes the same Ogen decoders, security handlers, and
// response encoders used by upstream; ingress must still enforce project routing.
func (s *Server) MountMaPiManagement(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("POST "+prefix+"/users/query", func(w http.ResponseWriter, r *http.Request) { s.handleQueryUsersRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/users/{user}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetUserRequest([1]string{r.PathValue("user")}, false, w, r)
	})
}
