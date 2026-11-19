//go:build wasip1 && mapi_session_extra

package api

import "net/http"

// MountMaPiSessionExtra is only linked into the isolated parity test build.
func (s *Server) MountMaPiSessionExtra(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("POST "+prefix+"/sessions", func(w http.ResponseWriter, r *http.Request) {
		s.handleCreateSessionRequest([0]string{}, false, w, r)
	})
	mux.HandleFunc("POST "+prefix+"/sessions/query", func(w http.ResponseWriter, r *http.Request) {
		s.handleQuerySessionsRequest([0]string{}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/sessions/{session}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetSessionRequest([1]string{r.PathValue("session")}, false, w, r)
	})
}
