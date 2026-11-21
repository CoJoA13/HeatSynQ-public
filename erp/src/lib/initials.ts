// The initials chip in the rail's user row and the header (spec 2026-10-30 §4.2): the first letter
// of the first two words of the display name, upper-cased. Blank-safe. Import-free.
export function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}
