export function unicodeScalarBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([0]);
  let offset = 0;
  for (const scalar of text) {
    offset += scalar.length;
    boundaries.add(offset);
  }
  return boundaries;
}

export function isUnicodeScalarBoundary(text: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    return false;
  }
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return !(
    previous >= 0xd800 && previous <= 0xdbff &&
    current >= 0xdc00 && current <= 0xdfff
  );
}
