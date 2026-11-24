# Experimental audit event reads

The build commands and size measurements below describe the earlier pinned-event prototype. The current event test build also generates the MaPi audit-read variants and a matching OpenAPI bundle, and requires `MAPI_EVENT_BUNDLE_NODE_MODULES` to point to a disposable installation of the pinned Redocly dependency. Follow the isolated setup in `audit-relocation-local-proof.md` before rerunning these build commands. The current event-and-OAuth relocation test Worker is larger than the earlier measurements and remains above the 55 MiB limit; the historical figures below are not its artifact measurements.

The `mapi_events` Go build tag adds the pinned Nextgen `GET /events` and `GET /events/{event_id}` handlers, including their `/api/v1` aliases. The local-only build wires the pinned `EventService`, Ogen security and decoding, upstream project authorization, and the pre-claim visibility gate. The main management and combined owner builds do **not** include this tag or mount these handlers. No public Worker ingress exposes them.

After preparing the pinned checkout and installing dependencies with `npm ci` and `bash scripts/build.sh`, run:

```sh
node scripts/build-events-test.mjs
node scripts/test-events-parity.mjs
node scripts/parity-inventory.mjs --check
```

The test starts a native v0.7.0 server and workerd, creates two synthetic projects and a user, and loads the same SQLite snapshot into the Worker. It installs an owning-team assignment directly in the synthetic native database to represent a claimed project; it does not test the claim workflow. It compares five one-event cursor pages of actual upstream admin mutation records, reads an event by ID, tests event-type filtering, root aliases, invalid pagination, missing credentials, preview credentials, a different project's credential, mismatched project IDs and unclaimed-project invisibility. Filtering to admin events avoids differences from the native server's separate request auditing. Project data for this test resides in one fixture object, so this is not evidence of cross-object delegation or of status-code parity for independently keyed objects.

The event service is deliberately configured with an empty platform-project ID. Platform operator access, team-scoped grants, user session authorization, real claim changes, time-range and ascending pagination, all filters, request-event writes, export, retention and deletion are untested. The Worker prototype lacks the native server's full request-audit middleware, so reading existing mutation records is not complete audit parity. These events can contain sensitive user and operational data; any future ingress must enforce the full upstream authorization model and tenant boundary, limit output and load, return no-store, and avoid logging credentials or event contents.

## Runtime budget and deployment boundary

The separately tagged local test reactor measured **59,783,584 bytes** (about 57.0 MiB) of Wasm, versus 53,217,511 bytes for the management-only test reactor. The complete synthetic event-test Worker dry run was **58,516.11 KiB uncompressed / 11,159.75 KiB gzip**. A diagnostic combined flow + management + events reactor measured **60,747,811 bytes** (about 57.9 MiB) of Wasm, before Worker JavaScript and other assets. Both exceed the roadmap's **55 MiB uncompressed Worker budget**. These are local build-size measurements, not hosted startup, CPU, isolate-memory or capacity results. The diagnostic build can be reproduced with `node scripts/build-events-combined-test.mjs`; it is local-only.

Possible next steps are to reduce the pinned event serialization dependency graph and measure again, or design a bounded separate workload after proving its authorization, ownership, consistency and operational behavior. A separate ingress Worker alone cannot reduce the owner's graph: calls to an external Durable Object execute the owner Worker's code. A container fallback or a separated read workload would require an explicit protocol for authoritative state and the same isolation, parity, recovery and audit tests. No fallback has been implemented or approved, and no event workload has been deployed.

## Dependency and size investigation

The current combined event adapter did **not** meet the 55 MiB budget after compiler-only size experiments. The upstream behavior, authorization, event conversion, Ogen decoder and encoder remain unchanged in the normal build; no reduced-semantics implementation has been selected.

| Diagnostic build | Go Wasm bytes |
| --- | ---: |
| Combined flow/management, event routes absent | 54,179,909 |
| Event Ogen routes retained, event handlers replaced with 404 stubs | 57,878,991 |
| Full combined event behavior | 60,747,811 |
| Full behavior, global Go inlining disabled | 60,838,786 |
| Full behavior, inlining disabled only for generated API package | 62,577,029 |

