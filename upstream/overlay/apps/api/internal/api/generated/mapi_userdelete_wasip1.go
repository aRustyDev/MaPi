//go:build wasip1 && mapi_userdelete && !mapi_account && !mapi_management

package api

import "net/http"

func (s *Server) MountMaPiUserDelete(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("DELETE "+prefix+"/users/{user}", func(w http.ResponseWriter, r *http.Request) {
		s.handleDeleteUserRequest([1]string{r.PathValue("user")}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/users/{user}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetUserRequest([1]string{r.PathValue("user")}, false, w, r)
	})
}
