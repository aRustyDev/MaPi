//go:build wasip1 && mapi_invitations

package api

import "net/http"

func (s *Server) MountMaPiInvitations(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("POST "+prefix+"/invitations", func(w http.ResponseWriter, r *http.Request) {
		s.handleCreateInvitationRequest([0]string{}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/invitations", func(w http.ResponseWriter, r *http.Request) { s.handleListInvitationsRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/invitations/{invitation}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetInvitationRequest([1]string{r.PathValue("invitation")}, false, w, r)
	})
	mux.HandleFunc("DELETE "+prefix+"/invitations/{invitation}", func(w http.ResponseWriter, r *http.Request) {
		s.handleCancelInvitationRequest([1]string{r.PathValue("invitation")}, false, w, r)
	})
}
