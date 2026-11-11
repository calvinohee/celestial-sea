/**
 * Title card over the live sky. The first tap is what unlocks audio on iOS, so
 * `onBegin` is called synchronously inside the gesture handler.
 */
export function showStartScreen(root: HTMLElement, onBegin: () => void): void {
  const screen = document.createElement('div');
  screen.className = 'start-screen';
  screen.setAttribute('role', 'button');
  screen.setAttribute('aria-label', 'Celestial Sea. Tap to begin');
  screen.tabIndex = 0;

  const title = document.createElement('h1');
  title.className = 'start-title';
  title.textContent = 'Celestial Sea';

  const hint = document.createElement('p');
  hint.className = 'start-hint';
  hint.textContent = 'Tap to begin';

  screen.append(title, hint);
  root.append(screen);

  // Fade in on the frame after insertion so the transition runs.
  requestAnimationFrame(() => requestAnimationFrame(() => screen.classList.add('visible')));

  let begun = false;
  const begin = (): void => {
    if (begun) return;
    begun = true;
    window.removeEventListener('keydown', onKey);
    onBegin();
    screen.classList.add('leaving');
    window.setTimeout(() => screen.remove(), 1800);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      begin();
    }
  };

  screen.addEventListener('click', begin);
  window.addEventListener('keydown', onKey);
}
