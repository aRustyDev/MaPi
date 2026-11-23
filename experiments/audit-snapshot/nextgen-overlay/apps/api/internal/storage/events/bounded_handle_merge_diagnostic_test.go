package events

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/dialect/pagination"
)

// Synthetic comparison of the reducer with the pinned Go range algorithms.
// This does not model the SQL bridge, fragmented keys, auth or persistence.
func TestDiagnosticBoundedMergeAgainstPinned(t *testing.T) {
	rng := rand.New(rand.NewSource(1192026))
	for run := 0; run < 250; run++ {
		desc := run%2 == 1
		limit := uint32(1 + rng.Intn(5))
		budget := uint32(6 + rng.Intn(5))
		order := CreatedAtAsc()
		if desc {
			order = CreatedAtDesc()
		}
		opts := &database.ListOptions[domain.EventField]{Pagination: database.Page[domain.EventField]{Limit: limit, OrderBy: order}}
		ranges := make([][]Scanned, 3)
		byHandle := map[uint64]Scanned{}
		byID := map[string]*domain.Event{}
		handles := map[string]uint64{}
		var nextHandle uint64 = 1
		for ri := range ranges {
			for n := 0; n < rng.Intn(14); n++ {
				id := fmt.Sprintf("evt-%03d-%02d-%02d", run, ri, n)
				row := Scanned{ID: id, CreatedAt: time.Unix(int64(rng.Intn(7)), 0), Matched: rng.Intn(2) == 0}
				ranges[ri] = append(ranges[ri], row)
				byHandle[nextHandle] = row
				handles[id] = nextHandle
				byID[id] = &domain.Event{ID: id, CreatedAt: row.CreatedAt}
				nextHandle++
			}
		}
		compareRow := func(a, b Scanned) int {
			v := cmp.Or(a.CreatedAt.Compare(b.CreatedAt), cmp.Compare(a.ID, b.ID))
			if desc {
				return -v
			}
			return v
		}
		for i := range ranges {
			slices.SortFunc(ranges[i], compareRow)
		}
		compareHandle := func(a, b uint64) (int, error) { return compareRow(byHandle[a], byHandle[b]), nil }
		values := []string{"a", "b", "c"}
		scanIndex := 0
		scan := func(_ context.Context, sub *database.ListOptions[domain.EventField], _ database.Filter[domain.EventField]) ([]Scanned, error) {
			r := ranges[scanIndex]
			scanIndex++
			if uint64(len(r)) > uint64(sub.Pagination.Limit) {
				r = r[:sub.Pagination.Limit]
			}
			return r, nil
		}
		fetch := func(_ context.Context, ids []string) ([]*domain.Event, error) {
			out := make([]*domain.Event, 0, len(ids))
			for _, id := range ids {
				out = append(out, byID[id])
			}
			return out, nil
		}
		original, err := ScanEach(context.Background(), scan, fetch, opts, domain.EventFieldCategory, values, nil, budget)
		if err != nil {
			t.Fatal(err)
		}
		merge, err := NewBoundedHandleMerge(limit, compareHandle)
		if err != nil {
			t.Fatal(err)
		}
		for _, rows := range ranges {
			if uint64(len(rows)) > uint64(budget) {
				rows = rows[:budget]
			}
			if len(rows) == int(budget) {
				if err := merge.ObserveCut(handles[rows[len(rows)-1].ID]); err != nil {
					t.Fatal(err)
				}
			}
			for _, r := range rows {
				if r.Matched {
					if err := merge.Add(handles[r.ID]); err != nil {
						t.Fatal(err)
					}
				}
			}
			if len(merge.top) > int(limit)+1 {
				t.Fatal("unbounded retained handles")
			}
		}
		got, err := merge.FinishScan(true)
		if err != nil {
			t.Fatal(err)
		}
		var ids, expected []string
		for _, h := range got.Items {
			ids = append(ids, byHandle[h].ID)
		}
		for _, e := range original.Items {
			expected = append(expected, e.ID)
		}
		cursor := ""
		if got.HasNext {
			r := byHandle[got.Next]
			cursor = string(pagination.New(order, Schema.ValuesFrom(&domain.Event{ID: r.ID, CreatedAt: r.CreatedAt}, order.Columns)).Marshal())
		}
		if !reflect.DeepEqual(ids, expected) || cursor != string(original.NextCursor) {
			t.Fatalf("run %d scan mismatch got %v %q want %v %q", run, ids, cursor, expected, original.NextCursor)
		}
		// Each real ListEach range returns its page after the limit+1 probe.
		index := 0
		list := func(_ context.Context, sub *database.ListOptions[domain.EventField]) (*database.ListResult[*domain.Event], error) {
			rows := ranges[index]
			index++
			events := make([]*domain.Event, 0, len(rows))
			for _, r := range rows {
				events = append(events, byID[r.ID])
			}
			items, cur, err := pagination.Page(sub.Pagination, Schema, func(n uint32) ([]*domain.Event, error) {
				if n != 0 && uint64(len(events)) > uint64(n) {
					events = events[:n]
				}
				return events, nil
			})
			return &database.ListResult[*domain.Event]{Items: items, NextCursor: cur}, err
		}
		originalList, err := ListEach(context.Background(), list, opts, domain.EventFieldCategory, values)
		if err != nil {
			t.Fatal(err)
		}
		m, err := NewBoundedHandleMerge(limit, compareHandle)
		if err != nil {
			t.Fatal(err)
		}
		for _, rows := range ranges {
			more := len(rows) > int(limit)
			if err := m.ObserveRangeMore(more); err != nil {
				t.Fatal(err)
			}
			if more {
				rows = rows[:limit]
			}
			for _, r := range rows {
				if err := m.Add(handles[r.ID]); err != nil {
					t.Fatal(err)
				}
			}
			if len(m.top) > int(limit)+1 {
				t.Fatal("unbounded retained handles")
			}
		}
		result, err := m.FinishList(true)
		if err != nil {
			t.Fatal(err)
		}
		ids = nil
		expected = nil
		for _, h := range result.Items {
			ids = append(ids, byHandle[h].ID)
		}
		for _, e := range originalList.Items {
			expected = append(expected, e.ID)
		}
		cursor = ""
		if result.HasNext {
			r := byHandle[result.Next]
			cursor = string(pagination.New(order, Schema.ValuesFrom(&domain.Event{ID: r.ID, CreatedAt: r.CreatedAt}, order.Columns)).Marshal())
		}
		if !reflect.DeepEqual(ids, expected) || cursor != string(originalList.NextCursor) {
			t.Fatalf("run %d list mismatch got %v %q want %v %q", run, ids, cursor, expected, originalList.NextCursor)
		}
	}
}

func TestDiagnosticBoundedMergeComparatorFailureAndEquality(t *testing.T) {
	sentinel := errors.New("comparator failed")
	m, _ := NewBoundedHandleMerge(1, func(a, b uint64) (int, error) {
		if a == 3 || b == 3 {
			return 0, sentinel
		}
		return 0, nil
	})
	if err := m.Add(1); err != nil {
		t.Fatal(err)
	}
	if err := m.Add(2); !errors.Is(err, ErrUnresolvedHandleEquality) {
		t.Fatalf("tie error %v", err)
	}
	if err := m.Add(3); !errors.Is(err, sentinel) {
		t.Fatalf("comparison error %v", err)
	}
}
