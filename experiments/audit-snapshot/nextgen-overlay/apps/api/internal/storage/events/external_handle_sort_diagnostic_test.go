package events

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"slices"
	"testing"
)

// This in-memory test store is an oracle only; it does not establish the
// memory, transaction, I/O, crash or security behavior of a durable spool.
type diagnosticSortStore struct {
	items    []uint64
	failGet  error
	failSwap error
}

func (s *diagnosticSortStore) Len() int { return len(s.items) }
func (s *diagnosticSortStore) Get(i int) (uint64, error) {
	if s.failGet != nil {
		return 0, s.failGet
	}
	return s.items[i], nil
}
func (s *diagnosticSortStore) Swap(i, j int) error {
	if s.failSwap != nil {
		return s.failSwap
	}
	s.items[i], s.items[j] = s.items[j], s.items[i]
	return nil
}

// Each handle is distinct, even when its key is not. Comparing full handle
// permutations rather than keys detects different tie-selection behavior.
func TestDiagnosticExternalSortAgainstSlicesSortFunc(t *testing.T) {
	rng := rand.New(rand.NewSource(20261123))
	for run := 0; run < 2000; run++ {
		n := rng.Intn(600)
		if run < 80 {
			n = run
		}
		keys := make([]int, n)
		items := make([]uint64, n)
		for i := range items {
			items[i] = uint64(i)
			switch run % 6 {
			case 0:
				keys[i] = 0 // All equal.
			case 1:
				keys[i] = i / 3 // Long pre-sorted runs.
			case 2:
				keys[i] = (n - i) / 3
			case 3:
				keys[i] = i % 2
			default:
				keys[i] = rng.Intn(17)
			}
		}
		if run%3 == 0 {
			rng.Shuffle(n, func(i, j int) { items[i], items[j] = items[j], items[i] })
		}
		desc := run%2 == 1
		compare := func(a, b uint64) int {
			v := 0
			if keys[a] < keys[b] {
				v = -1
			} else if keys[a] > keys[b] {
				v = 1
			}
			if desc {
				return -v
			}
			return v
		}
		want := slices.Clone(items)
		slices.SortFunc(want, compare)
		store := &diagnosticSortStore{items: slices.Clone(items)}
		if err := DiagnosticExternalHandleSort(store, func(a, b uint64) (int, error) { return compare(a, b), nil }); err != nil {
			t.Fatalf("run %d: %v", run, err)
		}
		if !reflect.DeepEqual(store.items, want) {
			t.Fatalf("run %d, n=%d, desc=%v: tie permutation differs\ngot %v\nwant %v", run, n, desc, store.items, want)
		}
	}
}

func TestDiagnosticExternalSortFailurePropagation(t *testing.T) {
	failure := errors.New("injected store error")
	for _, kind := range []string{"get", "swap", "compare"} {
		t.Run(kind, func(t *testing.T) {
			store := &diagnosticSortStore{items: []uint64{2, 1, 0}}
			compare := func(a, b uint64) (int, error) {
				if kind == "compare" {
					return 0, failure
				}
				return int(a) - int(b), nil
			}
			if kind == "get" {
				store.failGet = failure
			}
			if kind == "swap" {
				store.failSwap = failure
			}
			if err := DiagnosticExternalHandleSort(store, compare); !errors.Is(err, failure) {
				t.Fatalf("got %v, want injected failure", err)
			}
		})
	}
	t.Run("unexpected panic propagates", func(t *testing.T) {
		defer func() {
			if got := recover(); got != "unexpected" {
				t.Fatalf("got %v, want unexpected panic", got)
			}
		}()
		_ = DiagnosticExternalHandleSort(&diagnosticSortStore{items: []uint64{1, 2}}, func(a, b uint64) (int, error) {
			panic("unexpected")
		})
	})
	if err := DiagnosticExternalHandleSort(nil, func(uint64, uint64) (int, error) { return 0, nil }); err == nil {
		t.Fatal(fmt.Errorf("nil store accepted"))
	}
}
