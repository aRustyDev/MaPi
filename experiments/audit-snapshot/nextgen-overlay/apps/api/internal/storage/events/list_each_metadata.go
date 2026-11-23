package events

import (
	"cmp"
	"context"
	"slices"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/dialect/pagination"
)

// MetadataListFunc reads one ordered range with the same pagination semantics
// as ListFunc, but carries only each event's key and ordering fields.
type MetadataListFunc func(context.Context, *database.ListOptions[domain.EventField]) (*database.ListResult[Scanned], error)

// ListEachMetadata selects the metadata of the page ListEach would merge.
// Its reader must implement the same filters, lookahead and next-cursor rules as
// ListEvents. Payloads must be fetched under the same snapshot separately.
func ListEachMetadata(ctx context.Context, list MetadataListFunc, opts *database.ListOptions[domain.EventField], field domain.EventField, values []string) (*database.ListResult[Scanned], error) {
	page := opts.Pagination
	var merged []Scanned
	more := false
	for _, value := range unique(values) {
		sub := *opts
		sub.Filter = database.And(opts.Filter, database.Equal(database.Col(field), value))
		res, err := list(ctx, &sub)
		if err != nil {
			return nil, err
		}
		merged = append(merged, res.Items...)
		more = more || len(res.NextCursor) > 0
	}
	slices.SortFunc(merged, func(a, b Scanned) int {
		order := cmp.Or(a.CreatedAt.Compare(b.CreatedAt), cmp.Compare(a.ID, b.ID))
		if page.OrderBy.Direction == database.OrderDesc {
			return -order
		}
		return order
	})
	if page.Limit != 0 && uint64(len(merged)) > uint64(page.Limit) {
		merged = merged[:page.Limit]
		more = true
	}
	result := &database.ListResult[Scanned]{Items: merged}
	if more && len(merged) > 0 && len(page.OrderBy.Columns) > 0 {
		last := merged[len(merged)-1]
		at := &domain.Event{CreatedAt: last.CreatedAt, ID: last.ID}
		result.NextCursor = pagination.New(page.OrderBy, Schema.ValuesFrom(at, page.OrderBy.Columns)).Marshal()
	}
	return result, nil
}
