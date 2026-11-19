export function createGuestRuntime(reply: (id: number, ok: boolean, text: string) => void): {
  onMessage(message: unknown): void;
};

export type ResourceRecord = { path: string; offset: number; length: number };

/** Stable error string, or undefined when the index is an exact partition of the pack. */
export function acceptResourceIndex(pack: ArrayBuffer | number, index: unknown): string | undefined;

export function packPackageFiles(
  files: readonly { path: string; bytes: Uint8Array }[],
  artifact: Uint8Array,
  options: {
    maxSnapshotBytes: number;
    packedBytes?: number;
    allocate?: (size: number) => ArrayBuffer;
  },
): { pack: ArrayBuffer; index: ResourceRecord[]; bytes: number };
