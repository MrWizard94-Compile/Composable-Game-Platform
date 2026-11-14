# O3DE Study 001 — Gems, Packaging, and Distribution

**Research date:** 2026-11-14  
**External project:** Open 3D Engine (O3DE)  
**CGP comparison baseline:** 37739db60e77e69369e002bfa5d54ce4159c2438

## Purpose

Examine how O3DE packages reusable functionality, describes compatibility and dependencies, and distributes independently developed packages. This is directly relevant to CGP milestone M4: Independent Module SDK and Distribution.

## Executive finding

O3DE separates a reusable **Gem package** from the native **module library** that a Code Gem can produce. It also separates package metadata from the remote repository catalog that makes versions discoverable and downloadable.

That distinction is valuable for CGP. A CGP module manifest, a built module artifact, a composition profile, and a module registry should be related but should not become one overloaded document.

## 1. A Gem is a package, not necessarily a runtime library

O3DE identifies three Gem types:

- **Code** — a Gem that contributes compiled code.
- **Asset** — a Gem that contributes reusable assets.
- **Tool** — a Gem that contributes development or editor tooling.

A Gem has a gem.json manifest at its root. A Code Gem's compiled library is called a module and is loaded by O3DE's native module system. Asset and Tool Gems should not be assumed to follow that same runtime loading path.

This is an important vocabulary distinction: Gem is the package/distribution unit; module is the compiled native library associated with a Code Gem.

## 2. Manifest and compatibility information

The manifest describes identity, presentation, compatibility, dependencies, and provenance. Important fields include:

| Field | Purpose |
|---|---|
| gem_name / display_name | Machine identity and user-facing name |
| version | Gem's semantic version |
| type | Code, Asset, or Tool |
| dependencies | Direct Gem dependencies and optional version constraints |
| compatible_engines | Engine names and compatible engine-version ranges |
| engine_api_dependencies | Required engine API version ranges |
| platforms | Platforms the Gem is known to support |
| license / license_url | Licensing declaration and reference |
| origin / origin_url | Originating organization or project |
| documentation_url | User-facing documentation |
| download_source_uri | Downloadable archive location |
| source_control_uri / source_control_ref | Source repository and source revision |
| sha256 | Digest for the downloadable archive |

The distinction between dependencies and compatibility is useful:

- A Gem dependency says that another Gem is required.
- An engine compatibility declaration identifies engines and versions with which the Gem is known to work.
- An engine API dependency identifies a particular engine API family/version requirement.

O3DE uses MAJOR.MINOR.PATCH semantic versions. Its documented compatibility specifiers use PEP 440-style syntax, such as a lower bound or exact pin. Multiple registered versions can coexist. During project configuration, O3DE selects the highest compatible version unless the project's requirement pins a specific version.

Gem dependency resolution occurs during CMake project configuration, not inside the native ModuleManager's runtime load routine.

## 3. Remote repository model

O3DE uses a separate repo.json file as the catalog for a remote repository. A repository can expose Gems, Projects, and Templates. It can be hosted locally, on a web server, or in a Git repository.

The catalog can describe content stored in a different location. For a Gem release, the metadata can include:

- A direct archive download URI.
- The source-control repository and a tag, branch, or commit reference.
- The release version and last-updated date.
- A SHA-256 digest for the archive.

O3DE's Project Manager and CLI can register repositories, show available content, download packages, and register or enable Gems in projects. The documented workflow allows a repository to hold a catalog at one location while individual content versions are stored in Git branches or downloadable archives.

The SHA-256 digest provides an integrity check for the downloaded bytes. It does **not**, by itself, establish that the publisher is trusted or that the package is safe to execute.

## 4. What CGP should learn

### High-value ideas for M4

1. **Separate module specification from distribution metadata.** The runtime manifest should describe what a module is and how it participates. Registry metadata should describe where a release comes from and how to retrieve it.
2. **Make compatibility explicit.** CGP should define how a module declares Foundations API compatibility, module dependencies, platform/backend requirements, and any ABI version it requires.
3. **Model direct dependencies accurately.** Resolve transitive dependencies deterministically, detect missing or incompatible versions, and report why a candidate was rejected.
4. **Make version selection reproducible.** A registry may offer multiple releases, but a project/profile should pin the exact artifact selected for a build or run.
5. **Record provenance and integrity.** Preserve the source repository, immutable source revision, release identity, artifact digest, license, and publisher information.
6. **Provide a useful catalog workflow.** Discovery, inspection, installation, validation, and updating should not require developers to manually clone CGP's source repository.

### Ideas not to copy automatically

- O3DE's Gem types are specific to its game engine and editor. CGP should not adopt Code/Asset/Tool categories unless they solve a demonstrated CGP packaging problem.
- O3DE's CMake-time dependency resolution is closely tied to compiling a native engine project. CGP must decide which checks belong at package acquisition, composition preparation, or runtime.
- A SHA-256 digest is not a substitute for publisher authentication, review, sandboxing, or a trust policy.
- Selecting the highest compatible version is convenient for discovery, but a running CGP composition should remain reproducible. Resolution and lock/pin behavior need to be explicit.

## 5. Comparison with current CGP

At the comparison baseline, CGP already has:

- A machine-readable module manifest and semantic-version checks.
- Exact module versions in composition profiles.
- Capability and Slot requirements used to derive composition dependencies.
- Explicit refusal of missing, ambiguous, conflicting, or incompatible composition relationships.
- A public Foundations entry point and a starter module example.

The outstanding M4 gap is distribution and independence: the repository remains private in its package configuration, and the starter example imports the Foundations implementation by a relative path inside the source repository. Those are not equivalent to an independently installable, versioned SDK and package.

O3DE's model suggests that CGP should treat at least four things separately:

1. **Module contract:** manifest, exported Slots, required capabilities, ABI/API compatibility.
2. **Module artifact:** the actual implementation package, including any WebAssembly binary or trusted JavaScript entry point.
3. **Composition lock/profile:** the exact module releases and configuration selected for one application.
4. **Repository/catalog metadata:** release location, immutable provenance, integrity digest, license, platform support, and release history.

## 6. Conclusions

O3DE offers a mature reference for packaging, version compatibility, package discovery, and distribution workflow. The strongest lesson for CGP is separation of concerns: package identity, runtime contract, artifact bytes, project selection, and repository metadata have different responsibilities.

This study does not recommend copying O3DE's Gem format or build system. It recommends using O3DE as a reference while designing CGP's own small, backend-aware module package and distribution standards.

## Sources

### Official O3DE documentation

- [Gem Module System](https://www.docs.o3de.org/docs/user-guide/programming/gems/overview/)
- [Gem Manifest File (gem.json)](https://docs.o3de.org/docs/user-guide/programming/gems/manifest/)
- [Gem Versioning and Compatibility](https://www.docs.o3de.org/docs/user-guide/gems/gem-versioning/)
- [Remote Repository Overview](https://docs.o3de.org/docs/user-guide/remote-content/remote-repository-overview/)
- [Using O3DE Remote Repositories](https://docs.o3de.org/docs/user-guide/remote-content/use-a-remote-repository/)
- [O3DE Project Configuration CLI Reference](https://docs.o3de.org/docs/user-guide/project-config/cli-reference/)

Documentation is maintained upstream and may change. Re-check the current pages before implementing against them.
