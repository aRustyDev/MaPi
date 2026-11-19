//go:build wasip1 && mapi_events

package api

import "net/http"

// MountMaPiEvents retains the pinned generated decoder and security handling.
func (s *Server) MountMaPiEvents(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"/events", func(w http.ResponseWriter, r *http.Request) { s.handleListEventsRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/events/{event}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetEventRequest([1]string{r.PathValue("event")}, false, w, r)
	})
}
