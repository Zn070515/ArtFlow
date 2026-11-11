/** Graph file nodes are relative to `plus/`; git diffs are relative to the repository root. */
export function plusRelative(file: string): string {
  return file.startsWith("plus/") ? file.slice("plus/".length) : file;
}
