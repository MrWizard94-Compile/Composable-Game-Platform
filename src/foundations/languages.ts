/**
 * TIOBE Programming Community Index, November 2026.
 * The host does not choose a module by language and does not embed these runtimes.
 * A package is a JavaScript implementation or a WebAssembly guest. A guest has no source language.
 */

export const LANGUAGE_INDEX = "TIOBE November 2026" as const;

export type LanguagePackage = "javascript-host" | "not-hosted";

export type LanguageRow = {
  rank: number;
  language: string;
  package: LanguagePackage;
  note: string;
};

export const TOP_LANGUAGES: readonly LanguageRow[] = [
  {
    rank: 1,
    language: "Python",
    package: "not-hosted",
    note: "CPython is not linked. A wasm binary is a guest, not a Python runtime.",
  },
  {
    rank: 2,
    language: "C",
    package: "not-hosted",
    note: "The host does not compile C. A conforming wasm binary is a guest with no source language.",
  },
  {
    rank: 3,
    language: "Java",
    package: "not-hosted",
    note: "The JVM is not linked. Bytecode is not a package.",
  },
  {
    rank: 4,
    language: "C++",
    package: "not-hosted",
    note: "The host does not compile C++. A conforming wasm binary is a guest with no source language.",
  },
  {
    rank: 5,
    language: "C#",
    package: "not-hosted",
    note: "The CLR is not linked.",
  },
  {
    rank: 6,
    language: "JavaScript",
    package: "javascript-host",
    note: "The in-process implementation is JavaScript. The host does not compile TypeScript.",
  },
  {
    rank: 7,
    language: "R",
    package: "not-hosted",
    note: "R is not linked.",
  },
  {
    rank: 8,
    language: "SQL",
    package: "not-hosted",
    note: "SQL is not a module package. The host does not embed a database.",
  },
  {
    rank: 9,
    language: "Visual Basic",
    package: "not-hosted",
    note: "A Visual Basic runtime is not linked.",
  },
  {
    rank: 10,
    language: "Go",
    package: "not-hosted",
    note: "The host does not compile Go. A conforming wasm binary is a guest with no source language.",
  },
];
