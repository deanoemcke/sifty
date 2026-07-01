import * as fs from "node:fs";
import * as path from "node:path";

export type Fixture = {
  capturedAt: string;
  provider: string;
  model: string;
  testId: string;
  response: unknown;
};

function fixturePath(baseDir: string, provider: string, testId: string): string {
  return path.join(baseDir, provider, `${testId}.json`);
}

export function loadFixture(baseDir: string, provider: string, testId: string): Fixture | null {
  const filePath = fixturePath(baseDir, provider, testId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Fixture;
  } catch {
    return null;
  }
}

export function saveFixture(
  baseDir: string,
  provider: string,
  testId: string,
  model: string,
  response: unknown,
): void {
  const dir = path.join(baseDir, provider);
  fs.mkdirSync(dir, { recursive: true });
  const fixture: Fixture = {
    capturedAt: new Date().toISOString(),
    provider,
    model,
    testId,
    response,
  };
  fs.writeFileSync(fixturePath(baseDir, provider, testId), JSON.stringify(fixture, null, 2));
}
