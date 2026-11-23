package sqlite

import (
	"testing"

	"github.com/zitadel/nextgen/internal/domain"
	"github.com/zitadel/nextgen/internal/storage/database"
)

// This tests the conservative AST proof, not SQLite's parameter limit, the
// interrupted cursor work, real handler authentication, or a public route.
func TestDiagnosticShadowScopeEntailment(t *testing.T) {
	project := database.Col(domain.EventFieldProjectID)
	category := database.Col(domain.EventFieldCategory)
	equal := database.Equal(project, "p")
	keyset := database.Equal(project, "p")
	keyset.Keyset = true
	cases := []struct {
		name string
		filter database.Filter[domain.EventField]
		want bool
	}{
		{"nil", nil, false},
		{"exact", equal, true},
		{"nested conjunction", database.And(database.Equal(category, "x"), database.And(equal)), true},
		{"different project", database.Equal(project, "q"), false},
		{"different column", database.Equal(category, "p"), false},
		{"or may admit foreign", database.Or(equal, database.Equal(project, "q")), false},
		{"not", database.Not(equal), false},
		{"or inside conjunction", database.And(database.Or(equal, database.Equal(project, "q"))), false},
		{"keyset flag", keyset, false},
		{"tuple equality", database.CompareEqual(database.Term(project, "p"), database.Term(category, "x")), false},
		{"nonstring", database.Equal(project, []byte("p")), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := necessarilyScoped(tc.filter, "p"); got != tc.want {
				t.Fatalf("entailment = %v, want %v", got, tc.want)
			}
			reader := diagnosticShadowEventReader{projectID: "p"}
			options := &database.ListOptions[domain.EventField]{Filter: tc.filter}
			scoped, err := reader.scoped(options)
			if err != nil {
				t.Fatal(err)
			}
			if options.Filter == nil && tc.filter != nil {
				t.Fatal("input options changed")
			}
			if !necessarilyScoped(scoped.Filter, "p") {
				t.Fatal("result lacks a guaranteed trusted-project restriction")
			}
			if tc.want {
				// The exact original top-level filter is retained when it already
				// proves the scope; no additional project equality is appended.
				if a, ok := tc.filter.(*database.CompareFilter[domain.EventField]); ok && scoped.Filter != a {
					t.Fatal("already scoped equality was replaced")
				}
			} else if _, ok := scoped.Filter.(database.AndFilter[domain.EventField]); !ok {
				t.Fatal("unproven scope was not intersected")
			}
		})
	}
}
