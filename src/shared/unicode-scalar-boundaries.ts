export function unicodeScalarBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([0]);
  let offset = 0;
  for (const scalar of text) {
    offset += scalar.length;
    boundaries.add(offset);
  }
  return boundaries;
}
