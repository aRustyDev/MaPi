// Diagnostic-only event metadata projection. It is not wired to public routes.
package sqlite

import (
	"context"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/dialect/pagination"
	"github.com/zitadel/nextgen/internal/storage/events"
)

// listEventSnapshotMetadata reads only the event's identity and ordering key.
// The caller must constrain ordering to created_at and id: Schema's remaining
// accessors need fields that are deliberately absent from this projection.
func (e eventStatements) listEventSnapshotMetadata(ctx context.Context, filter *database.ListOptions[domain.EventField]) (*database.ListResult[events.Scanned], error) {
	for _, col := range filter.Pagination.OrderBy.Columns {
		if col.Field() != domain.EventFieldCreatedAt && col.Field() != domain.EventFieldID {
			return nil, domain.ErrEventInvalid("unsupported diagnostic snapshot ordering", nil)
		}
	}
	items, cursor, err := pagination.Page(filter.Pagination, events.Schema, func(limit uint32) ([]*domain.Event, error) {
		page := *filter
		page.Pagination.Limit = limit
		var c statementCompiler
		if err := compileRead(&c, "SELECT id, created_at FROM events", &page, events.Schema); err != nil {
			return nil, err
		}
		rows, err := e.client.Query(ctx, c.String(), c.args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []*domain.Event
		for rows.Next() {
			var item domain.Event
			var created int64
			if err := rows.Scan(&item.ID, &created); err != nil {
				return nil, err
			}
			item.CreatedAt = timeFromUnixNano(created)
			out = append(out, &item)
		}
		return out, rows.Err()
	})
	if err != nil {
		return nil, err
	}
	result := &database.ListResult[events.Scanned]{NextCursor: cursor, Items: make([]events.Scanned, 0, len(items))}
	for _, item := range items {
		result.Items = append(result.Items, events.Scanned{ID: item.ID, CreatedAt: item.CreatedAt})
	}
	return result, nil
}
