# ADR 0020 — Cross-language modules

**Status:** Accepted. The host does not gain a third backend.

**Numbering:** ADR 0018 is the local content store and release catalog. ADR 0019 is project lockfiles and exact local resolution. Those decisions are already accepted on the package-tooling branches. This document does not restate them and does not renumber them.

## Context

Authors ask whether a module written in another language can run here. The TIOBE Programming Community Index for November 2026 ranks Python, C, Java, C++, C#, JavaScript, R, SQL, Visual Basic, and Go, in that order. Rust is eleventh and is not in this list. TypeScript leads some source-host rankings and is not in this top ten.

That ranking is reference information. It is not a Foundations export and it is not a runtime capability.

[ADR 0017](0017-independent-module-release-package-and-identity.md) already separates authoring source from a release artifact. An authoring project may contain TypeScript. The author's own toolchain may compile or bundle that source. The format-v1 JavaScript release artifact is `module.mjs`. This host does not compile TypeScript. That is not a ban on TypeScript as an authoring language.

## Decision

Compatibility is a property of the package, not of the source language. The host runs exactly two shapes. A format-v1 release is one of those two.

A JavaScript implementation runs in process. Of the November 2026 top ten, that is the only language the host executes.

A WebAssembly guest speaks `cgp.abi/1`. Values that cross it are copied JSON. The guest has no source language. A conforming binary is a guest whoever compiled it. It is not a C module, a C++ module, a Go module, or a Python module. The host does not infer or authenticate the compiler that produced it.

The other nine names are not hosted. The host does not link CPython, a JVM, a CLR, R, a SQL engine, or a Visual Basic runtime. It does not compile C, C++, or Go. SQL is not a module runtime. A manifest field `language` is an unknown field and is refused. Naming a language does not grant a runtime.

A JavaScript value that is not JSON does not enter a guest. That refusal fails the call. It does not by itself stop the guest. Registry, singleton, and policy payloads are not inspected and may stay live JavaScript values. Those payloads are not the cross-language surface. A pipeline, subscriber, or service call that reaches a guest must be JSON. A save slice is JSON. The same module id and save major restore across the two shapes.

Node and Chromium both observe a copied call, a refused function, and a save slice in both directions. The fixture that echoes a call is built by this repository. It is not evidence that a C, Go, or Python compiler ran.

## Consequences

Shipping `module.wasm` does not mean the host runs the language that produced it. An author who compiles elsewhere ships the binary and `manifest.json`, with no `module.ts`. This repository does not add the other nine runtimes. The ranking stays in this decision and in the authoring guide. It is not part of `src/foundations/index.ts`.
