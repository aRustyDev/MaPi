//go:build mapi_oauth

package api

import (
	"encoding/json"
	"errors"

	api "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/service"
)

// MaPiFlowDefinitionRequest decodes the pinned public flow definition shape
// and applies the same generated validation and mapping as the upstream API.
func MaPiFlowDefinitionRequest(projectID string, document []byte) (service.FlowDefinitionRequest, error) {
	if projectID == "" || len(document) == 0 || len(document) > 65536 {
		return service.FlowDefinitionRequest{}, errors.New("invalid flow definition size")
	}
	wrapped, err := json.Marshal(struct {
		ProjectID  string          `json:"project_id"`
		Definition json.RawMessage `json:"flow_definition"`
	}{projectID, document})
	if err != nil {
		return service.FlowDefinitionRequest{}, err
	}
	var req api.CreateFlowDefinitionRequest
	if err = req.UnmarshalJSON(wrapped); err != nil {
		return service.FlowDefinitionRequest{}, err
	}
	if err = req.Validate(); err != nil {
		return service.FlowDefinitionRequest{}, err
	}
	return mapCreateRequestToService(&req)
}
