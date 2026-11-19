//go:build wasip1 && mapi_teams

package api

import "net/http"

func (s *Server) MountMaPiTeams(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("POST "+prefix+"/teams", func(w http.ResponseWriter, r *http.Request) { s.handleCreateTeamRequest([0]string{}, false, w, r) })
	mux.HandleFunc("POST "+prefix+"/teams/query", func(w http.ResponseWriter, r *http.Request) { s.handleQueryTeamsRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/teams/{team}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetTeamRequest([1]string{r.PathValue("team")}, false, w, r)
	})
	mux.HandleFunc("PATCH "+prefix+"/teams/{team}", func(w http.ResponseWriter, r *http.Request) {
		s.handleUpdateTeamRequest([1]string{r.PathValue("team")}, false, w, r)
	})
	mux.HandleFunc("DELETE "+prefix+"/teams/{team}", func(w http.ResponseWriter, r *http.Request) {
		s.handleDeactivateTeamRequest([1]string{r.PathValue("team")}, false, w, r)
	})
}
