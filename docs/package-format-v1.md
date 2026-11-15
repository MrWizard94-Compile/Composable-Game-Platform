# CGP Module Package Format v1

This document records the first executable implementation of the accepted package contract in ADR 0017.

The normative logical package is a directory containing regular files. Archives, catalogs, locks, remote registries, staging/build commands, package leases, and garbage collection are not part of format v1.

## Required files and runtime selection

Every release contains:

- \`manifest.json\`, validated by the existing closed CGP manifest schema;
- \`cgp-package.json\`, validated by the closed descriptor schema below;
- exactly one selected runtime entrypoint.

The descriptor is separate from the runtime manifest. It must not repeat module identity, module version, API range, capabilities, Slots, permissions, or save metadata.

### WebAssembly Core descriptor

~~~json
{
  "formatVersion": 1,
  "runtime": {
    "kind": "wasm-core",
    "entry": "module.wasm",
    "abi": "cgp.abi/1"
  }
}
~~~

### JavaScript ESM descriptor

~~~json
{
  "formatVersion": 1,
  "runtime": {
    "kind": "javascript-esm",
    "entry": "module.mjs",
    "export": "implementation",
    "executionTrust": "trusted-in-process"
  }
}
~~~

The JavaScript entrypoint must provide the named \`implementation\` export. Format v1 permits static imports from Node built-in modules using valid \`node:\` specifiers. Relative imports, third-party/bare imports, dynamic \`import()\`, \`require()\`, and \`require.resolve()\` are refused. The check uses esbuild's parser/bundler in memory; it does not evaluate or import the module. This is a package policy check, not a sandbox. JavaScript remains trusted in-process code.

The Wasm check compiles the Core module and inspects its imports, exports, memory, and table declarations without instantiating it. Only the \`cgp.abi.log\` function import is permitted, and only when the runtime manifest declares \`cgp.log\`. Runtime execution remains subject to the existing backend policy and resource limits.

## Strict JSON

\`manifest.json\` and \`cgp-package.json\` must be valid UTF-8 JSON without a BOM. Duplicate object keys are rejected at every nesting level, including keys whose source spelling differs but whose decoded strings are equal. Comments, trailing commas, malformed UTF-8, unknown fields, and unsupported schema values are rejected.

The validator does not rewrite either JSON file. Its exact original bytes remain part of the package-tree digest.

## Package paths

The initial path profile is \`cgp.package-path/1\`.

Paths are relative, use \`/\`, and contain only ASCII letters, digits, \`.\`, \`_\`, and \`-\` in each component. Empty components, \`.\` and \`..\`, trailing periods, reserved Windows device names, \`node_modules\`, \`package.json\`, and \`module.ts\` are forbidden. Paths that collide after ASCII case folding or that imply a file is also a parent directory are rejected.

A local package tree contains regular files only. Symbolic links and special filesystem entries are rejected. Empty directories are ignored. A hard link is represented only by the bytes read from the file; link identity is not included in the digest.

## Package-tree digest

The profile identifier is \`cgp.package-tree/1\`. The digest string is \`sha256:\` followed by 64 lowercase hexadecimal characters.

Every regular file contributes, including the manifest, package descriptor, runtime artifact, documentation, license/notice files, and additional data. Parent directory name, times, ownership, filesystem permissions, inode identity, hard-link relationships, empty directories, archive bytes, and external catalog/lock/signature/provenance data are excluded.

For validated files sorted by ascending ASCII path-byte order:

~~~text
SHA256(
  UTF8("CGP-PACKAGE-TREE" || NUL || "v1")
  || UINT64_BE(fileCount)
  || for each file:
       UINT64_BE(pathByteLength)
       || pathBytes
       || UINT64_BE(fileSize)
       || SHA256(fileBytes)
)
~~~

\`UINT64_BE\` is an unsigned 64-bit big-endian integer. \`pathBytes\` are the exact ASCII bytes of the forward-slash relative path. \`fileSize\` is the exact byte length. The inner SHA-256 is 32 raw bytes, not hexadecimal text. No file content is decoded or normalized.

The executable-only \`artifactDigest\` is \`sha256:\` plus SHA-256 of the selected entrypoint's exact raw bytes. It is distinct from the package-tree digest: changing README or LICENSE changes the package-tree digest but not the artifact digest.

### Fixed test vectors

All vector file contents below are exact UTF-8 bytes. A displayed \`\\n\` means one LF byte (\`0A\`), and no vector file has a BOM.

| Vector | Files (path = exact contents) | Expected package-tree digest |
|---|---|---|
| Empty tree | none | \`sha256:7ea53c3abc96c548d50e85c48865f6f477003320bfd6301a945d9f8a6c553f6c\` |
| One file | \`README.md\` = \`hello\\n\` | \`sha256:ba06a8339ceb454ab29e39f4637ee28a22efec98397a27a5544d1d4dbfde40da\` |
| Two files | \`README.md\` = \`hello\\n\`; \`manifest.json\` = \`{"moduleId":"org.example.demo"}\\n\` | \`sha256:ccb426b9b7f93cdecb322b60724267b74b41e3bbdfa5b8882127b2a94b59445f\` |
| Byte-order check | \`a.txt\` = \`a\`; \`z.txt\` = \`z\` (input enumeration may be reversed) | \`sha256:7e6492b3a96c5ba21d8448eecc66e74a2f825a777e0510010a65a357c7dbe22d\` |

The tests under \`src/packages/package.test.ts\` assert these constants and additional path, parser, descriptor, static-import, and directory-validation cases. Independent implementations should reproduce the same outputs before claiming interoperability.

## Validation command

Run the static package check with Node 22 or later:

~~~sh
node --experimental-strip-types scripts/check-module-package.ts examples/third-party-module
node --experimental-strip-types scripts/check-module-package.ts examples/javascript-module
~~~

The command reports the module coordinate, runtime kind, package-tree profile/digest, artifact digest, and included file paths. It does not import \`module.mjs\` or instantiate \`module.wasm\`.

## Example packages

- \`examples/third-party-module\` demonstrates the Wasm Core package form.
- \`examples/javascript-module\` demonstrates the self-contained JavaScript ESM package form.

The root repository remains private. These examples do not establish an npm publishing format or a distributed package registry.
