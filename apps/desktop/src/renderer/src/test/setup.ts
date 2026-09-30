import "@testing-library/jest-dom/vitest";

if (!window.PointerEvent) {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  });
}

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

HTMLElement.prototype.getAnimations ??= () => [];
HTMLElement.prototype.scrollTo ??= () => undefined;

// xterm performs a small 2D-canvas color capability check at module load.
// jsdom exposes getContext but only logs a not-implemented error, so provide
// the minimal color-probe surface used by that check.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    fillStyle: "#000000",
    fillRect: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  }),
});
