// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lockBodyScroll,
  popModalHistoryEntryIfPresent,
  pushModalHistoryEntry,
  unlockBodyScroll,
} from './modalOverlay';

beforeEach(() => {
  document.body.className = '';
  history.replaceState(null, '');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lockBodyScroll / unlockBodyScroll', () => {
  it('adds the scroll-locked class to body', () => {
    lockBodyScroll();
    expect(document.body.classList.contains('scroll-locked')).toBe(true);
  });

  it('removes the scroll-locked class from body', () => {
    lockBodyScroll();
    unlockBodyScroll();
    expect(document.body.classList.contains('scroll-locked')).toBe(false);
  });
});

describe('pushModalHistoryEntry / popModalHistoryEntryIfPresent', () => {
  it('pushes a history entry carrying the modal-open marker', () => {
    pushModalHistoryEntry();
    expect((history.state as { siftyModalOpen?: boolean } | null)?.siftyModalOpen).toBe(true);
  });

  it('calls history.back() when the current entry carries the marker', () => {
    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    pushModalHistoryEntry();
    popModalHistoryEntryIfPresent();
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it('does not call history.back() when there is no marker on the current entry', () => {
    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    popModalHistoryEntryIfPresent();
    expect(backSpy).not.toHaveBeenCalled();
  });
});
