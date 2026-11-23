//go:build wasip1

package sqlite

import (
	"strings"

	"github.com/zitadel/nextgen/internal/storage/database"
)

// SQLite's LIKE sees text only up to the first NUL. SQLite Durable Objects
// also cap LIKE patterns at 50 bytes, so express literal matches using instr
// and substr instead of a pattern. Preserve LIKE's NUL and ASCII-fold rules.
func compileSubstringMatch(c *statementCompiler, column string, match database.StringMatch, value string, ignoreCase bool) {
	if nul := strings.IndexByte(value, 0); nul >= 0 {
		value = value[:nul]
		switch match {
		case database.StringMatchStartsWith:
			match = database.StringMatchEqual
		case database.StringMatchContains:
			match = database.StringMatchEndsWith
		}
	}
	text := "substr(" + column + ", 1, instr(" + column + " || char(0), char(0)) - 1)"
	if ignoreCase {
		text = "LOWER(" + text + ")"
	}
	writeValue := func() {
		if ignoreCase {
			c.WriteString("LOWER(")
		}
		writeArg(c, value)
		if ignoreCase {
			c.WriteString(")")
		}
	}
	switch match {
	case database.StringMatchEqual:
		c.WriteString("(")
		c.WriteString(text)
		c.WriteString(" = ")
		writeValue()
		c.WriteString(" COLLATE BINARY)")
	case database.StringMatchStartsWith, database.StringMatchContains:
		c.WriteString("(instr(")
		c.WriteString(text)
		c.WriteString(", ")
		writeValue()
		if match == database.StringMatchStartsWith {
			c.WriteString(") = 1)")
		} else {
			c.WriteString(") > 0)")
		}
	case database.StringMatchEndsWith:
		c.WriteString("(substr(")
		c.WriteString(text)
		c.WriteString(", length(")
		c.WriteString(text)
		c.WriteString(") - length(")
		writeValue()
		c.WriteString(") + 1) = ")
		writeValue()
		c.WriteString(" COLLATE BINARY)")
	default:
		panic("unknown string match")
	}
}
