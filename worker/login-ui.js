// The value is inserted into an HTML attribute and is also an upstream
// project identifier. Refuse anything outside the upstream identifier syntax.
export function renderLogin(projectId, oauthHandle = "") {
  if (!/^proj_[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("Invalid project ID");
  if (oauthHandle && !/^[A-Za-z0-9_-]{43}$/.test(oauthHandle)) throw new Error("Invalid OAuth request handle");
  const destination = oauthHandle ? `/oauth/continue?request=${oauthHandle}` : "/app";
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in</title>
  <script type="module" src="/zitadel-login.mjs"></script>
</head>
<body>
  <zitadel-login project-id="${projectId}" proxy-path="/__nextgen" purpose="login" variant="page" post-sign-in-url="${destination}"></zitadel-login>
</body>
</html>`, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
