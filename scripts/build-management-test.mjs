import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const production = process.env.MAPI_MANAGEMENT_PRODUCTION === '1';
const combined = process.env.MAPI_MANAGEMENT_COMBINED === '1';
const events = process.env.MAPI_EVENTS_TEST === '1';
const graphDiagnostic = process.env.MAPI_EVENTS_GRAPH_DIAGNOSTIC || '';
const graphDump = process.env.MAPI_EVENTS_GRAPH_DUMP === '1';
if (graphDump && (!events || !combined || production)) throw Error('Graph dumps are diagnostic only');
if (!['', 'stub', 'no-mount', 'stub-encode', 'stub-decode'].includes(graphDiagnostic) || (graphDiagnostic && (!events || !combined || production))) throw Error('Invalid events graph diagnostic');
const noinlineTarget = process.env.MAPI_WASM_NO_INLINE || '';
if (!['', '1', 'generated'].includes(noinlineTarget)) throw Error('Unknown no-inline setting');
const noinline = noinlineTarget !== '';
const noinlineSuffix = noinlineTarget === 'generated' ? 'noinline-generated' : 'noinline';
if (noinline && (!events || production)) throw Error('No-inline builds are diagnostic only');
if (production && events) throw Error('The events build is local-only');
const wasmName = graphDiagnostic ? `events-graph-${graphDiagnostic}-test.wasm` : events ? (combined ? (noinline ? `events-combined-${noinlineSuffix}-test.wasm` : 'events-combined-test.wasm') : (noinline ? `events-${noinlineSuffix}-test.wasm` : 'events-test.wasm')) : combined ? (production ? 'combined.wasm' : 'combined-test.wasm') : (production ? 'management.wasm' : 'management-test.wasm');
// Isolate experimental hooks from the checked-out default/flow source.
const root = await mkdtemp(resolve(tmpdir(), 'mapi-management-build-'));
try {
  const source = resolve(root, 'nextgen');
  const commit = 'b0b74cd4a198428ea9b82910c217259ffc62b65c';
  await import('node:fs/promises').then(({ mkdir }) => mkdir(source));
  const archive = resolve(root, 'source.tar');
  execFileSync('git', ['-C', resolve('.mapi/nextgen'), 'archive', '--format=tar', `--output=${archive}`, commit], { stdio: 'inherit' });
  execFileSync('tar', ['-xf', archive, '-C', source], { stdio: 'inherit' });
  await cp('upstream/overlay', source, { recursive: true });
  execFileSync('git', ['apply', '--unidiff-zero', resolve('upstream/audit-tracing.patch')], { cwd: source, stdio: 'inherit' });
  for (const file of ['dialect', 'error', 'pool', 'with_transaction']) {
    const path = resolve(source, `apps/api/internal/storage/dialect/sqlite/${file}.go`);
    await writeFile(path, `//go:build !wasip1\n\n${await readFile(path, 'utf8')}`);
  }
  if (graphDiagnostic === 'stub-encode' || graphDiagnostic === 'stub-decode') {
    const path = resolve(source, 'apps/api/internal/api/generated/oas_json_gen.go');
    let generated = await readFile(path, 'utf8');
    const start = graphDiagnostic === 'stub-encode' ? 'func (s Event) encodeFields(e *jx.Encoder) {' : 'func (s *Event) Decode(d *jx.Decoder) error {';
    const next = graphDiagnostic === 'stub-encode' ? '// Decode decodes Event from json.' : '// MarshalJSON implements stdjson.Marshaler.';
    const i = generated.indexOf(start), j = generated.indexOf(next, i);
    if (i < 0 || j < 0) throw Error('Generated event diagnostic anchor missing');
    const stub = graphDiagnostic === 'stub-encode' ? 'func (s Event) encodeFields(e *jx.Encoder) {}\n\n' : 'func (s *Event) Decode(d *jx.Decoder) error { return nil }\n\n';
    generated = generated.slice(0, i) + stub + generated.slice(j);
    await writeFile(path, generated);
  }
  if (graphDiagnostic === 'stub') {
    const path = resolve(source, 'apps/api/internal/api/mapi_events_wasip1.go');
    let eventSource = await readFile(path, 'utf8');
    eventSource = eventSource.replace('return r.handler.ListEvents(ctx, p)', 'return nil, domain.ErrEventNotFound()').replace('return r.handler.GetEvent(ctx, p)', 'return nil, domain.ErrEventNotFound()').replace('"github.com/zitadel/nextgen/internal/service"', '"github.com/zitadel/nextgen/internal/service"\n "github.com/zitadel/nextgen/internal/domain"');
    if (eventSource.includes('return r.handler.ListEvents(ctx, p)') || !eventSource.includes('domain.ErrEventNotFound()')) throw Error('Diagnostic event stub failed');
    await writeFile(path, eventSource);
    // Diagnostic only: prevent *Handler's promoted Ogen interface from keeping
    // the original implementations alive through an interface method table.
    const originalPath = resolve(source, 'apps/api/internal/api/event.go');
    let original = await readFile(originalPath, 'utf8');
    original = original.replace('func (h *Handler) ListEvents(', 'func (h *Handler) DiagnosticListEvents(').replace('func (h *Handler) GetEvent(', 'func (h *Handler) DiagnosticGetEvent(');
    if (!original.includes('func (h *Handler) DiagnosticListEvents(') || !original.includes('func (h *Handler) DiagnosticGetEvent(')) throw Error('Diagnostic method anchor missing');
    await writeFile(originalPath, original);
  }
  const adapter = resolve(source, 'apps/api/internal/api/cloudflare_wasip1.go');
  let code = await readFile(adapter, 'utf8');
  const anchor = '\tmux := http.NewServeMux()';
  if (!code.includes(anchor)) throw Error('Adapter hook anchor missing');
  code = code.replace(anchor, anchor + '\n\tconfigureMaPiManagement(h, server, mux)' + (events && graphDiagnostic !== 'no-mount' ? '\n\tconfigureMaPiEvents(h, server, mux)' : ''));
  await writeFile(adapter, code);
  const out = resolve('worker/generated', wasmName);
  const tags = ['mapi_management', ...(combined ? ['mapi_flow'] : []), ...(events ? ['mapi_events'] : [])].join(',');
  execFileSync('go', ['build', `-tags=${tags}`, ...(noinline ? [noinlineTarget === 'generated' ? '-gcflags=github.com/zitadel/nextgen/internal/api/generated=-l' : '-gcflags=all=-l'] : []), '-trimpath', graphDump ? '-ldflags=-s -w -dumpdep' : '-ldflags=-s -w', '-buildmode=c-shared', '-o', out, './cmd/mapi-wasm'], { cwd: resolve(source, 'apps/api'), stdio: 'inherit', env: { ...process.env, GOWORK: 'off', GOOS: 'wasip1', GOARCH: 'wasm', CGO_ENABLED: '0', GOTOOLCHAIN: 'go1.26.9' } });
  if (!production && !combined) {
  let object = await readFile('worker/index.js', 'utf8');
  object = object.replace('"./generated/nextgen.wasm"', `"./${wasmName}"`).replace('"./generated/fixture.json"', '"./fixture.json"').replace('"./wasi.js"', '"../wasi.js"').replace('"./sql.js"', '"../sql.js"');
  await writeFile(events ? (noinline ? `worker/generated/events-${noinlineSuffix}-adapter-test-object.js` : 'worker/generated/events-adapter-test-object.js') : 'worker/generated/management-test-object.js', object);
  }
  let app = await readFile('worker/app.js', 'utf8');
  app = app.replace('"./generated/baseline.json"', '"./baseline.json"').replace('"./wasm-module.js"', `"./${wasmName}"`).replace(/from "\.\/([^"/]+\.js)"/g, 'from "../$1"');
  if (!production) {
  const appAnchor = '  handleRequest(request) {';
  if (!app.includes(appAnchor)) throw Error('Application test hook anchor missing');
  app = app.replace(appAnchor, `  testManagementToken() {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local only");
    this.#initialize();
    return this.#call("mapi_project_token", { projectId: this.projectId() }).token;
  }

${appAnchor}`);
  }
  const appPath = graphDiagnostic ? `worker/generated/events-graph-${graphDiagnostic}-test-app.js` : events ? (combined ? (noinline ? `worker/generated/events-combined-${noinlineSuffix}-test-app.js` : 'worker/generated/events-combined-test-app.js') : (noinline ? `worker/generated/events-${noinlineSuffix}-test-app.js` : 'worker/generated/events-test-app.js')) : combined ? (production ? 'worker/generated/combined-app-base.js' : 'worker/generated/combined-test-app.js') : (production ? 'worker/generated/management-app-base.js' : 'worker/generated/management-test-app.js');
  await writeFile(appPath, app);
  console.log(`Built isolated ${combined ? 'combined' : 'management'}${events ? ' events' : ''} ${production ? 'owner' : 'test'} adapter.`);
} finally { await rm(root, { recursive: true, force: true }); }
