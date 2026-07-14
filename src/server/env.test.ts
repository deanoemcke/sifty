import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vite', () => ({
  loadEnv: vi.fn(() => ({ SOME_TEST_ENV_VAR: 'from-dotenv' })),
}));

describe('loadServerEnv', () => {
  afterEach(() => {
    delete process.env.SOME_TEST_ENV_VAR;
  });

  it('assigns variables loaded from .env onto process.env', async () => {
    const { loadServerEnv } = await import('./env');
    loadServerEnv();
    expect(process.env.SOME_TEST_ENV_VAR).toBe('from-dotenv');
  });
});
