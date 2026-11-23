//go:build wasip1

// Unmounted diagnostic only: this uses a synthetic authorization row, not
// the pinned API's caller or project authorization logic.
package main

import (
	"errors"

	"github.com/zitadel/nextgen/internal/cloudflarewasm"
)

//go:wasmimport mapi begin_shadow
func beginShadow() uint32

func main() {}

//go:wasmexport mapi_shadow_transaction_diagnostic
func run(mode int32) int32 {
	db := cloudflarewasm.Open()
	defer db.Close()
	err := cloudflarewasm.Transaction(func() error {
		var permitted int
		if err := db.QueryRow("SELECT allowed FROM synthetic_permission WHERE id = 1").Scan(&permitted); err != nil {
			return err
		}
		if permitted != 1 {
			return errors.New("synthetic permission denied")
		}
		if _, err := db.Exec("INSERT INTO transaction_marker VALUES (1)"); err != nil {
			return err
		}
		if beginShadow() != 0 {
			return errors.New("shadow host failure")
		}
		if _, err := db.Exec("INSERT INTO transaction_marker VALUES (2)"); err != nil {
			return err
		}
		if mode == 0 {
			return errors.New("injected rollback")
		}
		return nil
	})
	if err != nil {
		return 1
	}
	return 0
}
