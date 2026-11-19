package api

import "net/http"

// MountMaPi uses the pinned Ogen operation handlers and their generated
// validation, security, and response encoders for the prototype route set.
func (s *Server) MountMaPi(mux *http.ServeMux, prefix string) {
	mount := func(method, path string, h http.HandlerFunc) {
		mux.HandleFunc(method+" "+prefix+path, h)
	}
	mount("GET", "/livez", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetLiveRequest([0]string{}, false, w, r)
	})
	mount("GET", "/readyz", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetReadyRequest([0]string{}, false, w, r)
	})
	mount("POST", "/flows", func(w http.ResponseWriter, r *http.Request) {
		s.handleCreateFlowRequest([0]string{}, false, w, r)
	})
	mount("GET", "/flows/{flow}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetFlowStepRequest([1]string{r.PathValue("flow")}, false, w, r)
	})
	mount("POST", "/flows/{flow}/submit", func(w http.ResponseWriter, r *http.Request) {
		s.handleSubmitFlowStepRequest([1]string{r.PathValue("flow")}, false, w, r)
	})
	mount("POST", "/auth_attempts", func(w http.ResponseWriter, r *http.Request) {
		s.handleCreateAuthAttemptRequest([0]string{}, false, w, r)
	})
	mount("POST", "/auth_attempts/{attempt}/challenges", func(w http.ResponseWriter, r *http.Request) {
		s.handleCreateAuthAttemptChallengeRequest([1]string{r.PathValue("attempt")}, false, w, r)
	})
	mount("POST", "/auth_attempts/{attempt}/challenges/{challenge}/verify", func(w http.ResponseWriter, r *http.Request) {
		s.handleVerifyAuthAttemptChallengeRequest([2]string{r.PathValue("attempt"), r.PathValue("challenge")}, false, w, r)
	})
	mount("POST", "/auth_attempts/{attempt}/handoff", func(w http.ResponseWriter, r *http.Request) {
		s.handleCreateAuthAttemptHandoffRequest([1]string{r.PathValue("attempt")}, false, w, r)
	})
	mount("POST", "/sessions/exchange", func(w http.ResponseWriter, r *http.Request) {
		s.handleExchangeHandoffRequest([0]string{}, false, w, r)
	})
	mount("GET", "/sessions/me", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetMySessionRequest([0]string{}, false, w, r)
	})
	mount("GET", "/sessions/me/csrf", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetMySessionCsrfTokenRequest([0]string{}, false, w, r)
	})
	mount("DELETE", "/sessions/me", func(w http.ResponseWriter, r *http.Request) {
		s.handleRevokeMySessionRequest([0]string{}, false, w, r)
	})
	mount("DELETE", "/sessions/{session}", func(w http.ResponseWriter, r *http.Request) {
		s.handleRevokeSessionRequest([1]string{r.PathValue("session")}, false, w, r)
	})
}
