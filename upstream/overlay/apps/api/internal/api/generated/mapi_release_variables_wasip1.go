//go:build wasip1 && mapi_release_variables

package api

import "net/http"

func (s *Server) MountMaPiReleaseVariables(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/variables", func(w http.ResponseWriter, r *http.Request) { s.handleListVariablesRequest([0]string{}, false, w, r) })
	mux.HandleFunc("PATCH "+prefix+"/variables", func(w http.ResponseWriter, r *http.Request) { s.handleSetVariablesRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/variables/{variable}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetVariableRequest([1]string{r.PathValue("variable")}, false, w, r)
	})
	mux.HandleFunc("DELETE "+prefix+"/variables/{variable}", func(w http.ResponseWriter, r *http.Request) {
		s.handleDeleteVariableRequest([1]string{r.PathValue("variable")}, false, w, r)
	})
}
