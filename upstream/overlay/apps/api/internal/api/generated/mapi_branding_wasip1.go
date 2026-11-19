//go:build wasip1 && mapi_branding

package api

import "net/http"

// Uses pinned Ogen request, authorization, and response handling.
func (s *Server) MountMaPiBranding(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("POST "+prefix+"/branding", func(w http.ResponseWriter, r *http.Request) { s.handlePublishBrandingRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/branding", func(w http.ResponseWriter, r *http.Request) { s.handleListBrandingRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/branding/{branding}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetBrandingRequest([1]string{r.PathValue("branding")}, false, w, r)
	})
}
