// Independent pinned-toolchain slice-order oracle for equal timestamps.
package main

import (
	"cmp"
	"encoding/json"
	"os"
	"slices"
)

type event struct { Handle int `json:"handle"`; ID string `json:"id"` }
func main() {
	var events []event
	if err := json.NewDecoder(os.Stdin).Decode(&events); err != nil { panic(err) }
	slices.SortFunc(events, func(a,b event) int { return cmp.Compare(a.ID,b.ID) })
	if err := json.NewEncoder(os.Stdout).Encode(events); err != nil { panic(err) }
}
