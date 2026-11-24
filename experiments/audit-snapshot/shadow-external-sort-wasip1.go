//go:build wasip1

// This diagnostic links the retained Go external-sort implementation to a
// synchronous host-backed spool. The host must validate scope and rollback.
package main

import "errors"

//go:wasmimport mapi spool_get
func spoolGet(index uint32) uint64

//go:wasmimport mapi spool_swap
func spoolSwap(i, j uint32) int32

//go:wasmimport mapi spool_compare
func spoolCompare(a, b uint64) int32

type HandleCompare func(a, b uint64) (int, error)
type diagnosticStore struct{ count int }

func (s diagnosticStore) Len() int { return s.count }
func (s diagnosticStore) Get(i int) (uint64, error) {
	value := spoolGet(uint32(i))
	if value == 0 { return 0, errors.New("missing spool handle") }
	return value, nil
}
func (s diagnosticStore) Swap(i, j int) error {
	if spoolSwap(uint32(i), uint32(j)) != 0 { return errors.New("spool swap failed") }
	return nil
}

func main() {}

//go:wasmexport sort_shadow_handles
func sortShadowHandles(count uint32) int32 {
	err := DiagnosticExternalHandleSort(diagnosticStore{int(count)}, func(a, b uint64) (int, error) {
		value := spoolCompare(a, b)
		if value < -1 || value > 1 { return 0, errors.New("spool comparison failed") }
		return int(value), nil
	})
	if err != nil { return 1 }
	return 0
}
