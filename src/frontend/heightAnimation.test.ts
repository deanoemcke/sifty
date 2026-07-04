// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { animateHeightTransition, collapseElementAsync, expandElement } from "./heightAnimation";

function buildElement(naturalHeight: number): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "offsetHeight", { value: naturalHeight });
  return element;
}

describe("animateHeightTransition", () => {
  it("animates from the given height to the element's natural height", () => {
    const element = buildElement(120);
    const animateSpy = vi.fn();
    element.animate = animateSpy;
    animateHeightTransition(element, 300);
    expect(animateSpy).toHaveBeenCalledOnce();
    const [keyframes] = animateSpy.mock.calls[0];
    expect(keyframes[0].height).toBe("300px");
    expect(keyframes[1].height).toBe("120px");
  });

  it("does nothing when the heights already match", () => {
    const element = buildElement(120);
    const animateSpy = vi.fn();
    element.animate = animateSpy;
    animateHeightTransition(element, 120);
    expect(animateSpy).not.toHaveBeenCalled();
  });

  it("skips the animation when the user prefers reduced motion", () => {
    const element = buildElement(120);
    const animateSpy = vi.fn();
    element.animate = animateSpy;
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    try {
      animateHeightTransition(element, 300);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(animateSpy).not.toHaveBeenCalled();
  });

  it("tolerates browsers without the animate API", () => {
    const element = buildElement(120);
    expect(() => animateHeightTransition(element, 300)).not.toThrow();
  });
});

describe("expandElement", () => {
  it("unhides the element and slides it from zero height", () => {
    const element = buildElement(90);
    element.classList.add("hidden");
    const animateSpy = vi.fn();
    element.animate = animateSpy;
    expandElement(element);
    expect(element.classList.contains("hidden")).toBe(false);
    const [keyframes] = animateSpy.mock.calls[0];
    expect(keyframes[0].height).toBe("0px");
    expect(keyframes[1].height).toBe("90px");
  });
});

describe("collapseElementAsync", () => {
  it("slides the element to zero height, then hides it", async () => {
    const element = buildElement(90);
    const animateSpy = vi.fn((_keyframes: Keyframe[], _options?: KeyframeAnimationOptions) => ({
      finished: Promise.resolve(),
    }));
    element.animate = animateSpy as unknown as HTMLElement["animate"];
    const collapsePromise = collapseElementAsync(element);
    const [keyframes] = animateSpy.mock.calls[0];
    expect(keyframes[0].height).toBe("90px");
    expect(keyframes[1].height).toBe("0px");
    expect(element.classList.contains("hidden")).toBe(false);
    await collapsePromise;
    expect(element.classList.contains("hidden")).toBe(true);
  });

  it("hides immediately when the animate API is unavailable", async () => {
    const element = buildElement(90);
    await collapseElementAsync(element);
    expect(element.classList.contains("hidden")).toBe(true);
  });
});
