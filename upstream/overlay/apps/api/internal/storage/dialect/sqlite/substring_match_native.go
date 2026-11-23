//go:build !wasip1

package sqlite

import (
	"github.com/zitadel/nextgen/internal/storage/database"
	"github.com/zitadel/nextgen/internal/storage/dialect/pattern"
)

func compileSubstringMatch(c *statementCompiler, column string, match database.StringMatch, value string, ignoreCase bool) {
	pattern.CompileLikeMatch(c, column, match, value, ignoreCase)
	c.WriteString(` ESCAPE '\'`)
}
