// The reactor's host environment. Unsupported filesystem and socket calls
// return ENOSYS. No WASI syscall can initiate network I/O.
export function instantiateReactor(module, hostImports, onDiagnostic) {
  let instance;
  const memory = () => instance.exports.memory.buffer;
  const view = () => new DataView(memory());
  const start = Date.now();
  const errno = { success: 0, notSupported: 52, badFd: 8 };
  const wasi = {
    args_get: () => errno.success,
    args_sizes_get(count, size) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return errno.success;
    },
    environ_get: () => errno.success,
    environ_sizes_get(count, size) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return errno.success;
    },
    sched_yield: () => errno.success,
    proc_exit(code) { throw new Error("Go reactor exited with status " + code); },
    clock_time_get(id, _precision, result) {
      const now = Date.now();
      // Zero is a sentinel in the Go scheduler. Workers can freeze the
      // request's clock between I/O calls, including throughout startup.
      const milliseconds = id === 1 ? Math.max(0, now - start) + 1000 : now;
      view().setBigUint64(result, BigInt(milliseconds) * 1_000_000n, true);
      return errno.success;
    },
    random_get(ptr, length) {
      for (let offset = 0; offset < length; offset += 65_536) {
        crypto.getRandomValues(new Uint8Array(memory(), ptr + offset, Math.min(65_536, length - offset)));
      }
      return errno.success;
    },
    poll_oneoff(subscriptions, _events, count, ready) {
      const data = view();
      // The Go GC makes a nonblocking clock poll even with no descriptors.
      // This synchronous reactor has no host I/O or blocking timers.
      if (count !== 1 || data.getUint8(subscriptions + 8) !== 0 ||
        data.getBigUint64(subscriptions + 24, true) !== 0n) return errno.notSupported;
      data.setUint32(ready, 0, true);
      return errno.success;
    },
    fd_write(fd, iov, length, written) {
      if (fd !== 1 && fd !== 2) return errno.badFd;
      let count = 0;
      for (let i = 0; i < length; i++) {
        const ptr = view().getUint32(iov + i * 8, true);
        const size = view().getUint32(iov + i * 8 + 4, true);
        if (fd === 2 && onDiagnostic) onDiagnostic(new Uint8Array(memory(), ptr, size));
        count += size;
      }
      // Upstream handlers can log internal data. Keep stdout/stderr inside the reactor.
      view().setUint32(written, count, true);
      return errno.success;
    },
    fd_fdstat_get(fd, result) {
      if (fd > 2) return errno.badFd;
      new Uint8Array(memory(), result, 24).fill(0);
      view().setUint8(result, 2); // character device
      return errno.success;
    },
    fd_close: () => errno.badFd,
    fd_prestat_get: () => errno.badFd,
  };
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.module === "wasi_snapshot_preview1" && !(entry.name in wasi)) {
      wasi[entry.name] = () => errno.notSupported;
    }
  }
  instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi, mapi: hostImports(memory) });
  instance.exports._initialize();
  return instance.exports;
}
