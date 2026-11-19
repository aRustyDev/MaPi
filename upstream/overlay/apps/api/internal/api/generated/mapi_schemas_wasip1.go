//go:build wasip1 && mapi_schemas

package api

import "net/http"

// Uses the pinned generated decoders, authorization and response encoders.
func (s *Server) MountMaPiSchemas(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("POST "+prefix+"/schemas", func(w http.ResponseWriter, r *http.Request) { s.handlePublishSchemaRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/schemas", func(w http.ResponseWriter, r *http.Request) { s.handleListSchemasRequest([0]string{}, false, w, r) })
	mux.HandleFunc("GET "+prefix+"/schemas/{schema}", func(w http.ResponseWriter, r *http.Request) {
		s.handleGetSchemaRequest([1]string{r.PathValue("schema")}, false, w, r)
	})
}
