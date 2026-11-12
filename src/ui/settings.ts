import creditsText from '../../CREDITS.md?raw';
import { CYCLE, type QualityMode } from '../config';
import type { Settings } from '../game/persistence';

export interface SettingsHandlers {
  /** A value changed. `settings` is the live object, already updated. */
  onChange(settings: Settings, key: keyof Settings): void;
  /** The player confirmed "Clear my sky". */
  onClearSky(): void;
  /** Panel opened or closed (the game ignores steering input while it is open). */
  onOpenChange(open: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Inline pieces of a credits line: **bold**, `code` and bare links. Built as nodes, never as HTML. */
function appendInline(parent: HTMLElement, text: string): void {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parent.append(text.slice(last, index));
    const token = match[0];
    if (token.startsWith('**')) {
      parent.append(el('strong', undefined, token.slice(2, -2)));
    } else if (token.startsWith('`')) {
      parent.append(el('code', undefined, token.slice(1, -1)));
    } else {
      const link = el('a', undefined, token.replace(/^https?:\/\//, ''));
      link.href = token;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      parent.append(link);
    }
    last = index + token.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** Render the small subset of Markdown that CREDITS.md uses. */
export function renderCredits(markdown: string): HTMLElement {
  const root = el('div', 'credits-body');
  let list: HTMLUListElement | null = null;
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) {
      const p = el('p');
      appendInline(p, paragraph.join(' '));
      root.append(p);
      paragraph = [];
    }
    list = null;
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
    } else if (line.startsWith('# ')) {
      flush(); // the panel already says "Credits"
    } else if (line.startsWith('## ')) {
      flush();
      root.append(el('h4', undefined, line.slice(3)));
    } else if (line.startsWith('- ')) {
      if (paragraph.length > 0) flush();
      if (!list) {
        list = el('ul');
        root.append(list);
      }
      const item = el('li');
      appendInline(item, line.slice(2));
      list.append(item);
    } else if (line.startsWith('|')) {
      flush();
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      // Skip the header underline and the header row itself; show rows as "name: notes".
      if (cells.every((c) => /^-+$/.test(c)) || cells[0] === 'Instrument') continue;
      const row = el('p', 'credits-row');
      row.append(el('strong', undefined, cells[0]), ' ');
      appendInline(row, cells.slice(1).join(', '));
      root.append(row);
    } else {
      list = null;
      paragraph.push(line);
    }
  }
  flush();
  return root;
}

const QUALITY_OPTIONS: { value: QualityMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'high', label: 'High' },
  { value: 'low', label: 'Low' },
];

const ICON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/>
<circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>
</g></svg>`;

/**
 * The only chrome in the game: a small, quiet button in the corner and the
 * panel it opens. Volumes, quality, day length, comfort, battery mode,
 * "Clear my sky" and credits.
 */
export class SettingsPanel {
  private readonly button: HTMLButtonElement;
  private readonly backdrop: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private isOpen = false;

  constructor(
    root: HTMLElement,
    private readonly settings: Settings,
    private readonly handlers: SettingsHandlers,
  ) {
    this.button = el('button', 'settings-button');
    this.button.type = 'button';
    this.button.setAttribute('aria-label', 'Settings');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.setAttribute('aria-controls', 'settings-panel');
    // Static, trusted markup (the icon); everything else is built from nodes.
    this.button.innerHTML = ICON;
    this.button.hidden = true;
    this.button.addEventListener('click', () => this.toggle());

    this.backdrop = el('div', 'settings-backdrop');
    this.backdrop.hidden = true;
    this.backdrop.addEventListener('click', () => this.close());

    this.panel = el('div', 'settings-panel');
    this.panel.id = 'settings-panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Settings');
    // Lets touches scroll and drag here; the game blocks them everywhere else.
    this.panel.dataset.allowTouch = '';
    this.panel.hidden = true;

    this.panel.append(el('h2', 'settings-title', 'Settings'));
    this.panel.append(
      this.slider('Music', 'music'),
      this.slider('Effects', 'effects'),
      this.slider('Ambience', 'ambience'),
      this.segments('Quality', 'quality', QUALITY_OPTIONS),
      this.segments(
        'Day length (min)',
        'dayMinutes',
        CYCLE.options.map((m) => ({ value: m, label: String(m) })),
      ),
      this.switchRow('Reduce motion', 'reduceMotion'),
      this.switchRow('30 fps battery mode', 'battery'),
      this.clearSky(),
      this.credits(),
    );

    root.append(this.backdrop, this.panel, this.button);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.isOpen) this.close();
    });
  }

  /** Reveal the button (once the title card has gone). */
  show(): void {
    this.button.hidden = false;
    requestAnimationFrame(() => this.button.classList.add('visible'));
  }

  get open(): boolean {
    return this.isOpen;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.openPanel();
  }

  private openPanel(): void {
    this.isOpen = true;
    this.panel.hidden = false;
    this.backdrop.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => this.panel.classList.add('open'));
    this.handlers.onOpenChange(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.panel.classList.remove('open');
    this.backdrop.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    window.setTimeout(() => {
      if (!this.isOpen) this.panel.hidden = true;
    }, 260);
    this.handlers.onOpenChange(false);
  }

  private slider(label: string, key: 'music' | 'effects' | 'ambience'): HTMLElement {
    const row = el('label', 'settings-row settings-slider');
    row.append(el('span', 'settings-label', label));
    const input = el('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = String(Math.round(this.settings[key] * 100));
    const paint = (): void => input.style.setProperty('--fill', `${input.value}%`);
    paint();
    input.addEventListener('input', () => {
      this.settings[key] = Number(input.value) / 100;
      paint();
      this.handlers.onChange(this.settings, key);
    });
    row.append(input);
    return row;
  }

  /** A row of mutually exclusive choices. */
  private segments<K extends 'quality' | 'dayMinutes'>(
    label: string,
    key: K,
    options: { value: Settings[K]; label: string }[],
  ): HTMLElement {
    const row = el('div', 'settings-row');
    row.append(el('span', 'settings-label', label));
    const group = el('div', 'settings-segments');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    const buttons: { value: Settings[K]; button: HTMLButtonElement }[] = [];
    const paint = (): void => {
      for (const { value, button } of buttons) {
        const on = value === this.settings[key];
        button.setAttribute('aria-checked', String(on));
        button.classList.toggle('on', on);
      }
    };
    for (const option of options) {
      const button = el('button', 'settings-segment', option.label);
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.addEventListener('click', () => {
        if (this.settings[key] === option.value) return;
        this.settings[key] = option.value;
        paint();
        this.handlers.onChange(this.settings, key);
      });
      buttons.push({ value: option.value, button });
      group.append(button);
    }
    paint();
    row.append(group);
    return row;
  }

  private switchRow(label: string, key: 'battery' | 'reduceMotion'): HTMLElement {
    const row = el('label', 'settings-row settings-toggle');
    row.append(el('span', 'settings-label', label));
    const input = el('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.checked = this.settings[key];
    input.addEventListener('change', () => {
      this.settings[key] = input.checked;
      this.handlers.onChange(this.settings, key);
    });
    row.append(input, el('span', 'settings-switch'));
    return row;
  }

  private clearSky(): HTMLElement {
    const row = el('div', 'settings-row settings-clear');
    const ask = el('button', 'settings-action', 'Clear my sky');
    ask.type = 'button';
    const confirm = el('div', 'settings-confirm');
    confirm.hidden = true;
    confirm.append(el('span', 'settings-label', 'Remove every constellation?'));
    const yes = el('button', 'settings-action danger', 'Clear');
    yes.type = 'button';
    const no = el('button', 'settings-action', 'Keep');
    no.type = 'button';
    const buttons = el('div', 'settings-confirm-buttons');
    buttons.append(no, yes);
    confirm.append(buttons);

    const reset = (): void => {
      confirm.hidden = true;
      ask.hidden = false;
    };
    ask.addEventListener('click', () => {
      ask.hidden = true;
      confirm.hidden = false;
      no.focus();
    });
    no.addEventListener('click', reset);
    yes.addEventListener('click', () => {
      reset();
      this.handlers.onClearSky();
      this.close();
    });
    row.append(ask, confirm);
    return row;
  }

  private credits(): HTMLElement {
    const details = el('details', 'settings-credits');
    details.append(el('summary', undefined, 'Credits'));
    details.append(renderCredits(creditsText));
    return details;
  }
}
