import { describe, expect, it } from 'vitest';
import { fireAllCardSearches } from './cardSearch';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('fireAllCardSearches', () => {
  it('calls searchFn for every card', () => {
    const calledWith: string[] = [];
    fireAllCardSearches(['a', 'b', 'c'], (card) => {
      calledWith.push(card);
      return Promise.resolve();
    });
    expect(calledWith).toEqual(['a', 'b', 'c']);
  });

  it('returns a promise that only resolves after every card search resolves', async () => {
    const first = makeDeferred<void>();
    const second = makeDeferred<void>();
    let settled = false;

    const resultPromise = fireAllCardSearches(['a', 'b'], (card) =>
      card === 'a' ? first.promise : second.promise
    );
    resultPromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    first.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    second.resolve();
    await resultPromise;
    expect(settled).toBe(true);
  });
});
