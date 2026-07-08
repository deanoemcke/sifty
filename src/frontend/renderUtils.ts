// DJB2-style hash of the AI-filter prompt; listings remember the hash they
// were last checked against so stale filter results can be detected.
export function promptHash(inputString: string): number {
  let h = 5381;
  for (let charIndex = 0; charIndex < inputString.length; charIndex++)
    h = ((h * 33) ^ inputString.charCodeAt(charIndex)) >>> 0;
  return h;
}
