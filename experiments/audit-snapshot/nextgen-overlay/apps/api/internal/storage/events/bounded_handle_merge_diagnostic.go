package events

import (
	"errors"
	"fmt"
)

// ErrUnresolvedHandleEquality means two distinct observed handles compared
// equal. A bounded reducer cannot detect equalities among discarded handles;
// callers must separately establish key uniqueness across all input ranges.
var ErrUnresolvedHandleEquality = errors.New("distinct event handles compare equal")
var ErrHandleMergeFinished = errors.New("event handle merge already finished")

// HandleCompare orders opaque handles in the final page order. Keys and their
// storage belong to the caller. An error must be propagated to the caller.
type HandleCompare func(a, b uint64) (int, error)

// HandleSelection borrows Items from the reducer. Next is meaningful only if
// HasNext is true. The caller encodes any next-page cursor from that handle.
type HandleSelection struct {
	Items   []uint64
	Next    uint64
	HasNext bool
}

// BoundedHandleMerge keeps only the earliest limit+1 handles and one cut.
// Callers must submit and validate all ranges; the reducer never instructs a
// caller to stop reading or validating. It does not establish global key
// uniqueness and performs no database access or authorization.
type BoundedHandleMerge struct {
	limit     uint32
	compare   HandleCompare
	top       []uint64
	cut       uint64
	hasCut    bool
	rangeMore bool
	finished  bool
}

func NewBoundedHandleMerge(limit uint32, compare HandleCompare) (*BoundedHandleMerge, error) {
	if limit == 0 || compare == nil {
		return nil, errors.New("positive event page limit and comparator required")
	}
	return &BoundedHandleMerge{limit: limit, compare: compare}, nil
}

func (m *BoundedHandleMerge) cmp(a, b uint64) (int, error) {
	c, err := m.compare(a, b)
	if err != nil {
		return 0, err
	}
	if c == 0 && a != b {
		return 0, fmt.Errorf("%w: %d and %d", ErrUnresolvedHandleEquality, a, b)
	}
	return c, nil
}

// Add submits one matched handle. It compares against all currently retained
// handles even when the candidate falls behind the page, so detected ties and
// comparison errors are not hidden by the top-k optimization.
func (m *BoundedHandleMerge) Add(handle uint64) error {
	if m.finished {
		return ErrHandleMergeFinished
	}
	if m.hasCut {
		if _, err := m.cmp(handle, m.cut); err != nil {
			return err
		}
	}
	position := len(m.top)
	for i, candidate := range m.top {
		c, err := m.cmp(handle, candidate)
		if err != nil {
			return err
		}
		if c < 0 && position == len(m.top) {
			position = i
		}
	}
	capacity := uint64(m.limit) + 1
	if uint64(len(m.top)) < capacity {
		m.top = append(m.top, handle)
		copy(m.top[position+1:], m.top[position:len(m.top)-1])
		m.top[position] = handle
	} else if position < len(m.top) {
		copy(m.top[position+1:], m.top[position:len(m.top)-1])
		m.top[position] = handle
	}
	return nil
}

// ObserveCut records a range's last scanned row when its scan budget ran out.
// The earliest such row in page order is the upstream ScanEach cut.
func (m *BoundedHandleMerge) ObserveCut(handle uint64) error {
	if m.finished {
		return ErrHandleMergeFinished
	}
	for _, candidate := range m.top {
		if _, err := m.cmp(handle, candidate); err != nil {
			return err
		}
	}
	if !m.hasCut {
		m.cut, m.hasCut = handle, true
		return nil
	}
	c, err := m.cmp(handle, m.cut)
	if err != nil {
		return err
	}
	if c < 0 {
		m.cut = handle
	}
	return nil
}

// ObserveRangeMore records the presence of a next cursor in any ListEach
// range. The caller still has to process all remaining ranges.
func (m *BoundedHandleMerge) ObserveRangeMore(more bool) error {
	if m.finished {
		return ErrHandleMergeFinished
	}
	m.rangeMore = m.rangeMore || more
	return nil
}

// FinishScan preserves ScanEach's cut, short-page, and next-position rules.
// ordered indicates whether upstream has ordering columns for a cursor.
func (m *BoundedHandleMerge) FinishScan(ordered bool) (HandleSelection, error) {
	if m.finished {
		return HandleSelection{}, ErrHandleMergeFinished
	}
	end := len(m.top)
	if m.hasCut {
		for i, handle := range m.top {
			c, err := m.cmp(handle, m.cut)
			if err != nil {
				return HandleSelection{}, err
			}
			if c > 0 {
				end = i
				break
			}
		}
	}
	result := HandleSelection{Items: m.top[:end]}
	if ordered && m.hasCut {
		result.Next, result.HasNext = m.cut, true
	}
	if uint64(end) > uint64(m.limit) {
		result.Items = result.Items[:m.limit]
		if ordered {
			result.Next, result.HasNext = result.Items[len(result.Items)-1], true
		}
	}
	m.finished = true
	return result, nil
}

// FinishList preserves ListEach's merged-page and range-more cursor rules.
func (m *BoundedHandleMerge) FinishList(ordered bool) (HandleSelection, error) {
	if m.finished {
		return HandleSelection{}, ErrHandleMergeFinished
	}
	result := HandleSelection{Items: m.top}
	more := m.rangeMore
	if uint64(len(result.Items)) > uint64(m.limit) {
		result.Items = result.Items[:m.limit]
		more = true
	}
	if ordered && more && len(result.Items) > 0 {
		result.Next, result.HasNext = result.Items[len(result.Items)-1], true
	}
	m.finished = true
	return result, nil
}
