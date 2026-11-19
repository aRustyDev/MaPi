package mapioauth

import (
	"encoding/json"
	"errors"
	"mime"
	"net/http"
)

// PARHTTP is deliberately not mounted. The Worker must apply origin admission,
// abuse limits and TLS before routing here; real authentication and DPoP hooks
// are mandatory before any profile can be advertised.
type PARHTTP struct{ PAR PARStore }

func (h PARHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Type", "application/json")
	writeError := func(status int, code string) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(http.StatusMethodNotAllowed, "invalid_request")
		return
	}
	contentType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/x-www-form-urlencoded" || (params["charset"] != "" && params["charset"] != "UTF-8" && params["charset"] != "utf-8") {
		writeError(http.StatusBadRequest, "invalid_request")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 65536)
	if err := r.ParseForm(); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(http.StatusRequestEntityTooLarge, "invalid_request")
		} else {
			writeError(http.StatusBadRequest, "invalid_request")
		}
		return
	}
	requestURI, err := h.PAR.Push(r.Context(), r, r.PostForm)
	switch {
	case errors.Is(err, ErrInvalidClient):
		writeError(http.StatusBadRequest, "invalid_client")
	case errors.Is(err, ErrInvalidDPoP):
		writeError(http.StatusBadRequest, "invalid_dpop_proof")
	case errors.Is(err, ErrInvalidPAR):
		writeError(http.StatusBadRequest, "invalid_request")
	case err != nil:
		writeError(http.StatusInternalServerError, "server_error")
	default:
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"request_uri": requestURI, "expires_in": int(h.PAR.TTL.Seconds())})
	}
}
