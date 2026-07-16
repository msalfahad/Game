import { heroByKey, heroImg, heroPortrait, type Hero } from '../data/characters';

// Photoreal portrait <img> for menu screens, falling back to the original
// sprite when the HD art isn't available (e.g. the single-file build).

export function portraitImg(h: Hero): string {
  return `<img src="${heroPortrait(h)}" data-fb="${h.key}">`;
}

/** Attach the heroImg() fallback to every portrait img inside `scope`. */
export function attachPortraitFallback(scope: HTMLElement) {
  scope.querySelectorAll('img[data-fb]').forEach((el) => {
    const img = el as HTMLImageElement;
    img.onerror = () => {
      img.onerror = null;
      img.src = heroImg(heroByKey(img.dataset.fb!));
    };
  });
}
