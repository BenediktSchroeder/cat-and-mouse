// Rules engine for the two-player card game with the joker house rule.
//
// The state is plain JSON so the host can persist it and rebuild it after a reload.
// Cards are referred to by id; `state.values[id]` is the card's face value, where
// JOKER (0) is a wild card. The last element of every pile array is its top card.
//
// Every mutation reports what happened as a list of events, which the UI replays as
// animations: `{ kind, card, from, to }` for a card changing places, where `from` and
// `to` are zone names such as `hand:0`, `stock:1`, `discard:0:2`, `build:3`, `done` or `draw`.
//
// `state.undo` holds what the current player needs to take back the moves of their
// turn, one entry per move, the latest last. Only moves that uncover no hidden card
// can be taken back, or a player could peek and retract: a card played from the stock
// uncovers the next one and an emptied hand draws new cards, so either move clears
// the stack, as does the end of the turn.

export const JOKER = 0;
export const HAND_SIZE = 5;
export const STOCK_SIZE = 30;
export const PILE_COUNT = 4;
export const TOP_VALUE = 12;

export class RuleError extends Error {}

export function createDeck() {
  const values = [];
  for (let set = 0; set < 12; set++) {
    for (let value = 1; value <= TOP_VALUE; value++) values.push(value);
  }
  for (let i = 0; i < 18; i++) values.push(JOKER);
  return values;
}

