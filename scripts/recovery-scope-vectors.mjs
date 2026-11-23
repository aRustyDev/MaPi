// Expected strings were independently checked with Go 1.26.9 json.Marshal.
export function canonicalScopeVectors(projectId) {
  const project = JSON.stringify(projectId);
  return [
    String.raw`{"v":1,"kind":"team-update","args":[${project},"HTML\u003c\u003e\u0026"]}`,
    String.raw`{"v":1,"kind":"team-update","args":[${project},"line\u2028sep\u2029"]}`,
    `{"v":1,"kind":"team-update","args":[${project},"Unicode-é-日本-😀"]}`,
    String.raw`{"v":1,"kind":"team-update","args":[${project},"controls-\u0000-\b-\f-\n-\r-\t-\u001f-\\-\"-/"]}`,
  ];
}
export function noncanonicalScopeVectors(projectId) {
  const project = JSON.stringify(projectId);
  return [
    '{"v": 1,"kind":"project-create","args":null}',
    '{"kind":"project-create","v":1,"args":null}',
    String.raw`{"v":1,"kind":"\u0070roject-create","args":null}`,
    `{"v":1,"kind":"team-update","args":[${project},"HTML<>&"]}`,
    String.raw`{"v":1,"kind":"team-update","args":[${project},"HTML\u003C\u003e\u0026"]}`,
    `{"v":1,"kind":"team-update","args":[${project},"line${String.fromCodePoint(0x2028)}sep"]}`,
    String.raw`{"v":1,"kind":"team-update","args":[${project},"esc\u0061pe"]}`,
    String.raw`{"v":1,"kind":"team-update","args":[${project},"emoji-\ud83d\ude00"]}`,
    String.raw`{"v":1,"kind":"team-update","args":[${project},"slash\/value"]}`,
  ];
}
