// Diagnostic-only: this reader is not mounted and does not authorize a user,
// fence a snapshot, bound materialization, or establish a stable source.
package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/events"
)

// shadowReadClient is private to the three trusted pinned event read
// statements. It replaces their fixed FROM clause and refuses Exec. Its
// prefix/count checks do not authorize arbitrary caller-supplied SQL. The
// view, schema, and its lifecycle still require trusted setup.
type shadowReadClient struct{ base queryExecutor }

func (c shadowReadClient) Exec(context.Context, string, ...any) (sql.Result, error) {
	return nil, errors.New("shadow read does not permit writes")
}

func (c shadowReadClient) Query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	const from = "\nFROM events"
	if !(strings.HasPrefix(query, "SELECT ") || strings.HasPrefix(query, "SELECT\n")) || strings.Count(query, from) != 1 {
		return nil, errors.New("invalid shadow event query")
	}
	return c.base.Query(ctx, strings.Replace(query, from, "\nFROM mapi_shadow_snapshot", 1), args...)
}

func (c shadowReadClient) QueryRow(ctx context.Context, _ string, _ ...any) *sql.Row {
	// None of the three pinned reads uses QueryRow. A fixed failing query keeps
	// this adapter read-only if a future caller inadvertently invokes it.
	return c.base.QueryRow(ctx, "SELECT NULL WHERE 0")
}

type diagnosticShadowEventReader struct {
	projectID string
	read      eventStatements
}

func newDiagnosticShadowEventReader(client queryExecutor, trustedProjectID string) (*diagnosticShadowEventReader, error) {
	if client == nil || trustedProjectID == "" {
		return nil, errors.New("trusted snapshot project required")
	}
	return &diagnosticShadowEventReader{projectID: trustedProjectID, read: newEventStatements(shadowReadClient{base: client})}, nil
}

func (s *diagnosticShadowEventReader) scoped(options *database.ListOptions[domain.EventField]) (*database.ListOptions[domain.EventField], error) {
	if options == nil {
		return nil, errors.New("event options required")
	}
	copy := *options
	// Only reuse an existing restriction when a conjunction necessarily
	// contains an exact single-column equality to this project. Restricts alone
	// is insufficient: it also reports columns under OR and NOT. Otherwise add
	// the trusted project filter, preserving the fail-closed intersection.
	if !necessarilyScoped(options.Filter, s.projectID) {
		copy.Filter = database.And(database.Equal(database.Col(domain.EventFieldProjectID), s.projectID), options.Filter)
	}
	return &copy, nil
}

func necessarilyScoped(filter database.Filter[domain.EventField], projectID string) bool {
	switch f := filter.(type) {
	case database.AndFilter[domain.EventField]:
		for _, child := range f.Filters {
			if necessarilyScoped(child, projectID) {
				return true
			}
		}
	case *database.CompareFilter[domain.EventField]:
		if f == nil || f.Keyset || f.Op != database.OpEqual || len(f.Terms) != 1 || f.Terms[0].Column != database.Col(domain.EventFieldProjectID) {
			return false
		}
		value, ok := f.Terms[0].Value.(string)
		return ok && value == projectID
	}
	return false
}

func (s *diagnosticShadowEventReader) ListEvents(ctx context.Context, options *database.ListOptions[domain.EventField]) (*database.ListResult[*domain.Event], error) {
	scoped, err := s.scoped(options)
	if err != nil {
		return nil, err
	}
	return s.read.ListEvents(ctx, scoped)
}

func (s *diagnosticShadowEventReader) ScanEvents(ctx context.Context, options *database.ListOptions[domain.EventField], match database.Filter[domain.EventField]) ([]events.Scanned, error) {
	scoped, err := s.scoped(options)
	if err != nil {
		return nil, err
	}
	return s.read.ScanEvents(ctx, scoped, match)
}

func (s *diagnosticShadowEventReader) GetEventByID(ctx context.Context, projectID, id string) (*domain.Event, error) {
	if projectID != s.projectID {
		return nil, database.NewNoRowFoundError(nil)
	}
	return s.read.GetEventByID(ctx, s.projectID, id)
}
