import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const production = process.env.MAPI_MANAGEMENT_PRODUCTION === '1';
const combined = process.env.MAPI_MANAGEMENT_COMBINED === '1';
const phase1 = process.env.MAPI_PHASE1_OWNER === '1';
if (phase1 && (!production || !combined)) throw Error('Phase 1 owner requires the production combined build');
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
const wasmName = phase1 ? 'phase1-owner.wasm' : graphDiagnostic ? `events-graph-${graphDiagnostic}-test.wasm` : events ? (combined ? (noinline ? `events-combined-${noinlineSuffix}-test.wasm` : 'events-combined-test.wasm') : (noinline ? `events-${noinlineSuffix}-test.wasm` : 'events-test.wasm')) : combined ? (production ? 'combined.wasm' : 'combined-test.wasm') : (production ? 'management.wasm' : 'management-test.wasm');
// Isolate experimental hooks from the checked-out default/flow source.
const root = await realpath(await mkdtemp(resolve(tmpdir(), 'mapi-management-build-')));
let eventBundleDigest;
try {
  const source = resolve(root, 'nextgen');
  const commit = 'b0b74cd4a198428ea9b82910c217259ffc62b65c';
  await import('node:fs/promises').then(({ mkdir }) => mkdir(source));
  const archive = resolve(root, 'source.tar');
  execFileSync('git', ['-C', resolve('.mapi/nextgen'), 'archive', '--format=tar', `--output=${archive}`, commit], { stdio: 'inherit' });
  execFileSync('tar', ['-xf', archive, '-C', source], { stdio: 'inherit' });
  await cp('upstream/overlay', source, { recursive: true });
  execFileSync('git', ['apply', '--unidiff-zero', resolve('upstream/audit-tracing.patch')], { cwd: source, stdio: 'inherit' });
  if (events) {
    // The local event-read prototype needs MaPi event variants. Generate them
    // from the pinned source contract in this disposable archive; the normal
    // Phase 1 owner never mounts this experimental, over-budget graph.
    const marker = randomBytes(24).toString('hex');
    await writeFile(resolve(source, '.mapi-event-build-marker'), marker, { flag: 'wx', mode: 0o600 });
    execFileSync(process.execPath, [resolve('scripts/test-mapi-event-contract.mjs')], { stdio: 'inherit' });
    const { prepareMaPiEventContract } = await import(resolve('scripts/prepare-mapi-event-contract.mjs'));
    await prepareMaPiEventContract(source, marker);
    const apiDir = resolve(source, 'apps/api/api');
    const generationEnv = { ...process.env, GOWORK: 'off', GOTOOLCHAIN: 'go1.26.9' };
    execFileSync('go', ['run', './cmd/gen_event_schemas'], { cwd: apiDir, stdio: 'inherit', env: generationEnv });
    execFileSync('go', ['test', './cmd/gen_event_schemas'], { cwd: apiDir, stdio: 'inherit', env: generationEnv });
    const moduleRoot = process.env.MAPI_EVENT_BUNDLE_NODE_MODULES;
    if (!moduleRoot) throw Error('Event build requires a disposable, pinned Redocly installation for its OpenAPI bundle');
    const resolvedModules = await realpath(moduleRoot);
    if (!['/private/tmp/', '/private/var/folders/'].some(prefix => resolvedModules.startsWith(prefix))) throw Error('Event bundler dependencies must be disposable');
    const redocly = JSON.parse(await readFile(resolve(resolvedModules, '@redocly/openapi-core/package.json'), 'utf8'));
    if (redocly.version !== '2.76.0') throw Error('Event bundler requires pinned Redocly 2.76.0');
    await symlink(resolvedModules, resolve(source, 'node_modules'), 'dir');
    execFileSync(process.execPath, [resolve(source, 'scripts/bundle-openapi.mjs'), '--api'], { cwd: source, stdio: 'inherit' });
    const bundleBytes = await readFile(resolve(apiDir, 'openapi/bundled/openapi.json'));
    const bundle = JSON.parse(bundleBytes.toString('utf8'));
    // The Go OpenAPI handler serves json.Compact's byte representation, not
    // the whitespace-formatted embed. Preserve string escapes and numeric
    // spelling; JSON.parse/stringify could round int64 literals.
    const compact = Buffer.allocUnsafe(bundleBytes.length);
    let n = 0, quoted = false, escaped = false;
    for (const byte of bundleBytes) {
      if (!quoted && (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d)) continue;
      compact[n++] = byte;
      if (quoted && escaped) escaped = false;
      else if (quoted && byte === 0x5c) escaped = true;
      else if (byte === 0x22) quoted = !quoted;
    }
    eventBundleDigest = createHash('sha256').update(compact.subarray(0, n)).digest('hex');
    const { mapiEvents } = await import(resolve('scripts/mapi-event-contract.mjs'));
    const matches = [];
    const scan = value => {
      if (!value || typeof value !== 'object') return;
      if (value.propertyName === 'event_type' && value.mapping && typeof value.mapping === 'object') matches.push(value.mapping);
      for (const child of Object.values(value)) scan(child);
    };
    scan(bundle);
    if (!matches.some(mapping => mapiEvents.every(([name]) => Object.hasOwn(mapping, name)))) throw Error('Bundled event discriminator is incomplete');
    if (Object.keys(bundle.webhooks ?? {}).some(name => name.startsWith('mapi.'))) throw Error('MaPi webhook delivery was not established');
    execFileSync('go', ['tool', 'ogen', '--config', '.ogen.yaml', '--target', '../internal/api/generated', '--clean', 'openapi/openapi-spec.yaml'], { cwd: apiDir, stdio: 'inherit', env: generationEnv });
    execFileSync('go', ['tool', 'ogen', '--config', '.ogen-client.yaml', '--target', '../../../packages/go/api', '--package', 'api', '--clean', 'openapi/openapi-spec.yaml'], { cwd: apiDir, stdio: 'inherit', env: generationEnv });
    // Ogen's clean step removes MaPi's handwritten build-tagged route mounts.
    await cp('upstream/overlay/apps/api/internal/api/generated', resolve(source, 'apps/api/internal/api/generated'), { recursive: true });
    await cp('scripts/mapi-event-roundtrip-test.go', resolve(source, 'apps/api/internal/api/generated/mapi_event_roundtrip_test.go'));
    execFileSync('go', ['test', './internal/api/generated', '-run', '^TestMaPi'], { cwd: resolve(source, 'apps/api'), stdio: 'inherit', env: generationEnv });
  }
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
  const tags = ['mapi_management', ...(combined ? ['mapi_flow'] : []), ...(phase1 ? ['mapi_oauth'] : []), ...(events ? ['mapi_events'] : [])].join(',');
  execFileSync('go', ['build', `-tags=${tags}`, ...(noinline ? [noinlineTarget === 'generated' ? '-gcflags=github.com/zitadel/nextgen/internal/api/generated=-l' : '-gcflags=all=-l'] : []), '-trimpath', graphDump ? '-ldflags=-s -w -dumpdep' : '-ldflags=-s -w', '-buildmode=c-shared', '-o', out, './cmd/mapi-wasm'], { cwd: resolve(source, 'apps/api'), stdio: 'inherit', env: { ...process.env, GOWORK: 'off', GOOS: 'wasip1', GOARCH: 'wasm', CGO_ENABLED: '0', GOTOOLCHAIN: 'go1.26.9' } });
  if (!production && !combined) {
  let object = await readFile('worker/index.js', 'utf8');
  object = object.replace('"./generated/nextgen.wasm"', `"./${wasmName}"`).replace('"./generated/fixture.json"', '"./fixture.json"').replace('"./wasi.js"', '"../wasi.js"').replace('"./sql.js"', '"../sql.js"');
  await writeFile(events ? (noinline ? `worker/generated/events-${noinlineSuffix}-adapter-test-object.js` : 'worker/generated/events-adapter-test-object.js') : 'worker/generated/management-test-object.js', object);
  }
  let app = await readFile('worker/app.js', 'utf8');
  app = app.replace('"./generated/baseline.json"', '"./baseline.json"').replace('"./wasm-module.js"', `"./${wasmName}"`).replace(/from "\.\/([^"/]+\.js)"/g, 'from "../$1"');
  if (phase1) {
    const fenceImports = [...app.matchAll(/^import \{([^}]+)\} from "\.\.\/owner-fence\.js";$/gm)];
    const fenceNames = fenceImports.length === 1 ? fenceImports[0][1].split(',').map(name => name.trim()) : [];
    if (!fenceNames.includes('initializeOwnerFence') || !fenceNames.includes('withOwnerFence')) throw Error('Phase 1 owner fence import missing');
    const appAnchor = '  handleRequest(request) {';
    if (!app.includes(appAnchor)) throw Error('Phase 1 control hook anchor missing');
    app = app.replace(appAnchor, `  phase1Control(route, controlToken, action, userId) {
    const expected = this.env.MAPI_PHASE1_CONTROL_TOKEN;
    const suppliedBytes = encoder.encode(typeof controlToken === "string" ? controlToken : "");
    const expectedBytes = encoder.encode(typeof expected === "string" ? expected : "");
    const authorized = suppliedBytes.length === expectedBytes.length
      ? crypto.subtle.timingSafeEqual(suppliedBytes, expectedBytes)
      : !crypto.subtle.timingSafeEqual(suppliedBytes, suppliedBytes);
    if (!expected || !authorized) throw new Error("Control denied");
    if (this.env.MAPI_MAINTENANCE === "1") throw new Error("Owner unavailable");
    if (action === "initialize-fence") {
      if (this.env.MAPI_PHASE1_ALLOW_BOOTSTRAP !== "1" || route.generation !== 1 || this.projectId() !== route.projectId || this.projectOrigin() !== route.origin) throw new Error("Invalid bootstrap");
      initializeOwnerFence(this.ctx.storage, route);
      this.#fenceArmed = true;
      return true;
    }
    return this.#withRoute(route, () => {
      withOwnerFence(this.ctx.storage, route, () => {});
      if (action === "project-token") {
        this.#initialize();
        return this.#call("mapi_project_token", { projectId: route.projectId }).token;
      }
      if (action === "user-audit" && typeof userId === "string" && /^user_[A-Za-z0-9_-]+$/.test(userId)) {
        return withOwnerFence(this.ctx.storage, route, () => this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM events WHERE project_id = ? AND entity_id = ? AND event_type = 'user.created'", route.projectId, userId).one().count);
      }
      throw new Error("Invalid control action");
    });
  }

${appAnchor}`);
  }
  if (!production) {
  const appAnchor = '  handleRequest(request) {';
  if (!app.includes(appAnchor)) throw Error('Application test hook anchor missing');
  app = app.replace(appAnchor, `  testManagementToken(route) {
    if (this.env.MAPI_LOCAL_TEST !== "1") throw new Error("Local only");
    return this.#withRoute(route, () => {
      if (!this.#admitRoute(route)) throw new Error("Invalid test route");
      this.#initialize();
      return this.#call("mapi_project_token", { projectId: route.projectId }).token;
    });
  }

${appAnchor}`);
  }
  const appPath = phase1 ? 'worker/generated/phase1-owner-app.js' : graphDiagnostic ? `worker/generated/events-graph-${graphDiagnostic}-test-app.js` : events ? (combined ? (noinline ? `worker/generated/events-combined-${noinlineSuffix}-test-app.js` : 'worker/generated/events-combined-test-app.js') : (noinline ? `worker/generated/events-${noinlineSuffix}-test-app.js` : 'worker/generated/events-test-app.js')) : combined ? (production ? 'worker/generated/combined-app-base.js' : 'worker/generated/combined-test-app.js') : (production ? 'worker/generated/management-app-base.js' : 'worker/generated/management-test-app.js');
  await writeFile(appPath, app);
  if (events) await writeFile(resolve('worker/generated', wasmName.replace(/\.wasm$/, '-openapi-sha256.json')), JSON.stringify({ sha256: eventBundleDigest }) + '\n');
  console.log(`Built isolated ${combined ? 'combined' : 'management'}${events ? ' events' : ''} ${production ? 'owner' : 'test'} adapter.`);
} finally { await rm(root, { recursive: true, force: true }); }
