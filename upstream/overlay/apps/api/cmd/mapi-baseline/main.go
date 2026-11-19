// Command mapi-baseline creates a database containing only upstream migrations.
package main

import (
	"context"
	"database/sql"
	"log"
	"os"

	"github.com/zitadel/nextgen/internal/storage/dialect/sqlite/migration"
	_ "modernc.org/sqlite"
)

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: mapi-baseline DATABASE")
	}
	db, err := sql.Open("sqlite", os.Args[1])
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := migration.Migrate(context.Background(), db); err != nil {
		log.Fatal(err)
	}
}
