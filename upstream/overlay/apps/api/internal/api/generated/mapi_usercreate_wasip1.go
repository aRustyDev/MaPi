//go:build wasip1 && mapi_usercreate && mapi_account && !mapi_management

package api

import "net/http"

// MountMaPiUserCreate is a local-only adapter using the upstream Ogen handler.
func (s *Server) MountMaPiUserCreate(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("POST "+prefix+"/users", func(w http.ResponseWriter, r *http.Request) {
		s.handleCreateUserRequest([0]string{}, false, w, r)
	})
}
