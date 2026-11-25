import assert from "node:assert/strict";
import { execute } from "../worker/sql.js";

let seen;
const storage = { sql: { exec(sql, ...values) {
  if (sql === "SELECT changes() AS count") return { one: () => ({ count: 1 }) };
  seen = { sql, values };
  return { rowsWritten: 1, toArray: () => [] };
} } };
const text = (value) => ({ kind: "text", value });
const integer = (value) => ({ kind: "int", value });
function bind(statement, args) { return execute(storage, { statement, args, query: false }); }

bind("UPDATE t SET x=?2 WHERE y=?1 OR z=?2", [text("first"), integer("9007199254740993")]);
assert.equal(seen.sql, "UPDATE t SET x=CAST(?2 AS INTEGER) WHERE y=?1 OR z=CAST(?2 AS INTEGER)");
assert.deepEqual(seen.values, ["first", "9007199254740993"]);
bind("UPDATE t SET a=?2, b=?, c=?1, d=?", [text("a"), text("b"), text("c"), integer("4")]);
assert.equal(seen.sql, "UPDATE t SET a=?2, b=?3, c=?1, d=CAST(?4 AS INTEGER)");
assert.deepEqual(seen.values, ["a", "b", "c", "4"]);
bind("UPDATE t SET x='?1', y=\"?2\", z=`?3`, [??]=?1 /* ?4 */ -- ?5\n", [text("safe")]);
assert.equal(seen.sql, "UPDATE t SET x='?1', y=\"?2\", z=`?3`, [??]=?1 /* ?4 */ -- ?5\n");
assert.deepEqual(seen.values, ["safe"]);
bind("UPDATE t SET x=?1 /* ?2 is only a comment", [integer("9")]);
assert.equal(seen.sql, "UPDATE t SET x=CAST(?1 AS INTEGER)  ");
assert.deepEqual(seen.values, ["9"]);
bind("UPDATE t SET x='/* ?2' WHERE y=?1 -- /* ?3\n /* ?4", [text("safe")]);
assert.equal(seen.sql, "UPDATE t SET x='/* ?2' WHERE y=?1 -- /* ?3\n  ");
bind("UPDATE t SET x=?1 /*/", [integer("9")]);
assert.equal(seen.sql, "UPDATE t SET x=CAST(?1 AS INTEGER)  ");
bind("UPDATE t SET x=?1 /**/", [integer("9")]);
assert.equal(seen.sql, "UPDATE t SET x=CAST(?1 AS INTEGER) /**/");
const hundred = Array.from({ length: 100 }, (_, i) => text(String(i)));
bind("UPDATE t SET x=?100 WHERE y=?100", hundred);
assert.equal(seen.values.length, 100);
assert.throws(() => bind("UPDATE t SET x=?101", [...hundred, text("101")]), /parameter index/);
assert.throws(() => bind("UPDATE t SET x=?0", []), /parameter index/);
assert.throws(() => bind("UPDATE t SET x=?2", [text("missing")]), /Missing SQLite argument/);
assert.throws(() => bind("UPDATE t SET x=?1", [text("extra"), text("argument")]), /count mismatch/);
for (const [tag, expected] of [["inf", Infinity], ["-inf", -Infinity], ["-0", -0]]) {
  bind("UPDATE t SET x=?", [{ kind: "real", value: tag }]);
  assert.ok(Object.is(seen.values[0], expected));
}
for (const value of ["Infinity", "NaN", "__proto__", null, 0]) {
  assert.throws(() => bind("UPDATE t SET x=?", [{ kind: "real", value }]), /Invalid SQLite REAL argument/);
}
console.log("SQLite numbered binding tests passed.");
