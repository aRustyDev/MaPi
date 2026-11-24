package cloudflarewasm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
)

func Open() *sql.DB {
	return sql.OpenDB(connector{})
}

type connector struct{}

func (connector) Driver() driver.Driver                        { return conn{} }
func (connector) Connect(context.Context) (driver.Conn, error) { return conn{}, nil }

type conn struct{}

func (conn) Open(string) (driver.Conn, error)    { return conn{}, nil }
func (conn) Prepare(string) (driver.Stmt, error) { return nil, errors.ErrUnsupported }
func (conn) Close() error                        { return nil }
func (conn) Begin() (driver.Tx, error)           { return nil, errors.ErrUnsupported }

type sqlValue struct {
	Kind  string `json:"kind"`
	Value any    `json:"value"`
}

type sqlResponse struct {
	Columns []string            `json:"columns"`
	Rows    [][]json.RawMessage `json:"rows"`
	Changes int64               `json:"changes"`
	Error   *SQLError           `json:"error"`
}

type SQLError struct {
	Message      string `json:"message"`
	ExtendedCode int    `json:"code"`
}

func (e *SQLError) Error() string { return e.Message }
func (e *SQLError) Code() int     { return e.ExtendedCode }

func execute(ctx context.Context, statement string, args []driver.NamedValue, query bool) (*sqlResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	values := make([]sqlValue, 0, len(args))
	for _, arg := range args {
		switch value := arg.Value.(type) {
		case int64:
			values = append(values, sqlValue{"int", strconv.FormatInt(value, 10)})
		case []byte:
			if value == nil {
				values = append(values, sqlValue{"", nil})
			} else {
				values = append(values, sqlValue{"blob", base64.StdEncoding.EncodeToString(value)})
			}
		case bool:
			integer := 0
			if value {
				integer = 1
			}
			values = append(values, sqlValue{"", integer})
		default:
			values = append(values, sqlValue{"", value})
		}
	}
	var response sqlResponse
	err := callSQL(struct {
		Statement string     `json:"statement"`
		Args      []sqlValue `json:"args"`
		Query     bool       `json:"query"`
	}{statement, values, query}, &response)
	if err != nil {
		return nil, err
	}
	if response.Error != nil {
		return nil, response.Error
	}
	return &response, nil
}

func (conn) ExecContext(ctx context.Context, sql string, args []driver.NamedValue) (driver.Result, error) {
	result, err := execute(ctx, sql, args, false)
	if err != nil {
		return nil, err
	}
	return driver.RowsAffected(result.Changes), nil
}

func (conn) QueryContext(ctx context.Context, sql string, args []driver.NamedValue) (driver.Rows, error) {
	result, err := execute(ctx, sql, args, true)
	if err != nil {
		return nil, err
	}
	return &rows{columns: result.Columns, data: result.Rows}, nil
}
