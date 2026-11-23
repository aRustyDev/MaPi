package events

import (
	"errors"
	"fmt"
	"sort"
)

// HandleSortStore is an opaque, indexed sequence. A future implementation
// must keep the sequence and its keys out of the isolate heap and provide
// bounded Get and Swap operations in a protected snapshot. This interface
// alone does not provide durability, atomicity, authentication or fencing.
type HandleSortStore interface {
	Len() int
	Get(index int) (uint64, error)
	Swap(i, j int) error
}

// sortFailure is private so only failures deliberately raised by the adapter
// are converted back to errors. Unexpected panics must not be hidden.
type sortFailure struct{ err error }

type diagnosticExternalSort struct {
	store   HandleSortStore
	compare HandleCompare
}

func (s *diagnosticExternalSort) Len() int { return s.store.Len() }

func (s *diagnosticExternalSort) Less(i, j int) bool {
	a, err := s.store.Get(i)
	if err != nil {
		panic(sortFailure{err})
	}
	b, err := s.store.Get(j)
	if err != nil {
		panic(sortFailure{err})
	}
	c, err := s.compare(a, b)
	if err != nil {
		panic(sortFailure{err})
	}
	return c < 0
}

func (s *diagnosticExternalSort) Swap(i, j int) {
	if err := s.store.Swap(i, j); err != nil {
		panic(sortFailure{err})
	}
}

// DiagnosticExternalHandleSort explores retaining the complete input as
// external opaque handles while avoiding an in-memory slice. Unlike a top-k
// reducer, it does not discard comparator-equal rows before the pinned sort.
//
// This is not a compatibility contract: sort.Sort and slices.SortFunc are both
// unstable and their public APIs do not promise the same order of ties. A
// specific Go release must be source-verified and tested. The store must
// provide its own transactional rollback after any error or interruption.
func DiagnosticExternalHandleSort(store HandleSortStore, compare HandleCompare) (err error) {
	if store == nil || compare == nil {
		return errors.New("event handle store and comparator required")
	}
	if store.Len() < 0 {
		return errors.New("negative event handle count")
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			if failure, ok := recovered.(sortFailure); ok {
				err = fmt.Errorf("event handle external sort: %w", failure.err)
				return
			}
			panic(recovered)
		}
	}()
	sort.Sort(&diagnosticExternalSort{store: store, compare: compare})
	return nil
}
