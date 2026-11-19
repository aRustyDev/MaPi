//go:build wasip1 && mapi_split_password_test

// This is a private test-only bridge. Its finish result is trusted only when
// passed by the enclosing object invocation after the service-binding call.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"time"

	"github.com/zitadel/nextgen/internal/crypto"
	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/service"
	"github.com/zitadel/nextgen/internal/storage/database"
)

type splitInput struct {
	ProjectID   string `json:"projectId"`
	AttemptID   string `json:"attemptId"`
	ChallengeID string `json:"challengeId"`
	Password    string `json:"password"`
	Hash        string `json:"hash"`
	Verified    *bool  `json:"verified"`
}

type splitSnapshot struct {
	ProjectID           string `json:"projectId"`
	AttemptID           string `json:"attemptId"`
	ChallengeID         string `json:"challengeId"`
	UserID              string `json:"userId"`
	CredentialID        string `json:"credentialId"`
	Hash                string `json:"hash"`
	ExpiresAt           int64  `json:"expiresAt"`
	ChallengeOpen       bool   `json:"challengeOpen"`
	UserActive          bool   `json:"userActive"`
	ParentSessionActive bool   `json:"parentSessionActive"`
}

func splitPrepare(in splitInput) (*splitSnapshot, error) {
	if runtimePool == nil || in.ProjectID == "" || in.AttemptID == "" || in.ChallengeID == "" {
		return nil, errors.New("invalid split request")
	}
	ctx := context.Background()
	s := runtimePool.Statements()
	project, err := s.GetProjectByID(ctx, in.ProjectID)
	if err != nil {
		return nil, err
	}
	// The isolated verifier supports only the pinned deployment default. A
	// project override may require a different cost or rehashing behavior.
	if project.PasswordHashPolicy != nil {
		return nil, errors.New("unsupported project hash policy")
	}
	a, err := s.GetAuthAttemptByID(ctx, in.ProjectID, in.AttemptID)
	if err != nil {
		return nil, err
	}
	// This spike excludes step-up and ambiguous expiry instead of attempting
	// to authorize a stale or unbounded parent session.
	if a.SessionID != nil || a.CreatedAt.IsZero() || a.TimeToLive == nil || *a.TimeToLive <= 0 {
		return nil, errors.New("unsupported attempt")
	}
	challenge, factor, err := a.PreparePasswordVerification(in.ChallengeID)
	if err != nil {
		return nil, err
	}
	if challenge == nil || factor == nil || factor.UserID == "" {
		return nil, errors.New("missing challenge or user")
	}
	u, err := s.GetUser(ctx, database.And(database.Equal(database.Col(domain.UserFieldProjectID), in.ProjectID), database.Equal(database.Col(domain.UserFieldID), factor.UserID)), service.UserQueryOptions{})
	if err != nil {
		return nil, err
	}
	if u.Metadata.Status != domain.UserStatusActive {
		return nil, errors.New("inactive user")
	}
	p, err := s.GetUserPassword(ctx, database.And(database.Equal(database.Col(domain.UserPasswordFieldProjectID), in.ProjectID), database.Equal(database.Col(domain.UserPasswordFieldUserID), factor.UserID)))
	if err != nil {
		return nil, err
	}
	if p.ID == "" || p.EncodedHash == "" {
		return nil, errors.New("missing password")
	}
	expires := a.CreatedAt.Add(*a.TimeToLive)
	if !time.Now().Before(expires) {
		return nil, errors.New("expired attempt")
	}
	return &splitSnapshot{ProjectID: in.ProjectID, AttemptID: in.AttemptID, ChallengeID: challenge.GetID(), UserID: factor.UserID, CredentialID: p.ID, Hash: p.EncodedHash, ExpiresAt: expires.UnixMilli(), ChallengeOpen: true, UserActive: true, ParentSessionActive: true}, nil
}

//go:wasmexport mapi_split_prepare
func splitPrepareExport() uint64 {
	var in splitInput
	if err := json.Unmarshal(input, &in); err != nil {
		return failure(err)
	}
	out, err := splitPrepare(in)
	if err != nil {
		return failure(err)
	}
	return marshal(out)
}

type splitOracle struct {
	hash, password string
	verified, used bool
}

func (*splitOracle) Hash(context.Context, string) (string, error) { return "", crypto.ErrHashingBusy }
func (o *splitOracle) VerifyAndRehash(_ context.Context, hash, password string) (string, error) {
	if o.used || subtle.ConstantTimeCompare([]byte(hash), []byte(o.hash)) != 1 || subtle.ConstantTimeCompare([]byte(password), []byte(o.password)) != 1 {
		return "", crypto.ErrHashingBusy
	}
	o.used = true
	if !o.verified {
		return "", errors.New("password mismatch")
	}
	return "", nil
}

//go:wasmexport mapi_split_finish
func splitFinishExport() uint64 {
	var in splitInput
	if err := json.Unmarshal(input, &in); err != nil {
		return failure(err)
	}
	if in.Verified == nil || in.Password == "" || in.Hash == "" {
		return failure(errors.New("invalid split completion"))
	}
	// Re-run upstream preparation immediately before the original service.
	snapshot, err := splitPrepare(in)
	if err != nil {
		return failure(err)
	}
	if subtle.ConstantTimeCompare([]byte(snapshot.Hash), []byte(in.Hash)) != 1 {
		return failure(errors.New("credential changed"))
	}
	oracle := &splitOracle{hash: in.Hash, password: domain.NormalizePassword(in.Password), verified: *in.Verified}
	pool := runtimePool
	attempts := service.NewAuthAttemptService(pool, service.SessionStatementsResolver{Pool: pool}, service.UserStatementsLookup{Pool: pool}, service.FixedProjectHasherResolver{Hasher: oracle}, hasher)
	_, err = attempts.VerifyProof(context.Background(), service.VerifyProofInput{ProjectID: in.ProjectID, AttemptID: in.AttemptID, ChallengeID: in.ChallengeID, Proof: service.PasswordProof{Password: in.Password}})
	if !oracle.used {
		return failure(errors.New("oracle not consumed"))
	}
	if err != nil {
		var de domain.Error
		if errors.As(err, &de) && de.Code == domain.ErrAuthAttemptProofRejected(nil).Code {
			return marshal(map[string]any{"ok": false, "code": de.Code})
		}
		return failure(err)
	}
	return marshal(map[string]any{"ok": true})
}
