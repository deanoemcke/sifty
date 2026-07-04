// Shared height slide animation — pure DOM helpers, no side effects at module
// scope. Uses the Web Animations API so no inline styles linger; the discrete
// overflow keyframe clips content mid-slide. Animations are skipped under
// prefers-reduced-motion and in browsers without element.animate.

const SLIDE_DURATION_MS = 220;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function canAnimate(element: HTMLElement): boolean {
  return typeof element.animate === "function" && !prefersReducedMotion();
}

function heightKeyframes(fromHeight: number, toHeight: number): Keyframe[] {
  return [
    { height: `${fromHeight}px`, overflow: "hidden" },
    { height: `${toHeight}px`, overflow: "hidden" },
  ];
}

// Slides the element from the given height to its natural height.
export function animateHeightTransition(element: HTMLElement, fromHeight: number): void {
  if (!canAnimate(element)) return;
  const toHeight = element.offsetHeight;
  if (fromHeight === toHeight) return;
  element.animate(heightKeyframes(fromHeight, toHeight), {
    duration: SLIDE_DURATION_MS,
    easing: "ease",
  });
}

// Unhides the element and slides it open from zero height.
export function expandElement(element: HTMLElement): void {
  element.classList.remove("hidden");
  animateHeightTransition(element, 0);
}

// Slides the element closed, then hides it (immediately when not animatable).
export async function collapseElementAsync(element: HTMLElement): Promise<void> {
  if (canAnimate(element)) {
    const animation = element.animate(heightKeyframes(element.offsetHeight, 0), {
      duration: SLIDE_DURATION_MS,
      easing: "ease",
    });
    await animation.finished.catch(() => undefined);
  }
  element.classList.add("hidden");
}
