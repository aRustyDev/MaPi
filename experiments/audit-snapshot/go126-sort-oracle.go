package main

import (
	"encoding/json"
	"os"
	"slices"
)

type item struct { Key int `json:"key"`; ID int `json:"id"` }
func main() {
	var cases [][]item
	if err := json.NewDecoder(os.Stdin).Decode(&cases); err != nil { panic(err) }
	for _, a := range cases { slices.SortFunc(a, func(x,y item) int { if x.Key<y.Key{return -1};if x.Key>y.Key{return 1};return 0 }) }
	if err := json.NewEncoder(os.Stdout).Encode(cases); err != nil { panic(err) }
}
