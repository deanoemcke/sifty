export type PromptTestCase = {
  id: string;
  label: string;
  systemMessage: string;
  userMessage: string;
  maxTokens: number;
  validate(output: unknown): void;
};

export type PromptTestSuite = {
  name: string;
  cases: PromptTestCase[];
};

export type TestStatus = "pass" | "fail" | "error" | "quota-exceeded" | "no-fixture";

export type TestResult = {
  suiteId: string;
  testId: string;
  label: string;
  provider: string;
  status: TestStatus;
  durationMs: number;
  error?: string;
  output?: unknown;
};
