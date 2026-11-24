//go:build wasip1 && sqlite_integration

package sqlite

import (
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/dialect/pattern"
)

func MaPiMatchPredicate(match database.StringMatch, value string, fold, reference bool) (string, []any) {
	var c statementCompiler
	if reference {
		pattern.CompileLikeMatch(&c, "col", match, value, fold)
		c.WriteString(` ESCAPE '\'`)
	} else {
		compileSubstringMatch(&c, "col", match, value, fold)
	}
	return c.String(), c.args
}
