// fw_version is a plain "major.minor.patch" string (e.g. "0.5.0") — no
// pre-release/build-metadata suffixes in this firmware's versioning scheme,
// so a straightforward numeric segment-by-segment compare is enough.
export function compareFwVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}
