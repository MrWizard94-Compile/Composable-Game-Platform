export function createGuestRuntime(reply: (id: number, ok: boolean, text: string) => void): {
  onMessage(message: unknown): void;
};