export function shuffle(items, rng = Math.random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Deals a new game for two players. Unless `firstPlayer` is given, the player with the
 * lower top card on their stock begins (see `chooseFirstPlayer`).
 */
export function newGame(names, { rng = Math.random, firstPlayer } = {}) {
  const values = createDeck();
  const draw = shuffle(values.map((_, id) => id), rng);
  const players = names.map((name) => ({
    name,
    stock: [],
    hand: [],
    discards: Array.from({ length: PILE_COUNT }, () => []),
  }));
  for (let i = 0; i < STOCK_SIZE; i++) {
    for (const player of players) player.stock.push(draw.pop());
  }
  const state = {
    values,
    players,
    draw,
    completed: [],
    build: Array.from({ length: PILE_COUNT }, () => []),
    current: firstPlayer ?? chooseFirstPlayer(values, players, rng),
    turn: 1,
    winner: null,
    undo: [],
  };
  const events = [];
  // Every player starts with five cards. A joker on top of the stock joins them
  // afterwards instead of counting towards the five.
  players.forEach((_, p) => {
    drawCards(state, p, HAND_SIZE, events, rng);
    takeStockJokers(state, p, events);
  });
  return { state, events };
}

/**
 * The player whose stock shows the lower top card begins, a joker counting lowest.
 * On a tie both top cards go back into their stocks at a random place below the new
 * top card, and the next two top cards are compared. Each stock holds more cards than
 * there are of any one kind, so a tie is soon broken.
 */
function chooseFirstPlayer(values, players, rng) {
  const [a, b] = players.map((player) => player.stock);
  while (values[a.at(-1)] === values[b.at(-1)]) {
    for (const stock of [a, b]) {
      const card = stock.pop();
      stock.splice(Math.floor(rng() * stock.length), 0, card);
    }
  }
  return values[a.at(-1)] < values[b.at(-1)] ? 0 : 1;
}

/** Whether a card of `value` may go onto a building pile currently holding `pileSize` cards. */
export function fitsOnBuildPile(value, pileSize) {
  return value === JOKER || value === pileSize + 1;
}

export function applyAction(state, p, action, rng = Math.random) {
  if (state.winner !== null) throw new RuleError('The game is over.');
  if (p !== state.current) throw new RuleError("It's not your turn.");
  const events = [];
  switch (action?.type) {
    case 'play':
      play(state, p, action, events, rng);
      break;
    case 'discard':
      discard(state, p, action, events, rng);
      break;
    case 'endTurn':
      if (state.players[p].hand.length) throw new RuleError('Discard a card to end your turn.');
      endTurn(state, events, rng);
      break;
    case 'undo':
      undo(state, p, events);
      break;
    default:
      throw new RuleError('Unknown action.');
  }
  return events;
}

function play(state, p, action, events, rng) {
  const player = state.players[p];
  const target = state.build[action.to];
  if (!target) throw new RuleError('There is no such building pile.');

  let card;
  let from;
  if (action.from === 'hand') {
    if (!player.hand.includes(action.card)) throw new RuleError('That card is not in your hand.');
    card = action.card;
    from = `hand:${p}`;
  } else if (action.from === 'stock') {
    card = player.stock.at(-1);
    from = `stock:${p}`;
  } else if (action.from === 'discard') {
    card = player.discards[action.pile]?.at(-1);
    from = `discard:${p}:${action.pile}`;
  }
  if (card === undefined) throw new RuleError('There is no card to play there.');

  const value = state.values[card];
  if (!fitsOnBuildPile(value, target.length)) {
    throw new RuleError(`This building pile needs a ${target.length + 1} or a joker.`);
  }

  const before = {
    hand: [...player.hand],
    discards: player.discards.map((pile) => [...pile]),
    build: state.build.map((pile) => [...pile]),
    completed: [...state.completed],
  };
  if (action.from === 'hand') player.hand.splice(player.hand.indexOf(card), 1);
  else if (action.from === 'stock') player.stock.pop();
  else player.discards[action.pile].pop();
  target.push(card);
  events.push({ kind: 'play', card, from, to: `build:${action.to}` });

  let at = `build:${action.to}`;
  if (target.length === TOP_VALUE) {
    state.completed.push(...target);
    state.build[action.to] = [];
    events.push({ kind: 'complete', pile: action.to });
    at = 'done';
  }

  // Whatever happens first decides the race between an emptied hand and an
  // uncovered joker: each is resolved the moment it happens.
  if (action.from === 'stock') {
    takeStockJokers(state, p, events);
    if (!player.stock.length) {
      state.winner = p;
      events.push({ kind: 'win', player: p });
    }
  } else if (action.from === 'hand' && !player.hand.length) {
    drawCards(state, p, HAND_SIZE, events, rng);
  }

  // A game stored by an earlier version of the page has no undo stack yet.
  if (action.from === 'stock' || events.some((event) => event.kind === 'draw')) state.undo = [];
  else (state.undo ??= []).push({ before, card, from, at });
}

/** Takes back the latest move of the turn, putting its card back from `at` to `from`. */
function undo(state, p, events) {
  const move = state.undo?.pop();
  if (!move) throw new RuleError('There is no move to take back.');
  const player = state.players[p];
  player.hand = move.before.hand;
  player.discards = move.before.discards;
  state.build = move.before.build;
  state.completed = move.before.completed;
  events.push({ kind: 'undo', card: move.card, from: move.at, to: move.from });
}

/**
 * House rule: several cards of the same number may be discarded together onto one
 * pile. Jokers form such a set only among themselves. The cards are stacked in the
 * given order, so the last one ends up on top.
 */
function discard(state, p, action, events, rng) {
  const player = state.players[p];
  const cards = action.cards;
  if (!Array.isArray(cards) || !cards.length) throw new RuleError('Choose a card to discard.');
  if (new Set(cards).size !== cards.length || !cards.every((card) => player.hand.includes(card))) {
    throw new RuleError('That card is not in your hand.');
  }
  if (!cards.every((card) => state.values[card] === state.values[cards[0]])) {
    throw new RuleError('Only cards of the same kind can be discarded together.');
  }
  const pile = player.discards[action.pile];
  if (!pile) throw new RuleError('There is no such discard pile.');
  for (const card of cards) {
    player.hand.splice(player.hand.indexOf(card), 1);
    pile.push(card);
    events.push({ kind: 'discard', card, from: `hand:${p}`, to: `discard:${p}:${action.pile}` });
  }
  endTurn(state, events, rng);
}

function endTurn(state, events, rng) {
  state.undo = [];
  state.current = (state.current + 1) % state.players.length;
  state.turn++;
  events.push({ kind: 'turn', player: state.current });
  startTurn(state, state.current, events, rng);
}

/** Draws up to five cards; a hand holding five or more cards (thanks to jokers) draws none. */
function startTurn(state, p, events, rng) {
  const missing = HAND_SIZE - state.players[p].hand.length;
  if (missing > 0) drawCards(state, p, missing, events, rng);
  takeStockJokers(state, p, events);
}

/** House rule: a joker on top of the stock goes straight into the hand, whatever the hand size. */
function takeStockJokers(state, p, events) {
  const player = state.players[p];
  while (player.stock.length && state.values[player.stock.at(-1)] === JOKER) {
    const card = player.stock.pop();
    player.hand.push(card);
    events.push({ kind: 'joker', card, from: `stock:${p}`, to: `hand:${p}` });
  }
}

function drawCards(state, p, count, events, rng) {
  const hand = state.players[p].hand;
  for (let i = 0; i < count; i++) {
    if (!state.draw.length && state.completed.length) {
      state.draw = shuffle(state.completed, rng);
      state.completed = [];
      events.push({ kind: 'reshuffle', count: state.draw.length });
    }
    if (!state.draw.length) return;
    const card = state.draw.pop();
    hand.push(card);
    events.push({ kind: 'draw', card, from: 'draw', to: `hand:${p}` });
  }
}

/**
 * Rebuilds a state read back from a saved game, keeping only the fields the rules
 * know, apart from the undo stack: the moves made before the game was saved cannot
 * be taken back. A state that could not have come out of a game is refused: the deck must be
 * complete, every card must lie in exactly one place, and every building pile must
 * climb from 1 without a gap.
 */
export function restoreState(saved) {
  const refuse = () => { throw new RuleError('The file does not hold a valid saved game.'); };
  if (!saved || typeof saved !== 'object') refuse();
  const { values, players, draw, completed, build, current, turn, winner } = saved;
  const deck = createDeck();
  const byValue = (a, b) => a - b;
  if (!Array.isArray(values) || !values.every(Number.isInteger)) refuse();
  if ([...values].sort(byValue).join() !== deck.sort(byValue).join()) refuse();
  if (!Array.isArray(players) || players.length !== 2) refuse();
  if (!Array.isArray(build) || build.length !== PILE_COUNT) refuse();
  if (!players.every((p) => typeof p?.name === 'string' && Array.isArray(p.discards) && p.discards.length === PILE_COUNT)) {
    refuse();
  }

  const piles = [draw, completed, ...build, ...players.flatMap((p) => [p.stock, p.hand, ...p.discards])];
  if (!piles.every((pile) => Array.isArray(pile) && pile.every(Number.isInteger))) refuse();
  const cards = piles.flat();
  if (cards.length !== values.length || new Set(cards).size !== cards.length) refuse();
  if (!cards.every((card) => card >= 0 && card < values.length)) refuse();
  if (!build.every((pile) => pile.length < TOP_VALUE && pile.every((card, k) => fitsOnBuildPile(values[card], k)))) {
    refuse();
  }

  const isSeat = (p) => Number.isInteger(p) && p >= 0 && p < players.length;
  if (!isSeat(current) || !Number.isInteger(turn) || turn < 1 || (winner !== null && !isSeat(winner))) refuse();

  return {
    values: [...values],
    players: players.map((p) => ({
      name: p.name,
      stock: [...p.stock],
      hand: [...p.hand],
      discards: p.discards.map((pile) => [...pile]),
    })),
    draw: [...draw],
    completed: [...completed],
    build: build.map((pile) => [...pile]),
    current,
    turn,
    winner,
    undo: [],
  };
}

/** What `viewer` is allowed to see: the opponent's hand and the face-down piles stay hidden. */
export function viewFor(state, viewer) {
  const card = (id) => ({ id, v: state.values[id] });
  return {
    you: viewer,
    current: state.current,
    turn: state.turn,
    winner: state.winner,
    canUndo: state.undo?.length > 0,
    drawCount: state.draw.length,
    completedCount: state.completed.length,
    build: state.build.map((pile) => pile.map(card)),
    players: state.players.map((player, i) => ({
      name: player.name,
      stockCount: player.stock.length,
      stockTop: player.stock.length ? card(player.stock.at(-1)) : null,
      handCount: player.hand.length,
      hand: i === viewer ? player.hand.map(card) : null,
      discards: player.discards.map((pile) => pile.map(card)),
    })),
  };
}

/** The events as `viewer` may see them: cards drawn into another player's hand stay face down. */
export function eventsFor(state, events, viewer) {
  return events.map((event) => {
    if (event.card === undefined) return event;
    const hidden = event.kind === 'draw' && event.to !== `hand:${viewer}`;
    return { ...event, card: hidden ? null : { id: event.card, v: state.values[event.card] } };
  });
}
