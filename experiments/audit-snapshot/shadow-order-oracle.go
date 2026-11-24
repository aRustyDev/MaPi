// Independent pinned-toolchain oracle for the upstream event comparator.
package main

import (
    "cmp"
    "encoding/json"
    "os"
    "slices"
    "strconv"
    "time"
)

type event struct { Handle int `json:"handle"`; ID string `json:"id"`; Nano string `json:"nano"` }
type input struct { Events []event `json:"events"`; Direction string `json:"direction"` }
func main() {
    var in input
    if err:=json.NewDecoder(os.Stdin).Decode(&in); err!=nil { panic(err) }
    if in.Direction!="asc" && in.Direction!="desc" { panic("invalid order") }
    nanos:=make(map[int]time.Time,len(in.Events))
    for _,item:=range in.Events { n,err:=strconv.ParseInt(item.Nano,10,64); if err!=nil { panic(err) }; nanos[item.Handle]=time.Unix(0,n) }
    slices.SortFunc(in.Events,func(a,b event) int {
        order:=cmp.Or(nanos[a.Handle].Compare(nanos[b.Handle]),cmp.Compare(a.ID,b.ID))
        if in.Direction=="desc" {return -order}; return order
    })
    if err:=json.NewEncoder(os.Stdout).Encode(in.Events); err!=nil { panic(err) }
}
