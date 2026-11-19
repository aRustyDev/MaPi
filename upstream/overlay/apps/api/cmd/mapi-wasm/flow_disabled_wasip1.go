//go:build wasip1 && !mapi_flow

package main

import (
	"github.com/zitadel/nextgen/internal/crypto"
	"github.com/zitadel/nextgen/internal/service"
)

func newFlowStack(_ *service.DB, _ service.KeyService, _ *crypto.HasherFactory, _ service.AuthAttemptService) (service.FlowService, service.ProjectService, error) {
	return nil, nil, nil
}
