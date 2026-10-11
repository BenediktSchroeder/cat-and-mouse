// Renders a player's view of the table and turns clicks and drags into actions.
//
// The board is rebuilt from scratch for every view. Each face-up card carries its id
// in `data-card`, so cards that exist before and after a rebuild are animated from
// their old position to the new one (FLIP). Cards that appear out of a hidden place,
// such as the draw pile or the opponent's hand, start from that place's `data-zone`.
// Each event's sound starts with its animation.

import { JOKER, TOP_VALUE, fitsOnBuildPile } from './game.js';
import * as sound from './sound.js';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// A discard pile fans out downwards by at most this share of a card height per card.
const MAX_FAN = 0.24;

// The easing of a card's flight brings it within a few pixels of its place after this
// share of the animation, which is when it is heard landing.
const LANDING = 0.55;

function fanFor(count, spread) {
  return count > 1 ? Math.min(MAX_FAN, spread / (count - 1)) : 0;
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') el.style.cssText = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

function colorOf(value) {
  if (value === JOKER) return 'joker';
  if (value <= 4) return 'blue';
  if (value <= 8) return 'green';
  return 'red';
}

/** A face-up card. `standsFor` labels a joker on a building pile with the number it replaces. */
export function cardEl(card, { attrs = {}, standsFor = null, extraClass = '' } = {}) {
  const joker = card.v === JOKER;
  const label = joker ? '★' : String(card.v);
  return h('div', { class: `card card--${colorOf(card.v)} ${extraClass}`, 'data-card': card.id, ...attrs },
    h('span', { class: 'card__pip' }, label),
    h('span', { class: 'card__face' }, label),
    joker ? h('span', { class: 'card__word' }, 'Joker') : null,
    h('span', { class: 'card__pip card__pip--end' }, label),
    standsFor ? h('span', { class: 'card__as' }, `= ${standsFor}`) : null,
  );
}

function backEl(attrs = {}) {
  return h('div', { class: 'card card--back', ...attrs }, h('span', { class: 'card__mark' }));
}

/** Gives a seat's discard piles `spread` card heights to fan out over, beyond the height of one card. */
function spreadDiscards(row, spread) {
  row.style.setProperty('--spread', spread);
  for (const slot of row.children) slot.style.setProperty('--fan', fanFor(slot.querySelectorAll('.card').length, spread));
}

function centerOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

const SPEAKER = '<path d="M4 9h3l5-4v14l-5-4H4z" fill="currentColor"/>';
const WAVES = '<path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
const CROSS = '<path d="M16 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';

const SAVE_ICON = '<path d="M12 4v10m-4-4l4 4 4-4M5 17v2h14v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
const LOAD_ICON = '<path d="M12 15V5m-4 4l4-4 4 4M5 17v2h14v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';

function toolButton(title, icon, attrs) {
  const button = h('button', { class: 'table-tool', type: 'button', title, 'aria-label': title, ...attrs });
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
  return button;
}

function showSoundState(button) {
  const on = sound.isOn();
  button.setAttribute('aria-pressed', String(on));
  button.title = on ? 'Mute sounds' : 'Turn sounds on';
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}${on ? WAVES : CROSS}</svg>`;
}

/** The sound of an event as player `you` hears it, if any. */
function soundOf(ev, you) {
  switch (ev.kind) {
    case 'play':
    case 'discard':
      return 'place';
    case 'draw':
      return 'take';
    case 'joker':
      return 'joker';
    case 'complete':
      return 'complete';
    case 'reshuffle':
      return 'shuffle';
    case 'turn':
      return ev.player === you ? 'turn' : null;
    case 'win':
      return ev.player === you ? 'win' : 'lose';
    default:
      return null;
  }
}

export class Board {
  /** `hostTools`, given only on the host's page, adds buttons to save the game to a file and load one. */
  constructor(root, { onAction, onMessage, hostTools = null }) {
    this.root = root;
    this.onAction = onAction;
    this.onMessage = onMessage;
    this.hostTools = hostTools;
    this.view = null;
    this.selection = null;
    this.dragEndedAt = 0;
    this.dropped = null;
    root.addEventListener('click', (e) => this.#click(e));
    root.addEventListener('dblclick', (e) => this.#doubleClick(e));
    root.addEventListener('pointerdown', (e) => this.#pointerDown(e));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.#select(null));
    window.addEventListener('resize', () => this.#fitDiscards());
  }

  get myTurn() {
    return this.view && this.view.winner === null && this.view.current === this.view.you;
  }

  /** Shows a new view and returns the time in ms until its animations have played. */
  update(view, events = []) {
    const before = this.#measure();
    this.#clearDropped();
    this.view = view;
    this.selection = null;
    this.root.replaceChildren(this.#render(view));
    this.#fitDiscards();
    if (reducedMotion.matches || !before.cards.size) {
      this.#playSounds(events);
      return 0;
    }
    return this.#animate(events, before);
  }

  /** The sounds of events shown without animation, spaced like a quick deal. */
  #playSounds(events) {
    let clock = 0;
    for (const ev of events) {
      const name = soundOf(ev, this.view.you);
      if (!name) continue;
      sound.play(name, clock);
      clock += ev.kind === 'draw' ? 110 : 200;
    }
  }

  // ---- rendering ----------------------------------------------------------

  #render(v) {
    const me = v.you;
    const opponent = (me + 1) % v.players.length;
    return h('div', { class: 'table' },
      this.#seat(v, opponent, false),
      this.#center(v),
      this.#seat(v, me, true),
    );
  }

  #seat(v, p, mine) {
    const player = v.players[p];
    const active = v.current === p && v.winner === null;
    const canAct = mine && this.myTurn;
    const stockLabel = player.stockCount === 1 ? '1 card left in stock' : `${player.stockCount} cards left in stock`;
    const piles = h('div', { class: 'seat__piles' },
      this.#stock(player, p, canAct),
      h('div', { class: 'discards' }, player.discards.map((pile, i) => this.#discardPile(pile, p, i, mine, canAct))),
    );
    // Each hand sits at the edge of the table on its player's side.
    return h('section', { class: `seat ${mine ? 'seat--me' : 'seat--opponent'} ${active ? 'is-active' : ''}` },
      h('header', { class: 'seat__label' },
        h('span', { class: 'seat__name' }, mine ? 'You' : player.name),
        h('span', { class: 'seat__meta' }, stockLabel),
        active ? h('span', { class: 'seat__turn' }, mine ? 'your turn' : 'playing') : null,
        mine ? h('span', { class: 'seat__hint', 'data-set-hint': true }) : null,
        // The top corner of the table is free on every screen, unlike the top bar, which phones hide.
        mine ? null : this.#tools(),
      ),
      mine ? [piles, this.#hand(player, p, canAct)] : [this.#hiddenHand(player, p), piles],
    );
  }

  #tools() {
    const soundToggle = h('button', { class: 'table-tool', type: 'button', 'aria-label': 'Sound', 'data-sound-toggle': true });
    showSoundState(soundToggle);
    return h('span', { class: 'table-tools' },
      this.hostTools ? toolButton('Save the game to a file', SAVE_ICON, { 'data-save-game': true }) : null,
      this.hostTools ? toolButton('Load a saved game', LOAD_ICON, { 'data-load-game': true }) : null,
      soundToggle,
    );
  }

  #stock(player, p, canAct) {
    const top = player.stockTop;
    return h('div', { class: `slot slot--stock ${player.stockCount > 1 ? 'is-stacked' : ''}`, 'data-zone': `stock:${p}` },
      top
        ? cardEl(top, { attrs: canAct ? { 'data-source': 'stock' } : {} })
        : h('span', { class: 'slot__hint' }, 'empty'),
      h('span', { class: 'badge' }, player.stockCount),
      h('span', { class: 'slot__caption' }, 'Stock'),
    );
  }

  #discardPile(pile, p, i, mine, canAct) {
    // The pile fans out downwards, its bottom card highest up and furthest behind;
    // #fitDiscards sets how far.
    return h('div', {
      class: 'slot slot--discard',
      'data-zone': `discard:${p}:${i}`,
      'data-target': canAct ? 'discard' : null,
      'data-pile': i,
    },
      pile.map((card, k) => cardEl(card, {
        attrs: {
          style: `--k:${k}`,
          ...(canAct && k === pile.length - 1 ? { 'data-source': 'discard', 'data-pile': i } : {}),
        },
      })),
      pile.length ? null : h('span', { class: 'slot__hint' }, mine ? 'discard' : ''),
    );
  }

  /**
   * Each seat grows with its longest discard pile into the free space between it and
   * the middle of the table. A pile that needs more room than that fans tighter. When
   * both seats need more than there is, each gets half, plus what the other leaves.
   */
  #fitDiscards() {
    const table = this.root.querySelector('.table');
    const center = table?.querySelector('.center');
    const rows = [...(table?.querySelectorAll('.discards') ?? [])];
    if (!center || !rows.length) return;
    for (const row of rows) spreadDiscards(row, 0);

    const cardHeight = rows[0].firstElementChild.getBoundingClientRect().height;
    if (!cardHeight) return;
    // The table spaces its rows apart, so all room beyond its gaps is free.
    const gap = parseFloat(getComputedStyle(table).rowGap) || 0;
    const middle = center.getBoundingClientRect();
    let free = 0;
    for (const seat of table.querySelectorAll('.seat')) {
      const rect = seat.getBoundingClientRect();
      free += Math.max(0, (rect.bottom <= middle.top ? middle.top - rect.bottom : rect.top - middle.bottom) - gap);
    }

    const needs = rows.map((row) => {
      const longest = Math.max(...[...row.children].map((slot) => slot.querySelectorAll('.card').length));
      return { row, need: Math.max(0, MAX_FAN * (longest - 1)) * cardHeight };
    }).sort((a, b) => a.need - b.need);
    needs.forEach(({ row, need }, i) => {
      const room = Math.min(need, Math.floor(free / (needs.length - i)));
      free -= room;
      spreadDiscards(row, room / cardHeight);
    });
  }

  #hand(player, p, canAct) {
    // Large hands overlap to stay within the eight card widths the hand has.
    const n = player.hand.length;
    const gap = n > 1 ? Math.min(0.12, (7.9 - n) / (n - 1)) : 0;
    return h('div', { class: 'hand', style: `--gap:${gap}`, 'data-zone': `hand:${p}` },
      player.hand.map((card) => cardEl(card, {
        attrs: canAct ? { 'data-source': 'hand' } : {},
      })),
    );
  }

  #hiddenHand(player, p) {
    return h('div', { class: 'hand hand--hidden', 'data-zone': `hand:${p}` },
      Array.from({ length: player.handCount }, (_, i) => backEl({ 'data-back': i })),
    );
  }

  #center(v) {
    const myTurn = this.myTurn;
    const me = v.players[v.you];
    return h('section', { class: 'center' },
      h('div', { class: 'slot slot--draw is-stacked', 'data-zone': 'draw' },
        v.drawCount ? backEl() : h('span', { class: 'slot__hint' }, 'empty'),
        h('span', { class: 'badge' }, v.drawCount),
        h('span', { class: 'slot__caption' }, 'Draw pile'),
      ),
      h('div', { class: 'builds' }, v.build.map((pile, i) => {
        // The card beneath the top is shown too, so a card played onto the pile
        // lands on it instead of covering an empty slot.
        const top = pile.at(-1);
        const below = pile.length > 1 ? pile.at(-2) : null;
        // Only the top card is labelled: the label sticks out over the card's
        // corner, so on the card beneath it would show past the top card.
        return h('div', {
          class: `slot slot--build ${pile.length > 1 ? 'is-stacked' : ''}`,
          'data-zone': `build:${i}`,
          'data-target': myTurn ? 'build' : null,
          'data-pile': i,
        },
          below ? cardEl(below) : null,
          top
            ? cardEl(top, { standsFor: top.v === JOKER ? pile.length : null })
            : h('span', { class: 'slot__hint' }, '1'),
          h('span', { class: 'slot__caption' }, pile.length < TOP_VALUE ? `next: ${pile.length + 1}` : ''),
        );
      })),
      h('div', { class: 'slot slot--done', 'data-zone': 'done' },
        v.completedCount ? backEl() : h('span', { class: 'slot__hint' }, ''),
        h('span', { class: 'badge' }, v.completedCount),
        h('span', { class: 'slot__caption' }, 'Completed'),
      ),
      myTurn && !me.handCount
        ? h('button', { class: 'button end-turn', 'data-end-turn': true }, 'End turn')
        : null,
    );
  }

  // ---- selection and input ------------------------------------------------

  // A selection is `{ from: 'hand', cards: [ids] }`, `{ from: 'stock' }` or
  // `{ from: 'discard', pile }`. Hand cards of the same kind form a set, which can
  // only be discarded, all onto one pile, in the order they were picked.

  #sourceOf(el) {
    const from = el.dataset.source;
    if (from === 'hand') return { from, cards: [Number(el.dataset.card)] };
    if (from === 'discard') return { from, pile: Number(el.dataset.pile) };
    return { from };
  }

  #valueOf(selection) {
    const me = this.view.players[this.view.you];
    if (selection.from === 'hand') return me.hand.find((c) => c.id === selection.cards[0])?.v;
    if (selection.from === 'stock') return me.stockTop?.v;
    return me.discards[selection.pile].at(-1)?.v;
  }

  #sourceElements(selection) {
    if (selection.from === 'hand') {
      return selection.cards.map((id) => this.root.querySelector(`[data-source="hand"][data-card="${id}"]`)).filter(Boolean);
    }
    if (selection.from === 'stock') return [this.root.querySelector('[data-source="stock"]')].filter(Boolean);
    return [this.root.querySelector(`[data-source="discard"][data-pile="${selection.pile}"]`)].filter(Boolean);
  }

  #fits(selection, target) {
    const pile = Number(target.dataset.pile);
    if (target.dataset.target === 'discard') return selection.from === 'hand';
    if (selection.from === 'hand' && selection.cards.length > 1) return false;
    return fitsOnBuildPile(this.#valueOf(selection), this.view.build[pile].length);
  }

  #select(selection) {
    this.selection = selection;
    for (const el of this.root.querySelectorAll('.is-selected, .is-target, .is-hovered')) {
      el.classList.remove('is-selected', 'is-target', 'is-hovered');
    }
    this.#showSetHint(selection);
    // The hint can take a line of its own, which comes out of the room for the discard piles.
    this.#fitDiscards();
    if (!selection) return;
    sound.play('pick');
    for (const el of this.#sourceElements(selection)) el.classList.add('is-selected');
    for (const target of this.root.querySelectorAll('[data-target]')) {
      if (this.#fits(selection, target)) target.classList.add('is-target');
    }
  }

  /** Points out that more cards of the same kind can join the selected set. */
  #showSetHint(selection) {
    const hint = this.root.querySelector('[data-set-hint]');
    if (!hint) return;
    hint.textContent = '';
    if (selection?.from !== 'hand') return;
    const value = this.#valueOf(selection);
    const me = this.view.players[this.view.you];
    const more = me.hand.some((c) => c.v === value && !selection.cards.includes(c.id));
    const kind = value === JOKER ? 'jokers' : `${value}s`;
    if (selection.cards.length > 1) {
      hint.textContent = `${selection.cards.length} ${kind} selected: put them onto one of your discard piles together.`;
    } else if (more) {
      hint.textContent = `Click your other ${kind} to discard them together.`;
    }
  }

  /** The selection after clicking `picked`: hand cards of the same kind join or leave the set. */
  #toggle(picked) {
    const current = this.selection;
    if (picked.from === 'hand' && current?.from === 'hand') {
      const id = picked.cards[0];
      if (current.cards.includes(id)) {
        const rest = current.cards.filter((c) => c !== id);
        return rest.length ? { from: 'hand', cards: rest } : null;
      }
      if (this.#valueOf(picked) === this.#valueOf(current)) return { from: 'hand', cards: [...current.cards, id] };
      return picked;
    }
    const same = current && current.from === picked.from && current.pile === picked.pile;
    return same ? null : picked;
  }

  #click(e) {
    // The click that ends a drag is not a selection.
    if (performance.now() - this.dragEndedAt < 100) return;
    const toggle = e.target.closest('[data-sound-toggle]');
    if (toggle) {
      sound.setOn(!sound.isOn());
      showSoundState(toggle);
      return sound.play('pick');
    }
    if (e.target.closest('[data-save-game]')) return this.hostTools.onSave();
    if (e.target.closest('[data-load-game]')) return this.hostTools.onLoad();
    if (e.target.closest('[data-end-turn]')) return this.onAction({ type: 'endTurn' });
    const target = e.target.closest('[data-target]');
    if (this.selection && target && this.#fits(this.selection, target)) return this.#perform(target);
    const source = e.target.closest('[data-source]');
    if (source) return this.#select(this.#toggle(this.#sourceOf(source)));
    if (this.selection && target) return this.#perform(target);
    this.#select(null);
  }

  /** Double-clicking a number card plays it onto the first building pile it fits. */
  #doubleClick(e) {
    const source = e.target.closest('[data-source]');
    if (!source) return;
    const selection = this.#sourceOf(source);
    if (this.#valueOf(selection) === JOKER) return;
    const target = [...this.root.querySelectorAll('[data-target="build"]')].find((t) => this.#fits(selection, t));
    if (target) {
      this.selection = selection;
      this.#perform(target);
    }
  }

  /**
   * Dragging moves a copy of the card with the pointer; dragging a card of the
   * selected set moves the whole set. A press that does not travel a few pixels stays
   * a click. Cards dropped on a fitting pile stay where they were released until the
   * next view arrives, so they continue from there into their places.
   */
  #pointerDown(e) {
    if (e.button !== 0) return;
    const source = e.target.closest('[data-source]');
    if (!source) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    let floating = null;
    let hovered = null;
    let sources = [];

    const targetAt = (x, y) => document.elementFromPoint(x, y)?.closest('[data-target]') ?? null;
    const move = (ev) => {
      if (!floating) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        const picked = this.#sourceOf(source);
        const inSet = picked.from === 'hand' && this.selection?.from === 'hand'
          && this.selection.cards.includes(picked.cards[0]);
        this.#select(inSet ? this.selection : picked);
        sources = this.#sourceElements(this.selection);
        floating = this.#lift(source, sources);
      }
      floating.style.translate = `${ev.clientX - start.x}px ${ev.clientY - start.y}px`;
      const target = targetAt(ev.clientX, ev.clientY);
      if (target !== hovered) {
        hovered?.classList.remove('is-hovered');
        hovered = target?.classList.contains('is-target') ? target : null;
        hovered?.classList.add('is-hovered');
      }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!floating) return;
      this.dragEndedAt = performance.now();
      const target = ev.type === 'pointerup' ? targetAt(ev.clientX, ev.clientY) : null;
      if (target && this.#fits(this.selection, target)) {
        this.dropped = { ids: sources.map((el) => el.dataset.card), el: floating, sources };
        this.droppedTimer = setTimeout(() => this.#clearDropped(), 2000);
        this.#perform(target);
      } else {
        floating.remove();
        for (const el of sources) el.classList.remove('is-lifted');
        this.#select(null);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** The copy that follows the pointer; a set shows as a small stack with its size. */
  #lift(source, sources) {
    const rect = source.getBoundingClientRect();
    const floating = source.cloneNode(true);
    floating.removeAttribute('data-card');
    floating.removeAttribute('data-source');
    floating.classList.remove('is-selected');
    floating.classList.add('card--floating');
    if (sources.length > 1) {
      floating.classList.add('card--set');
      floating.append(h('span', { class: 'badge' }, `×${sources.length}`));
    }
    Object.assign(floating.style, {
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    document.body.append(floating);
    for (const el of sources) el.classList.add('is-lifted');
    return floating;
  }

  /** The last action was refused: cards waiting for the next view go back at once. */
  reject() {
    sound.play('refuse');
    this.#clearDropped();
  }

  #refuse(message) {
    sound.play('refuse');
    this.onMessage(message);
  }

  #clearDropped() {
    if (!this.dropped) return;
    clearTimeout(this.droppedTimer);
    this.dropped.el.remove();
    for (const el of this.dropped.sources) el.classList.remove('is-lifted');
    this.dropped = null;
  }

  #perform(target) {
    const selection = this.selection;
    const pile = Number(target.dataset.pile);
    this.#select(null);
    if (target.dataset.target === 'build') {
      if (selection.from === 'hand' && selection.cards.length > 1) {
        return this.#refuse('A set of cards can only be discarded. Play them one by one instead.');
      }
      if (!fitsOnBuildPile(this.#valueOf(selection), this.view.build[pile].length)) {
        return this.#refuse(`This building pile needs a ${this.view.build[pile].length + 1} or a joker.`);
      }
      const source = selection.from === 'hand' ? { from: 'hand', card: selection.cards[0] } : selection;
      return this.onAction({ type: 'play', ...source, to: pile });
    }
    if (selection.from !== 'hand') return this.#refuse('Only cards from your hand can be discarded.');
    this.onAction({ type: 'discard', cards: selection.cards, pile });
  }

  // ---- animation ----------------------------------------------------------

  #measure() {
    const cards = new Map();
    const zones = new Map();
    for (const el of this.root.querySelectorAll('[data-card]')) cards.set(el.dataset.card, el.getBoundingClientRect());
    for (const el of this.root.querySelectorAll('[data-zone]')) zones.set(el.dataset.zone, el.getBoundingClientRect());
    for (const id of this.dropped?.ids ?? []) cards.set(id, this.dropped.el.getBoundingClientRect());
    return { cards, zones };
  }

  #cardSize() {
    const card = this.root.querySelector('.card');
    const rect = card?.getBoundingClientRect();
    return rect ? { width: rect.width, height: rect.height } : { width: 80, height: 114 };
  }

  /** A card-sized rectangle in the middle of a zone. */
  #cardRectIn(zoneRect) {
    if (!zoneRect) return null;
    const { width, height } = this.#cardSize();
    const { x, y } = centerOf(zoneRect);
    return { left: x - width / 2, top: y - height / 2, width, height };
  }

  #zoneNow(zone) {
    return this.root.querySelector(`[data-zone="${zone}"]`)?.getBoundingClientRect();
  }

  #animate(events, before) {
    const moved = new Set();
    // Cards arriving in a hidden hand are face down and have no id; they take the
    // last places of that hand, in the order they arrived.
    const arrivals = new Map();
    for (const ev of events) {
      if (ev.to?.startsWith('hand:') && !this.root.querySelector(`[data-card="${ev.card?.id}"]`)) {
        arrivals.set(ev.to, (arrivals.get(ev.to) ?? 0) + 1);
      }
    }
    const backsTaken = new Map();
    let clock = 0;
    // The result of the game sounds once everything has settled, as it is announced.
    let result = null;

    for (const ev of events) {
      const name = soundOf(ev, this.view.you);
      if (ev.kind === 'complete') {
        const slot = this.root.querySelector(`[data-zone="build:${ev.pile}"]`);
        slot?.animate([{ boxShadow: '0 0 0 0 var(--glow)' }, { boxShadow: '0 0 40px 10px var(--glow)' }, { boxShadow: '0 0 0 0 var(--glow)' }],
          { duration: 900, delay: clock + 250 });
        sound.play(name, clock + 250);
        continue;
      }
      if (ev.kind === 'win') result = name;
      else if (!ev.from && name) sound.play(name, clock);
      if (!ev.from) continue;

      const id = ev.card ? String(ev.card.id) : null;
      const from = (id && before.cards.get(id)) || this.#cardRectIn(before.zones.get(ev.from));
      if (!from) continue;
      let el = id ? this.root.querySelector(`[data-card="${id}"]`) : null;
      if (!el && arrivals.has(ev.to)) {
        const hand = this.root.querySelector(`[data-zone="${ev.to}"]`);
        const backs = hand ? [...hand.querySelectorAll('[data-back]')] : [];
        const taken = backsTaken.get(ev.to) ?? 0;
        backsTaken.set(ev.to, taken + 1);
        el = backs[backs.length - arrivals.get(ev.to) + taken] ?? null;
      }

      const joker = ev.kind === 'joker';
      const duration = joker ? 750 : ev.kind === 'draw' ? 380 : 420;
      const delay = clock + (joker ? 250 : 0);
      if (el && !moved.has(el)) {
        moved.add(el);
        flip(el, from, delay, duration, joker);
      } else if (ev.card) {
        ghost(ev.card, from, this.#cardRectIn(this.#zoneNow(ev.to)), delay, duration);
      }
      if (joker) {
        // A joker sounds as it lights up, then slides into the hand, which its
        // animation in flip() does from 30% to 85% of its length.
        sound.play(name, delay);
        sound.play('take', delay + (duration + 450) * 0.3, (duration + 450) * 0.55);
      } else {
        sound.play(name, delay, duration * LANDING);
      }
      clock = delay + ({ draw: 110, discard: 150 }[ev.kind] ?? duration * 0.75);
    }

    // Everything else that shifted, like the rest of a hand closing a gap.
    for (const el of this.root.querySelectorAll('[data-card]')) {
      if (moved.has(el)) continue;
      const from = before.cards.get(el.dataset.card);
      if (from) flip(el, from, 0, 280, false);
    }
    const end = clock + 400;
    if (result) sound.play(result, end);
    return end;
  }
}

function flip(el, from, delay, duration, glow) {
  const to = el.getBoundingClientRect();
  const a = centerOf(from);
  const b = centerOf(to);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const scale = from.width / to.width;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.02) return;
  const start = `translate(${dx}px, ${dy}px) scale(${scale})`;
  // A joker leaving the stock first lights up where it lies, then flies into the hand.
  const keyframes = glow
    ? [
      { transform: start, boxShadow: '0 0 0 0 var(--glow)' },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale * 1.15})`, boxShadow: '0 0 34px 12px var(--glow)', offset: 0.3 },
      { transform: 'none', boxShadow: '0 0 24px 6px var(--glow)', offset: 0.85 },
      { transform: 'none', boxShadow: '0 0 0 0 var(--glow)' },
    ]
    : [{ transform: start }, { transform: 'none' }];
  el.classList.add('is-flying');
  el.animate(keyframes, {
    duration: glow ? duration + 450 : duration,
    delay,
    easing: glow ? 'ease-in-out' : 'cubic-bezier(.25,.8,.25,1)',
    fill: 'backwards',
  }).finished.then(() => el.classList.remove('is-flying'), () => {});
}

/** A temporary card for moves whose card does not stay visible, like the twelve completing a pile. */
function ghost(card, from, to, delay, duration) {
  if (!to) return;
  const el = cardEl(card, { extraClass: 'card--ghost' });
  el.removeAttribute('data-card');
  Object.assign(el.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
  document.body.append(el);
  const a = centerOf(from);
  const b = centerOf(to);
  const start = `translate(${a.x - b.x}px, ${a.y - b.y}px) scale(${from.width / to.width})`;
  el.animate(
    [{ transform: start, opacity: 1 }, { transform: 'none', opacity: 1, offset: 0.75 }, { transform: 'scale(1.08)', opacity: 0 }],
    { duration: duration * 1.6, delay, easing: 'ease-out', fill: 'both' },
  ).finished.then(() => el.remove(), () => el.remove());
}
