const markdownNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/i;

export function requestedMarkdownFilename(objective: string, expectedResult = ''): string | undefined {
  const text = `${objective}\n${expectedResult}`;
  const match = /\b(?:to|as|named|called)\s+[`'"]?([A-Za-z0-9][A-Za-z0-9_.-]*\.md)(?=$|[\s`'".,;:!?)}\]])/i.exec(text);
  const name = match?.[1];
  return name && markdownNamePattern.test(name) ? name : undefined;
}

export function unconfirmedRequestedFilenames(requestedNames: string[], actualNames: string[]): string[] {
  return [...new Set(requestedNames.filter((name) => !actualNames.includes(name)))];
}
