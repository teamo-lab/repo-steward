// Shim for bun:bundle — enables ALL features at runtime for edward build
export function feature(_name: string): boolean {
  return true;
}
