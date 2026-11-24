// Call inside the owner transaction, after its route and recovery checks.
export function admitLogin(sql, ip, scope, now) {
  if (!['password', 'oauth'].includes(scope)) throw new Error('Invalid throttle scope');
  const window = Math.floor(now / 60000);
  sql.exec('DELETE FROM mapi_login_limits WHERE window < ?', window);
  const globalKey = 'global:' + scope, ipKey = 'ip:' + scope + ':' + ip;
  const [globalMax, ipMax] = scope === 'password' ? [120, 60] : [360, 180];
  for (const [key, max] of [[globalKey, globalMax], [ipKey, ipMax]]) {
    const row = sql.exec('SELECT count FROM mapi_login_limits WHERE key = ? AND window = ?', key, window).toArray()[0];
    if ((row?.count ?? 0) >= max) return false;
  }
  for (const key of [globalKey, ipKey]) {
    sql.exec('INSERT INTO mapi_login_limits VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1, window = excluded.window', key, window);
  }
  return true;
}
