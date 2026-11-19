//go:build wasip1 && mapi_release_deployment

package api

import "net/http"

func (s *Server) MountMaPiReleaseDeployment(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("POST "+prefix+"/releases", func(w http.ResponseWriter, r *http.Request) { s.handleCreateReleaseRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/releases", func(w http.ResponseWriter, r *http.Request) { s.handleListReleasesRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/releases/{release}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetReleaseRequest([1]string{r.PathValue("release")}, false, w, r)
	})
	mux.HandleFunc("POST "+prefix+"/releases/{release}/revoke", func(w http.ResponseWriter, r *http.Request) {
		s.handleRevokeReleaseRequest([1]string{r.PathValue("release")}, false, w, r)
	})
	mux.HandleFunc("POST "+prefix+"/deployments", func(w http.ResponseWriter, r *http.Request) {
		s.handleCreateDeploymentRequest([0]string{}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/deployments", func(w http.ResponseWriter, r *http.Request) { s.handleListDeploymentsRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/deployments/{deployment}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetDeploymentRequest([1]string{r.PathValue("deployment")}, false, w, r)
	})
	mux.HandleFunc("GET "+prefix+"/deployments/{deployment}/variables", func(w http.ResponseWriter, r *http.Request) {
		s.handleListDeploymentVariablesRequest([1]string{r.PathValue("deployment")}, false, w, r)
	})
	mux.HandleFunc("POST "+prefix+"/deployments/{deployment}/rollback", func(w http.ResponseWriter, r *http.Request) {
		s.handleRollbackDeploymentRequest([1]string{r.PathValue("deployment")}, false, w, r)
	})
}
