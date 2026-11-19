//go:build wasip1 && mapi_usercreate && mapi_account && !mapi_management

package api

import (
	"context"
	"net/http"

	generated "github.com/zitadel/nextgen/internal/api/generated"
	"github.com/zitadel/nextgen/internal/domain"
)

// The account build supplies the original UserService, policy and schema stores.
func configureMaPiUserCreate(server *generated.Server, mux *http.ServeMux) {
	server.MountMaPiUserCreate(mux, "")
	server.MountMaPiUserCreate(mux, "/api/v1")
}

func (r cloudflareRoutes) CreateUser(ctx context.Context, req *generated.CreateUserRequest, p generated.CreateUserParams) (generated.CreateUserRes, error) {
	if !r.inProject(ctx) || string(p.ProjectID) != r.projectID {
		return nil, domain.ErrAuthUnauthorized(nil)
	}
	return r.handler.CreateUser(ctx, req, p)
}
