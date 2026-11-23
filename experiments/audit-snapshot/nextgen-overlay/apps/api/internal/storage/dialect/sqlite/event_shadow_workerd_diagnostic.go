//go:build wasip1 && mapi_shadow_diagnostic

// Diagnostic entry for a disposable integration test. It does not implement
// user authorization, an API response, bounded Go memory or a production
// snapshot. The caller must hold the experimental shadow lease.
package sqlite

import (
	"context"
	"encoding/json"

	"github.com/zitadel/nextgen/internal/storage/events"
)

// DiagnosticShadowFrame invokes the same event statements as the retained
// shadow reader and returns a small test-only projection of its results.
func DiagnosticShadowFrame() ([]byte, error) {
	pool := NewCloudflarePool()
	defer pool.client.sqlDB.Close()
	reader, err := newDiagnosticShadowEventReader(pool.client, "shadow-a")
	if err != nil {
		return nil, err
	}
	opts := events.ListOptions("shadow-a", 0)
	opts.Pagination.OrderBy = events.CreatedAtAsc()
	result, err := reader.ListEvents(context.Background(), opts)
	if err != nil {
		return nil, err
	}
	type item struct {
		ID       string `json:"id"`
		Category string `json:"category"`
	}
	out := make([]item, 0, len(result.Items))
	for _, event := range result.Items {
		out = append(out, item{event.ID, string(event.Category)})
	}
	foreign, err := reader.ListEvents(context.Background(), events.ListOptions("shadow-b", 0))
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		Items   []item `json:"items"`
		Foreign int    `json:"foreign"`
	}{out, len(foreign.Items)})
}
