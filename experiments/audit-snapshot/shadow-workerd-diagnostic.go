//go:build wasip1 && mapi_shadow_diagnostic

package main

import (
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
	"unsafe"
)

//go:wasmimport mapi diagnostic_frame
func diagnosticFrame(ptr unsafe.Pointer, size uint32)

func main() {}

//go:wasmexport mapi_shadow_diagnostic
func run() int32 {
	output, err := sqlite.DiagnosticShadowFrame()
	if err != nil || len(output) == 0 {
		return 1
	}
	diagnosticFrame(unsafe.Pointer(&output[0]), uint32(len(output)))
	return 0
}
