// Local-only integration harness. Never deploy this Worker: its private test
// endpoint returns a synthetic RP secret to the loopback test runner.
import { DurableObject } from "cloudflare:workers";
import wasm from "../worker/generated/oauth-composition-test.wasm";
import baseline from "../worker/generated/baseline.json";
import { instantiateReactor } from "../worker/wasi.js";
import { execute, sqliteError } from "../worker/sql.js";
import { renderLogin } from "../worker/login-ui.js";
import { handleFlowProxy } from "../worker/flow-proxy.js";

const encoder = new TextEncoder(), decoder = new TextDecoder(), rejected = Symbol("rollback");
export class OAuthBrowserTest extends DurableObject {
  #reactor; #memory;
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS mapi_test_initialized (done INTEGER NOT NULL)");
      if (ctx.storage.sql.exec("SELECT done FROM mapi_test_initialized").toArray().length) return;
      for (const statement of baseline.statements) ctx.storage.sql.exec(statement);
      ctx.storage.sql.exec("CREATE TABLE mapi_project (project_id TEXT PRIMARY KEY, schema_url TEXT NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE mapi_project_origin (origin TEXT NOT NULL)");
      ctx.storage.sql.exec("INSERT INTO mapi_project_origin VALUES (?)", env.TEST_ORIGIN);
      ctx.storage.sql.exec("INSERT INTO mapi_test_initialized VALUES (1)");
    });
  }
  #initialize() {
    if (this.#reactor) return;
    let output;
    this.#reactor = instantiateReactor(wasm, (memory) => {
      this.#memory = memory;
      return {
        sql: (p,n) => { const q=JSON.parse(decoder.decode(new Uint8Array(memory(),p,n))); let result; try { result=execute(this.ctx.storage,q); } catch(e) { result={error:sqliteError(e)}; } output=encoder.encode(JSON.stringify(result)); return output.length; },
        result: (p,n) => { new Uint8Array(memory(),p,n).set(output); output.fill(0); output=undefined; },
        transaction: () => { try { this.ctx.storage.transactionSync(() => { if(this.#reactor.mapi_transaction_body()!==0) throw rejected; }); return 0; } catch(e) { return e===rejected?1:2; } },
      };
    });
    this.#call("mapi_init", {id:"master-test",pem:this.env.TEST_MASTER_KEY,projectId:this.project()});
  }
  #call(name, value) {
    const bytes=encoder.encode(JSON.stringify(value)), p=this.#reactor.mapi_alloc(bytes.length);
    new Uint8Array(this.#memory(),p,bytes.length).set(bytes); bytes.fill(0);
    const packed=this.#reactor[name](), ptr=Number(packed>>32n), size=Number(packed&0xffffffffn);
    const result=JSON.parse(decoder.decode(new Uint8Array(this.#memory(),ptr,size))); this.#reactor.mapi_release();
    if(result?.error) throw new Error(`${name}: ${result.error}`);
    return result;
  }
  project() { return this.ctx.storage.sql.exec("SELECT project_id FROM mapi_project").toArray()[0]?.project_id ?? ""; }
  setup({email,password,redirectURI}) {
    this.#initialize();
    if(this.project()) throw new Error("already initialized");
    const project=this.#call("mapi_provision",{name:"Local OAuth browser test",origin:this.env.TEST_ORIGIN}).projectId;
    this.#call("mapi_init",{id:"master-test",pem:this.env.TEST_MASTER_KEY,projectId:project});
    this.#call("mapi_add_user",{projectId:project,email,password});
    const args={projectId:project,origin:this.env.TEST_ORIGIN};
    this.#call("mapi_oauth_admin",{...args,action:"initialize"});
    const app=this.#call("mapi_oauth_admin",{...args,action:"register",document:{slug:"test-rp",name:"Local test RP",clients:[{slug:"web",type:"confidential",grant_types:["authorization_code","refresh_token"],redirect_uris:[redirectURI]}]}});
    return { projectId:project,clientId:app.Secrets[0].ClientID,clientSecret:app.Secrets[0].Secret };
  }
  flowRequest(request) {
    this.#initialize();
    if(new URL(request.url).pathname==="/api/v1/sessions/exchange") request.headers.authorization=[`Bearer ${this.#call("mapi_project_token",{projectId:this.project()}).token}`];
    return this.#call("mapi_request",request);
  }
  oauthRequest(request) {
    this.#initialize();
    return this.#call("mapi_oauth_request",{projectId:this.project(),origin:this.env.TEST_ORIGIN,request});
  }
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url), object=env.OAUTH_BROWSER_TEST.getByName("isolated");
    if(url.origin!==env.TEST_ORIGIN) return new Response(null,{status:404});
    if(url.pathname==="/_test/setup"&&request.method==="POST") {
      if(request.headers.get("authorization")!==`Bearer ${env.TEST_AUTH}`) return new Response(null,{status:404});
      return Response.json(await object.setup(await request.json()),{headers:{"cache-control":"no-store"}});
    }
    const project=await object.project();
    if(!project)return new Response(null,{status:503});
    if(url.pathname==="/zitadel-login.mjs")return env.ASSETS.fetch(request);
    if(url.pathname==="/login"&&request.method==="GET")return renderLogin(project,url.searchParams.get("mapi_oauth")??"");
    if(url.pathname.startsWith("/__nextgen/"))return handleFlowProxy(request,object,project,env.TEST_ORIGIN);
    const prefix=`/oauth/${project}/`;
    if(url.pathname==="/oauth/continue"||["authorize","token","jwks"].some(s=>url.pathname===prefix+s)){
      const headers={};
      for(const name of ["accept","authorization","content-type","cookie","origin","user-agent"])if(request.headers.has(name))headers[name]=[request.headers.get(name)];
      const body=request.body?new Uint8Array(await request.arrayBuffer()):new Uint8Array();
      if(body.length>65536)return new Response(null,{status:413});
      const result=await object.oauthRequest({method:request.method,url:request.url,headers,body:body.toBase64(),peer:"127.0.0.1"});
      if(url.pathname==="/oauth/continue"&&request.method==="POST"&&result.status===403){
        const names=(request.headers.get("cookie")??"").split(";").map(p=>p.trim().split("=")[0]);
        const form=new URLSearchParams(decoder.decode(body));
        console.error("Continuation rejected",JSON.stringify({origin:request.headers.get("origin"),expectedOrigin:env.TEST_ORIGIN,sessionCookie:names.includes("__Host-zitadel_session"),bindingCookies:names.filter(n=>n.startsWith("__Host-mapi-oauth-")).length,hasRequest:form.has("request"),hasCSRF:form.has("csrf")}));
      }
      const outgoing=new Headers({"cache-control":"no-store"});
      for(const [name,values] of Object.entries(result.headers))for(const value of values)outgoing.append(name,value);
      return new Response(result.body?Uint8Array.fromBase64(result.body):null,{status:result.status,headers:outgoing});
    }
    return new Response(null,{status:404});
  },
};
