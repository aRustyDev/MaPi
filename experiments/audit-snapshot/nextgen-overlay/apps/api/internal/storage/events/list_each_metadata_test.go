package events

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/dialect/pagination"
)

func TestListEachMetadataExpectedAndParity(t *testing.T) {
	at := time.Unix(123, 0).UTC()
	event := func(id string, offset time.Duration) *domain.Event {
		return &domain.Event{ID: id, CreatedAt: at.Add(offset)}
	}
	base := [][]*domain.Event{
		{event("a", 0), event("c", 0), event("e", time.Second)},
		{event("b", 0), event("d", time.Second)},
		{},
	}
	for _, tc := range []struct {
		name   string
		order  database.OrderBy[domain.EventField]
		limit  uint32
		values []string
		failAt int
		ids    []string
		more   bool
	}{
		{"ascending merge and probe", CreatedAtAsc(), 2, []string{"first", "first", "second", "empty"}, -1, []string{"a", "b"}, true},
		{"descending merge", CreatedAtDesc(), 2, []string{"first", "second", "empty"}, -1, []string{"e", "d"}, true},
		{"exact final page", CreatedAtAsc(), 5, []string{"first", "second", "empty"}, -1, []string{"a", "b", "c", "d", "e"}, false},
		{"empty values", CreatedAtAsc(), 2, nil, -1, nil, false},
		{"unbounded", CreatedAtAsc(), 0, []string{"first", "second", "empty"}, -1, []string{"a", "b", "c", "d", "e"}, false},
		{"error propagation", CreatedAtAsc(), 2, []string{"first", "second"}, 1, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := &database.ListOptions[domain.EventField]{Pagination: database.Page[domain.EventField]{Limit: tc.limit, OrderBy: tc.order}}
			wantErr := errors.New("synthetic range failure")
			var fullFilters, metadataFilters []database.Filter[domain.EventField]
			makeReader := func(filters *[]database.Filter[domain.EventField]) ListFunc {
				index := 0
				return func(_ context.Context, sub *database.ListOptions[domain.EventField]) (*database.ListResult[*domain.Event], error) {
					*filters = append(*filters, sub.Filter)
					current := index
					index++
					if current == tc.failAt {
						return nil, wantErr
					}
					rows := append([]*domain.Event(nil), base[current]...)
					if tc.order.Direction == database.OrderDesc {
						for left, right := 0, len(rows)-1; left < right; left, right = left+1, right-1 {
							rows[left], rows[right] = rows[right], rows[left]
						}
					}
					items, cursor, err := pagination.Page(sub.Pagination, Schema, func(limit uint32) ([]*domain.Event, error) {
						if limit != 0 && uint64(len(rows)) > uint64(limit) {
							rows = rows[:limit]
						}
						return rows, nil
					})
					return &database.ListResult[*domain.Event]{Items: items, NextCursor: cursor}, err
				}
			}
			fullReader := makeReader(&fullFilters)
			metadataReader := makeReader(&metadataFilters)
			metadata := func(ctx context.Context, sub *database.ListOptions[domain.EventField]) (*database.ListResult[Scanned], error) {
				res, err := metadataReader(ctx, sub)
				if err != nil {
					return nil, err
				}
				out := &database.ListResult[Scanned]{NextCursor: res.NextCursor}
				for _, e := range res.Items {
					out.Items = append(out.Items, Scanned{ID: e.ID, CreatedAt: e.CreatedAt})
				}
				return out, nil
			}
			full, fullErr := ListEach(context.Background(), fullReader, opts, domain.EventFieldCategory, tc.values)
			got, gotErr := ListEachMetadata(context.Background(), metadata, opts, domain.EventFieldCategory, tc.values)
			if !errors.Is(fullErr, gotErr) || !errors.Is(gotErr, fullErr) {
				t.Fatalf("errors differ: full=%v metadata=%v", fullErr, gotErr)
			}
			if !reflect.DeepEqual(fullFilters, metadataFilters) {
				t.Fatalf("range filters differ: full=%v metadata=%v", fullFilters, metadataFilters)
			}
			if fullErr != nil {
				return
			}
			var ids []string
			for _, e := range got.Items {
				ids = append(ids, e.ID)
			}
			if !reflect.DeepEqual(ids, tc.ids) || (len(got.NextCursor) > 0) != tc.more {
				t.Fatalf("got IDs %v and cursor %q; want IDs %v and cursor present %v", ids, got.NextCursor, tc.ids, tc.more)
			}
			var expected []Scanned
			for _, e := range full.Items {
				expected = append(expected, Scanned{ID: e.ID, CreatedAt: e.CreatedAt})
			}
			if !reflect.DeepEqual(expected, got.Items) || string(full.NextCursor) != string(got.NextCursor) {
				t.Fatalf("full IDs/cursor = %v %q, metadata = %v %q", expected, full.NextCursor, got.Items, got.NextCursor)
			}
		})
	}
}