The stubbed build is **deliberately incorrect** and only isolates dependency cost; even it exceeds 55 MiB by 207,311 bytes before Worker overhead. The full diagnostic Worker, including JavaScript and baseline schema, measured **59,438.55 KiB uncompressed / 11,347.28 KiB gzip**, exceeding the 55 MiB budget by **3,118.55 KiB**. This diagnostic Worker contains a local test-only credential helper and must never be deployed. The dry run is a bundle-size check, not a hosted runtime or capacity test.

The Ogen `Event` sum type has 52 variants. The pinned handler serializes a domain event, decodes that JSON through the generated discriminator into the typed sum, and encodes the response through generated schemas. A Go linker dependency-graph comparison between the no-event and full-event builds showed 7,028 newly reachable symbols: 3,569 generated API symbols (3,074 with `Event` in their name), 2,581 type symbols, and 597 string symbols. Counts are not byte attribution, and graph changes overlap. In a further deliberately invalid diagnostic, removing only the generated union encoder saved 346,052 bytes; removing only its decoder saved 39,568 bytes. Those limited changes are not equivalent to removing the full event graph: variant types and methods remain reachable through interfaces and metadata. The 404-stub measurement also renames the original handler methods in the temporary tree to prevent Go interface method retention from invalidating the comparison.

Reproduce the isolated measurements from a prepared pinned checkout:

```sh
node scripts/build-events-combined-test.mjs
MAPI_WASM_NO_INLINE=1 node scripts/build-events-combined-test.mjs
MAPI_WASM_NO_INLINE=generated node scripts/build-events-combined-test.mjs
MAPI_EVENTS_GRAPH_DIAGNOSTIC=no-mount node scripts/build-events-combined-test.mjs
MAPI_EVENTS_GRAPH_DIAGNOSTIC=stub node scripts/build-events-combined-test.mjs
MAPI_EVENTS_GRAPH_DIAGNOSTIC=stub-encode node scripts/build-events-combined-test.mjs
MAPI_EVENTS_GRAPH_DIAGNOSTIC=stub-decode node scripts/build-events-combined-test.mjs
MAPI_EVENTS_GRAPH_DUMP=1 MAPI_EVENTS_GRAPH_DIAGNOSTIC=no-mount node scripts/build-events-combined-test.mjs > /tmp/mapi-events-baseline-graph.txt 2>&1
MAPI_EVENTS_GRAPH_DUMP=1 node scripts/build-events-combined-test.mjs > /tmp/mapi-events-full-graph.txt 2>&1
node scripts/analyze-events-graph.mjs /tmp/mapi-events-baseline-graph.txt /tmp/mapi-events-full-graph.txt
WRANGLER_LOG_PATH=/tmp/mapi-events-combined-size.log WRANGLER_SEND_METRICS=false node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config scripts/events-combined-size.wrangler.jsonc --outdir /tmp/mapi-events-combined-size
```

The options that replace handlers or encoders modify only a temporary copy of the pinned source and write ignored diagnostic artifacts with distinct names. They are not correctness tests and are not safe to deploy. Compiler no-inlining trials were larger and have not been adopted. `node scripts/test-events-parity.mjs` continues to exercise the intact event build.

A promising next investigation is a behavior-preserving generated-code refactor that reduces the union and interface method graph, validated against every event variant, malformed historical payloads, native errors, pagination and authorization. Alternatively, a dedicated read workload could perform serialization outside the owner, but project and credential authorization, visibility, revocation and the event read must remain on authoritative owner state with a consistent snapshot and a trusted, bounded internal protocol. An external Durable Object binding still runs the owner's code, and merely moving ingress cannot shed the owner graph. A container fallback or a read replica requires explicit isolation, consistency, outage, audit and recovery tests before acceptance; neither has been implemented here.
