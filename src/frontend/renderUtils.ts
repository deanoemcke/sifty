// DJB2-style string hash — used to fingerprint the AI-filter prompt, so
// listings can remember which prompt text they were last checked against.
export function djb2Hash(inputString: string): number {
  let h = 5381;
  for (let charIndex = 0; charIndex < inputString.length; charIndex++)
    h = ((h * 33) ^ inputString.charCodeAt(charIndex)) >>> 0;
  return h;
}
