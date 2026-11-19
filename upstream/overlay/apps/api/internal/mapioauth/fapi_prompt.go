package mapioauth

import (
	"context"
	"database/sql"
	"errors"
)

// Prompt records contain no credentials and are transactionally attached to
// their hashed private PAR/login handle. A missing row fails closed.
func createFAPIPromptSchema(ctx context.Context, s Store) error {
	if s.DB == nil {
		return errors.New("FAPI prompt database not configured")
	}
	_, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS mapi_fapi_prompts (kind TEXT NOT NULL,token_hash BLOB NOT NULL,prompt TEXT NOT NULL CHECK(prompt IN ('','consent')),PRIMARY KEY(kind,token_hash))`)
	return err
}
func putFAPIPrompt(ctx context.Context, s Store, kind string, hash []byte, prompt string) error {
	if prompt != "" && prompt != "consent" {
		return ErrInvalidPAR
	}
	_, err := s.DB.ExecContext(ctx, `INSERT INTO mapi_fapi_prompts(kind,token_hash,prompt) VALUES(?,?,?)`, kind, hash, prompt)
	return err
}
func getFAPIPrompt(ctx context.Context, s Store, kind string, hash []byte) (string, error) {
	var prompt string
	err := s.DB.QueryRowContext(ctx, `SELECT prompt FROM mapi_fapi_prompts WHERE kind=? AND token_hash=?`, kind, hash).Scan(&prompt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrFAPIPolicyDenied
	}
	if err != nil {
		return "", err
	}
	if prompt != "" && prompt != "consent" {
		return "", errors.New("invalid FAPI prompt state")
	}
	return prompt, nil
}
func deleteFAPIPrompt(ctx context.Context, s Store, kind string, hash []byte) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM mapi_fapi_prompts WHERE kind=? AND token_hash=?`, kind, hash)
	return err
}
