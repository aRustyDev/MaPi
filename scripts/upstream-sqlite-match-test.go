//go:build wasip1 && sqlite_integration

package stmttest

import (
	"fmt"
	"strings"
	"testing"

	"github.com/zitadel/nextgen/internal/cloudflarewasm"
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite"
)

func TestMaPiSubstringAgainstPinnedLIKE(t *testing.T) {
	db := cloudflarewasm.Open()
	defer db.Close()
	values := []string{"", "a", "A", "abc", "ABC", "%", "_", `\`, "a%b_c", "é", "É", "😀a", "ab\x00tail", "\x00a"}
	for _, haystack := range values {
		for _, needle := range values {
			for _, match := range []database.StringMatch{database.StringMatchStartsWith, database.StringMatchContains, database.StringMatchEndsWith} {
				for _, fold := range []bool{false, true} {
					var result [2]int64
					for i := range result {
						predicate, args := sqlite.MaPiMatchPredicate(match, needle, fold, i == 0)
						args = append(args, haystack)
						if err := db.QueryRow("SELECT "+predicate+" FROM (SELECT ? AS col)", args...).Scan(&result[i]); err != nil {
							t.Fatalf("query %q %q %d %v: %v", haystack, needle, match, fold, err)
						}
					}
					if result[0] != result[1] {
						t.Errorf("mismatch haystack=%q needle=%q match=%d fold=%v reference=%d actual=%d", haystack, needle, match, fold, result[0], result[1])
					}
				}
			}
		}
	}
	long := strings.Repeat("x", 80) + "%_\\"
	for _, match := range []database.StringMatch{database.StringMatchStartsWith, database.StringMatchContains, database.StringMatchEndsWith} {
		predicate, args := sqlite.MaPiMatchPredicate(match, long, false, false)
		args = append(args, long)
		var got int64
		if err := db.QueryRow("SELECT "+predicate+" FROM (SELECT ? AS col)", args...).Scan(&got); err != nil || got != 1 {
			t.Errorf("long literal match %s got %d: %v", fmt.Sprint(match), got, err)
		}
	}
}
