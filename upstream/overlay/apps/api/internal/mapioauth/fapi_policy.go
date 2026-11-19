package mapioauth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strings"
)

var ErrFAPIPolicyConflict = errors.New("FAPI resource policy version conflict")
var ErrFAPIPolicyDenied = errors.New("FAPI resource policy unavailable")

type FAPIClientPolicy struct {
	ProjectID, ClientID, Audience string
	Scopes                        []string
	Enabled                       bool
	Version                       int64
}
type FAPIResourcePolicies struct {
	Store     Store
	ProjectID string
	Registry  ClientRegistry
	Audit     func(context.Context, FAPIClientPolicy) error
}

func (p FAPIResourcePolicies) CreateSchema(ctx context.Context) error {
	if p.Store.DB == nil {
		return errors.New("FAPI policy database not configured")
	}
	_, err := p.Store.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_fapi_client_policy (project_id TEXT NOT NULL,client_id TEXT NOT NULL,audience TEXT NOT NULL,scopes TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),version INTEGER NOT NULL CHECK(version>0),PRIMARY KEY(project_id,client_id))`)
	return err
}

func (p FAPIResourcePolicies) valid() bool {
	return p.Store.DB != nil && p.Store.Transaction != nil && p.ProjectID != "" && p.Registry.Statements != nil && p.Audit != nil
}
func validFAPIAudience(value string) bool {
	if len(value) == 0 || len(value) > 2048 {
		return false
	}
	for _, r := range value {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}
func policyScopes(scopes []string) ([]string, error) {
	if len(scopes) > 20 {
		return nil, errors.New("too many resource scopes")
	}
	out := slices.Clone(scopes)
	seen := map[string]bool{}
	for _, scope := range out {
		if !validFAPIScopeToken(scope) || scope == "openid" || scope == "offline_access" || seen[scope] {
			return nil, errors.New("invalid resource scope")
		}
		seen[scope] = true
	}
	slices.Sort(out)
	return out, nil
}

// Put uses expectedVersion=0 only for creation. Updates require the exact
// current version; conflict, failed audit and failed client lookup leave no
// partial policy. Callers authenticate operators before invoking this API.
func (p FAPIResourcePolicies) Put(ctx context.Context, clientID, audience string, scopes []string, enabled bool, expectedVersion int64) (FAPIClientPolicy, error) {
	if !p.valid() || clientID == "" || len(clientID) > 512 || !validFAPIAudience(audience) || expectedVersion < 0 || expectedVersion == math.MaxInt64 {
		return FAPIClientPolicy{}, errors.New("FAPI resource policy invalid")
	}
	normalized, err := policyScopes(scopes)
	if err != nil {
		return FAPIClientPolicy{}, err
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return FAPIClientPolicy{}, err
	}
	result := FAPIClientPolicy{ProjectID: p.ProjectID, ClientID: clientID, Audience: audience, Scopes: normalized, Enabled: enabled, Version: expectedVersion + 1}
	err = p.Store.Transaction(func() error {
		if _, err := p.Registry.Lookup(ctx, p.ProjectID, clientID); err != nil {
			return err
		}
		var version int64
		if expectedVersion == 0 {
			err = p.Store.DB.QueryRowContext(ctx, `INSERT INTO mapi_fapi_client_policy(project_id,client_id,audience,scopes,enabled,version) VALUES(?,?,?,?,?,1) ON CONFLICT DO NOTHING RETURNING version`, p.ProjectID, clientID, audience, string(encoded), enabled).Scan(&version)
		} else {
			err = p.Store.DB.QueryRowContext(ctx, `UPDATE mapi_fapi_client_policy SET audience=?,scopes=?,enabled=?,version=version+1 WHERE project_id=? AND client_id=? AND version=? RETURNING version`, audience, string(encoded), enabled, p.ProjectID, clientID, expectedVersion).Scan(&version)
		}
		if errors.Is(err, sql.ErrNoRows) {
			return ErrFAPIPolicyConflict
		}
		if err != nil {
			return err
		}
		if version != result.Version {
			return errors.New("unexpected policy version")
		}
		return p.Audit(ctx, result)
	})
	if err != nil {
		return FAPIClientPolicy{}, err
	}
	return result, nil
}

// Get is an administrative read. Call within an authoritative transaction
// when its result controls authorization. Disabled rows remain visible.
func (p FAPIResourcePolicies) Get(ctx context.Context, clientID string) (FAPIClientPolicy, error) {
	if p.Store.DB == nil || p.ProjectID == "" || clientID == "" {
		return FAPIClientPolicy{}, ErrFAPIPolicyDenied
	}
	var value FAPIClientPolicy
	var scopes string
	value.ProjectID = p.ProjectID
	value.ClientID = clientID
	err := p.Store.DB.QueryRowContext(ctx, `SELECT audience,scopes,enabled,version FROM mapi_fapi_client_policy WHERE project_id=? AND client_id=?`, p.ProjectID, clientID).Scan(&value.Audience, &scopes, &value.Enabled, &value.Version)
	if errors.Is(err, sql.ErrNoRows) {
		return FAPIClientPolicy{}, ErrFAPIPolicyDenied
	}
	if err != nil {
		return FAPIClientPolicy{}, err
	}
	if !validFAPIAudience(value.Audience) || value.Version <= 0 || json.Unmarshal([]byte(scopes), &value.Scopes) != nil {
		return FAPIClientPolicy{}, errors.New("corrupt FAPI resource policy")
	}
	normalized, err := policyScopes(value.Scopes)
	if err != nil || !slices.Equal(normalized, value.Scopes) {
		return FAPIClientPolicy{}, errors.New("corrupt FAPI resource policy")
	}
	return value, nil
}
func (p FAPIResourcePolicies) require(ctx context.Context, clientID, scope string) (FAPIClientPolicy, error) {
	value, err := p.Get(ctx, clientID)
	if err != nil {
		return FAPIClientPolicy{}, err
	}
	if !value.Enabled {
		return FAPIClientPolicy{}, ErrFAPIPolicyDenied
	}
	canonical, err := canonicalFAPIScopes(scope)
	if err != nil || canonical != scope {
		return FAPIClientPolicy{}, ErrFAPIPolicyDenied
	}
	for _, s := range strings.Fields(scope) {
		if s != "openid" && s != "offline_access" && !slices.Contains(value.Scopes, s) {
			return FAPIClientPolicy{}, ErrFAPIPolicyDenied
		}
	}
	return value, nil
}

// Version returns the enabled authorization generation in the caller's
// existing transaction. Pending state must preserve and later compare it.
func (p FAPIResourcePolicies) Version(ctx context.Context, project, client, scope string) (int64, error) {
	if project != p.ProjectID {
		return 0, ErrFAPIPolicyDenied
	}
	value, err := p.require(ctx, client, scope)
	if err != nil {
		return 0, err
	}
	return value.Version, nil
}
