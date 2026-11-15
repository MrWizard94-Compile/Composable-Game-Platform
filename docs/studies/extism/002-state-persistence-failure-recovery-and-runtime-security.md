# Extism Study 002 — State Persistence, Failure Recovery, and Runtime Security

**Research date:** 2026-11-15  
**External project:** Extism  
**Core runtime revision:** [051b765bb6abe4fe95d5e4f489f03ad7b137edbc](https://github.com/extism/extism/commit/051b765bb6abe4fe95d5e4f489f03ad7b137edbc)  
**JavaScript SDK revision:** [bec25c60d0ad32ce06d3934563fd8560f486f323](https://github.com/extism/js-sdk/commit/bec25c60d0ad32ce06d3934563fd8560f486f323)  
**CGP comparison baseline:** [d7871d06dcc8264d25e63922acdf42ea3485c482](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/d7871d06dcc8264d25e63922acdf42ea3485c482)

## Purpose and evidence boundary

This slice investigates state lifetime, reset/reinitialization, failed-call recovery, pool behavior, HTTP capability enforcement, and resource-limit boundaries. It is a source study, not an implementation decision. It does not authorize changing CGP's ABI, runtime backend, or lifecycle.

The Rust findings below are tied to the pinned core-runtime revision. JavaScript findings are tied to the pinned SDK revision; do not assume every detail is identical across SDKs or later releases. In particular, absence of behavior in an inspected source path is not proof that no alternate host integration can provide it.

Primary sources:
- [Rust plugin lifecycle and call path](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/plugin.rs)
- [Rust pool implementation](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/pool.rs)
- [Rust PDK built-in functions, including HTTP and variables](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/pdk.rs)
- [Per-plugin state and memory limiter](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/current_plugin.rs)
- [Timer and epoch interruption](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/timer.rs)
- [JavaScript foreground plugin](https://github.com/extism/js-sdk/blob/bec25c60d0ad32ce06d3934563fd8560f486f323/src/foreground-plugin.ts)
- [JavaScript HTTP context](https://github.com/extism/js-sdk/blob/bec25c60d0ad32ce06d3934563fd8560f486f323/src/http-context.ts)
- [JavaScript call context](https://github.com/extism/js-sdk/blob/bec25c60d0ad32ce06d3934563fd8560f486f323/src/call-context.ts)
- [JavaScript worker reactor](https://github.com/extism/js-sdk/blob/bec25c60d0ad32ce06d3934563fd8560f486f323/src/worker.ts)
- [JavaScript SDK option and limit types](https://github.com/extism/js-sdk/blob/bec25c60d0ad32ce06d3934563fd8560f486f323/src/interfaces.ts)

## Executive findings

1. **“Reset” has multiple meanings.** Extism-managed message buffers, plugin variables, guest linear memory, mutable globals, the Wasmtime Store, and the full plugin instance have distinct lifetimes. A host must not treat buffer cleanup as a clean guest restart.
2. **Rust Extism preserves a stateful instance across ordinary calls.** Plugin variables live in the host-side `CurrentPlugin` state; guest memory and globals live in the Wasm instance. The normal reset path calls the Extism kernel allocator reset, not a general reconstruction of the instance.
3. **The Rust runtime has a deliberate full Store reconstruction path after `_start`.** The call path marks the Store for reset when the invoked export is named `_start`; the next call rebuilds the Store/linker and clears the instance before instantiation. This is not a general automatic recovery policy for every trap or timeout.
4. **The Rust pool does not have a health-aware eviction contract.** A checked-out plugin is returned to the available queue on drop, even when the callback returns an error. The pool's `current_size` is adjusted only during creation and does not expose a public retire/discard operation for a checked-out instance.
5. **Pool creation failure has a capacity-accounting edge case.** In the inspected implementation, the source closure is called before `current_size` is incremented. If construction fails, the count is not incremented, which is correct; however, the mutex is held while the factory runs, so a slow or reentrant factory can serialize or deadlock pool access.
6. **JavaScript `reset()` clears Extism's host-side call-context bookkeeping, not the Wasm instance.** The same WebAssembly.Instance is retained. Guest mutable globals and linear memory are therefore not recreated by that method.
7. **The JavaScript HTTP allowlist checks the initial URL hostname, then calls Fetch without an explicit redirect policy.** In the inspected implementation, there is no per-redirect destination revalidation. This is a potential allowlist bypass and must be tested/closed before using this pattern as a security boundary.
8. **Rust HTTP has a different enforcement path.** It checks the parsed initial hostname against manifest patterns, applies a request-global timeout using the plugin's remaining time, and caps response bytes (defaulting to 50 MiB when no explicit cap is supplied). The inspected call site does not itself demonstrate a per-redirect allowlist re-check; redirect behavior should be verified against the exact pinned ureq version rather than assumed.
9. **Fuel and epoch interruption do not provide universal host-function preemption.** Wasm instruction fuel and epoch deadlines govern guest execution. The Rust HTTP host function separately applies a network timeout. Arbitrary synchronous host callbacks and external work still need their own budgets, cancellation, and side-effect controls.
10. **The two SDKs should be treated as separate security/runtime implementations.** The JS SDK exposes `timeoutMs` and memory options in its public types, but feature parity and enforcement must be traced per execution path; matching option names are not proof of matching semantics.

## 1. State lifetime and reset semantics

### 1.1 Rust runtime

The Rust runtime creates a `CurrentPlugin` when constructing a Plugin. It contains the manifest, a `vars` map, optional WASI context, HTTP status/header state, and the configured memory limiter. The Wasmtime Store and instantiated guest module hold guest linear memory and mutable guest state.

The PDK variable operations copy values between guest memory and the host-side `CurrentPlugin.vars` map. The manifest's `max_var_bytes` constrains this variable store; it is not a cap on all guest memory or host memory.

The public `Plugin::reset` method calls the Extism environment's `reset` export. Its documentation says that this invalidates allocated memory. It does not replace the Wasmtime Store or instantiate a new guest module. Therefore it must not be described as clearing every mutable global or restoring the module to its initial state.

Ordinary calls reuse the existing instance. The call path sets input, invokes the export, reads output/error state, and preserves the Plugin object. The output returned from `Plugin::call` is documented as invalidated by the next call; callers must copy data they need to retain.

### 1.2 Full reconstruction after `_start`

The Rust runtime has a separate `store_needs_reset` path. After a call whose export name is exactly `_start`, it marks the Store for reset. Before a later call, `reset_store` constructs a new Store and CurrentPlugin, relinks imports, clears the stored instance, and resets instantiation bookkeeping. The next call lazily instantiates and initializes the guest again.

This is a materially stronger operation than the Extism kernel `reset` export. It also means the behavior is tied to the special `_start` command-module convention, not a general user-callable “restore initial state” operation.

The inspected source does not show equivalent full Store reconstruction automatically triggered for every trap, timeout, fuel exhaustion, or guest-returned error. Treat that as an explicit host policy gap, not an implied guarantee.

### 1.3 JavaScript SDK

The JavaScript SDK's `ForegroundPlugin.reset()` delegates to `CallContext[RESET]`. That method clears host-side call context: it drops the host context, retains the null page, truncates the block table, and clears the call stack. It does not replace the WebAssembly.Instance, recompile the module, or instantiate a new instance.

The same foreground plugin object retains its `#instancePair`. Thus the SDK reset operation cleans up Extism's host-managed call data, but does not constitute a full guest restart. The JavaScript worker exposes this reset operation to the host, and its call handler exports/imports the host call-context state around guest execution.

**CGP implication:** define separate lifecycle operations for (a) transient ABI buffer cleanup, (b) module-local reset contract, (c) durable state restore, and (d) complete instance replacement. Never overload one ambiguous `reset` verb with all four.

## 2. Failure recovery and pool safety

### 2.1 A failed call may leave state changed

A Wasm guest can mutate memory or globals before it traps. A host callback can perform external side effects before the guest later fails. The Extism runtime reports the error; it does not make the call transactional.

The Rust call path performs post-call bookkeeping and stops the timer, but the inspected code does not generally rebuild the Store/instance for every call error. The plugin may therefore retain guest state changed before the failure. Host-function side effects are outside Wasm rollback in any case.

A successful return code, a guest-declared error, a Wasmtime trap, fuel exhaustion, and a timeout are distinct failure classes. CGP should preserve these distinctions in diagnostics and health policy rather than collapsing them into one generic “plugin failed” status.

### 2.2 Rust pool behavior

The pool maintains an available queue, a current instance count, and a maximum size. A checkout is wrapped in `PoolPlugin`; dropping that wrapper automatically pushes its Plugin back into the available queue and wakes one waiter. The wrapper has no public method to mark the instance poisoned or retire it.

`with_plugin` returns the callback result, but normal scope exit drops the checkout wrapper whether the callback returned `Ok` or `Err`. Consequently, a failed call inside `with_plugin` does not automatically prevent reuse.

The pool's factory is called while holding the pool mutex. This is a serialization point. A slow factory delays all other pool operations; a factory that indirectly re-enters the same pool can deadlock. The current implementation also waits using a condition variable when all instances are checked out.

### 2.3 Capacity-safe retirement pattern for CGP

A CGP pool should make retirement explicit and atomic:
- Checkout grants exclusive ownership of one instance.
- On a healthy return, put the instance back into the available queue.
- On an unhealthy return, destroy it and decrement live capacity exactly once.
- Wake waiters after either return or retirement.
- Replenish lazily or in a controlled background path, with construction outside the central pool lock.
- Handle construction failure without leaking a reservation or leaving waiters asleep.
- Protect against double-return, double-retire, pool shutdown during checkout, and a panic while holding a lease.
- Keep health classification separate from the raw error: a guest-returned application error may be recoverable, while a trap, corrupted ABI response, timeout, or integrity failure may require replacement.

Do not simply “drop the PoolPlugin early” to retire it: its Drop implementation returns the inner Plugin to the pool. A different wrapper or explicit retirement API is required.

## 3. HTTP capability enforcement

### 3.1 JavaScript SDK

The inspected `HttpContext.makeRequest` parses the request URL, compares `url.hostname` against `allowedHosts`, and then invokes the supplied Fetch implementation with the raw URL and method/headers/body. It does not set `redirect: "manual"`, install a redirect-aware fetch wrapper, or revalidate the final response URL against the allowlist in this function.

Fetch follows redirects by default in common environments. Since the allowlist check occurs only before the initial fetch, a permitted hostname redirecting to a disallowed hostname is a concrete test case. This observation is limited to the inspected implementation; a caller-supplied custom fetch may impose additional policy, but that must not be assumed.

The response-size helper reads chunks until the configured maximum is reached and throws when the limit is reached or exceeded. The source shown does not explicitly cancel the reader on that error path. CGP should test whether the underlying request/stream continues consuming resources after rejection and should explicitly abort/cancel where supported.

The JavaScript SDK's public option types document that `allowedHosts` requires worker execution. This is important: do not assume the same enforcement applies to foreground execution. The source also supports a caller-provided `fetch`, so the actual network boundary depends partly on the host-supplied implementation.

### 3.2 Rust runtime

The Rust PDK parses the URL and checks the initial host against the manifest's `allowed_hosts` patterns. An absent allowlist denies the request. It then uses ureq and applies a global request timeout based on `CurrentPlugin::time_remaining()`, so the HTTP operation is constrained by the remaining plugin timeout.

The response reader is bounded to the configured `max_http_response_bytes`; if no explicit value is present, this pinned source uses a 50 MiB default. It reads at most max + 1 bytes to detect overflow and returns an error if the response exceeds the cap.

The inspected PDK call site does not show a redirect policy or destination revalidation. Do not infer redirect safety from the initial-host check. Verify the pinned ureq version's redirect defaults and behavior with a local redirect test, including cross-host, scheme downgrade, loop, and redirect-to-private-address cases.

### 3.3 Required CGP network policy

A guest network capability should be a host-enforced policy, not a hostname string check alone:
- Parse and canonicalize the URL; restrict schemes, ports, credentials, and malformed/ambiguous host forms.
- Resolve and validate destination IPs, including IPv4/IPv6 and loopback, link-local, private, multicast, and metadata-service ranges where relevant.
- Revalidate every redirect hop, or disable automatic redirects and implement a bounded redirect loop in the host.
- Re-resolve/revalidate on connection where DNS rebinding is in scope; hostname allowlists alone do not prevent a permitted hostname resolving to a prohibited address.
- Bound request and response bytes, redirect count, connection time, total time, concurrency, and aggregate composition bandwidth.
- Define proxy behavior, TLS validation, DNS behavior, and whether credentials/authorization headers may cross redirects.
- Ensure host cancellation actually aborts the underlying network operation and releases sockets/streams.
- Keep HTTP separate from WASI filesystem capability grants.

These are CGP recommendations, not claims that Extism implements all of them.

## 4. Fuel, timeouts, and host callbacks

The Rust runtime uses Wasmtime fuel for guest instruction accounting and epoch interruption for timeout/cancellation. The call timer is started immediately before the exported guest function call and stopped after it returns. The timer thread increments the engine epoch for a timed-out or cancelled plugin.

The Rust HTTP host function separately passes the remaining plugin time into ureq's global timeout. This is a useful pattern: a host function performing blocking external work must have its own bounded operation that respects the plugin's remaining deadline.

However, Wasm fuel does not meter arbitrary host-language work. A host callback that blocks, loops in native code, performs a long database query, or waits on an unbounded external service needs its own timeout/budget/cancellation. Epoch interruption should not be treated as guaranteed preemption of arbitrary host callback code.

The JS SDK exposes `timeoutMs` in its option types. This study has not established complete timeout enforcement parity for every JS execution mode and host import. The JS foreground call path inspected here does not contain a Rust-style timer/epoch mechanism. This remains an explicit parity question rather than an assertion that every JS path ignores the option.

## 5. CGP transfer recommendations

1. **Make state lifetime explicit.** Document ABI scratch buffers, guest instance memory, module variables, host context, durable save slices, and external host state separately.
2. **Do not equate reset with restore.** CGP should define an explicit full-instance replacement operation and a separate module-defined reset contract.
3. **Use health-aware leases.** A failed guest call must not silently return a potentially corrupted instance to a reusable pool.
4. **Preserve failure classes.** Traps, timeouts, fuel exhaustion, invalid ABI output, guest-declared errors, and host capability failures should produce distinct diagnostics and retirement decisions.
5. **Treat network as a privileged capability.** Validate every redirect and resolved destination; enforce budgets at the host boundary; make cancellation effective on the actual I/O.
6. **Budget host functions independently.** Guest instruction fuel does not bound host callback work or external effects.
7. **Test runtime parity, not option-name parity.** Rust, Node, and browser implementations need behavior tests for reset, timeout, HTTP policy, worker termination, and failure recovery.
8. **Keep authoritative state host-owned.** Guest state is disposable runtime state; durable CGP state should be committed only through CGP's existing validated save/proposal boundaries.

## 6. Suggested CGP conformance tests

| Test | Required observation |
|---|---|
| Guest increments mutable global, then normal call | Value persists across ordinary calls on same instance |
| Guest writes variable, then Extism reset | Determine variable and guest-global persistence separately |
| Guest mutates memory then traps | Verify whether next call sees mutation; host policy should retire if integrity is uncertain |
| Host callback commits side effect, guest traps afterward | Side effect remains unless callback uses explicit transaction |
| Call `_start`, then invoke another export | Verify full Store/instance reinitialization behavior |
| Pool callback returns an error | Verify whether instance is reused; test CGP's intended retirement policy |
| Pool factory fails or blocks | No leaked capacity; other pool operations remain responsive |
| Allowed host redirects to disallowed host | Redirect is rejected before connecting to disallowed destination |
| Allowed hostname resolves to private IP | Destination policy blocks prohibited address |
| HTTP response exceeds cap | Reader/request is cancelled and resources are released |
| Host callback exceeds guest timeout | Host-side timeout/cancellation is independently enforced |
| Timeout during network I/O | Request aborts, not merely guest execution interruption |

## 7. Open questions for the next slice

- Should CGP's next runtime prototype compare Extism directly against the current Node/browser worker backends, or first build a minimal conformance guest usable by both?
- What is the smallest portable guest ABI helper layer that improves author ergonomics without creating a second competing contract system?
- Which failure classes should mandate instance retirement, and which can be safely retried on the same instance?
- What should the CGP network capability contract expose: raw fetch, request/response primitives, or narrowly typed service operations?

## Conclusion

Extism reinforces the value of a small guest ABI and bounded per-instance execution, but its operational details expose important traps: reset is not necessarily re-instantiation, failed calls are not transactions, pool leases do not imply health, and initial-host allowlists are not sufficient redirect policy. CGP should borrow the useful execution and SDK patterns while keeping instance health, network authority, cancellation, aggregate budgets, and durable state under explicit Foundation control.
