import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction,
  createDeck,
  eventsFor,
  HAND_SIZE,
  JOKER,
  newGame,
  restoreState,
  RuleError,
  STOCK_SIZE,
  viewFor,
} from '../js/game.js';

const J = JOKER;

/**
 * Builds a game state from face values. Piles are listed bottom to top, so the last
 * value is the top card. Returns the state and a lookup from a player's hand index
 * to card id.
 */
function makeState({ players, draw = [], build = [[], [], [], []], current = 0 }) {
  const values = [];
  const add = (pile) => pile.map((v) => values.push(v) - 1);
  return {
    values,
    players: players.map((p, i) => ({
      name: `P${i}`,
      stock: add(p.stock ?? [7]),
      hand: add(p.hand ?? []),
      discards: (p.discards ?? [[], [], [], []]).map(add),
    })),
    draw: add(draw),
    completed: [],
    build: build.map(add),
    current,
    turn: 1,
    winner: null,
  };
}

const handValues = (state, p) => state.players[p].hand.map((id) => state.values[id]);
const handCard = (state, p, value) => state.players[p].hand.find((id) => state.values[id] === value);

test('the deck has 162 cards: twelve of each number and 18 jokers', () => {
  const deck = createDeck();
  assert.equal(deck.length, 162);
  assert.equal(deck.filter((v) => v === J).length, 18);
  for (let v = 1; v <= 12; v++) assert.equal(deck.filter((x) => x === v).length, 12);
});

test('a new game deals 30 stock cards and five hand cards to each player', () => {
  const { state } = newGame(['A', 'B']);
  for (const player of state.players) {
    // Jokers on top of the stock have moved into the hand.
    const jokersTaken = STOCK_SIZE - player.stock.length;
    assert.equal(player.hand.length, HAND_SIZE + jokersTaken);
    assert.notEqual(state.values[player.stock.at(-1)], J);
  }
  assert.equal(state.draw.length + state.players.reduce((n, p) => n + p.stock.length + p.hand.length, 0), 162);
});

test('a joker on the stock at the start comes on top of the five dealt cards', () => {
  // Search for a seed whose deal puts a joker on top of a stock.
  for (let seed = 1; seed < 500; seed++) {
    let s = seed;
    const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const { state, events } = newGame(['A', 'B'], { rng, firstPlayer: 0 });
    const lucky = state.players.findIndex((p) => p.stock.length < STOCK_SIZE);
    if (lucky < 0) continue;
    const player = state.players[lucky];
    const jokersTaken = STOCK_SIZE - player.stock.length;
    assert.equal(player.hand.length, HAND_SIZE + jokersTaken);
    assert.ok(player.hand.slice(HAND_SIZE).every((id) => state.values[id] === J));
    assert.ok(events.some((e) => e.kind === 'joker' && e.to === `hand:${lucky}`));
    return;
  }
  assert.fail('no seed produced a joker on a stock');
});

test('cards must be played in ascending order, jokers fit anywhere', () => {
  const state = makeState({ players: [{ hand: [2, 1, J, 5, 6] }, {}] });
  assert.throws(() => applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, 2), to: 0 }), RuleError);
  applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, 1), to: 0 });
  applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, 2), to: 0 });
  applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, J), to: 0 });
  assert.equal(state.build[0].length, 3);
  assert.throws(() => applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, 6), to: 0 }), RuleError);
});

test('only the player whose turn it is may act', () => {
  const state = makeState({ players: [{ hand: [1] }, { hand: [1] }] });
  assert.throws(() => applyAction(state, 1, { type: 'play', from: 'hand', card: state.players[1].hand[0], to: 0 }), RuleError);
});

test('a completed building pile is cleared and later reshuffled into the draw pile', () => {
  const state = makeState({
    players: [{ hand: [12, 3] }, { hand: [4, 4, 4, 4] }],
    build: [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, J], [], [], []],
  });
  const events = applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, 12), to: 0 });
  assert.deepEqual(state.build[0], []);
  assert.equal(state.completed.length, 12);
  assert.ok(events.some((e) => e.kind === 'complete' && e.pile === 0));

  // The draw pile is empty, so player 1 draws from the reshuffled completed pile.
  const turnEvents = applyAction(state, 0, { type: 'discard', cards: [handCard(state, 0, 3)], pile: 0 });
  assert.ok(turnEvents.some((e) => e.kind === 'reshuffle'));
  assert.equal(state.players[1].hand.length, HAND_SIZE);
  assert.equal(state.draw.length, 11);
  assert.equal(state.completed.length, 0);
});

test('emptying the hand during the turn draws five new cards', () => {
  const state = makeState({ players: [{ hand: [1, 2] }, {}], draw: [9, 9, 9, 9, 9, 9] });
  applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, 1), to: 0 });
  assert.equal(state.players[0].hand.length, 1);
  applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, 2), to: 0 });
  assert.deepEqual(handValues(state, 0), [9, 9, 9, 9, 9]);
});

test('discarding ends the turn and the next player draws up to five', () => {
  const state = makeState({ players: [{ hand: [8, 9] }, { hand: [3, 3] }], draw: [5, 5, 5, 5] });
  applyAction(state, 0, { type: 'discard', cards: [handCard(state, 0, 8)], pile: 2 });
  assert.equal(state.current, 1);
  assert.equal(state.players[0].discards[2].length, 1);
  assert.deepEqual(handValues(state, 1), [3, 3, 5, 5, 5]);
});

const handCards = (state, p, value) => state.players[p].hand.filter((id) => state.values[id] === value);

test('several cards of the same number can be discarded together onto one pile', () => {
  const state = makeState({ players: [{ hand: [5, 9, 5, 5] }, {}], draw: [1, 1, 1, 1, 1] });
  const fives = handCards(state, 0, 5);
  const events = applyAction(state, 0, { type: 'discard', cards: [fives[2], fives[0]], pile: 1 });
  assert.deepEqual(state.players[0].discards[1], [fives[2], fives[0]]);
  assert.deepEqual(handValues(state, 0), [9, 5]);
  assert.equal(events.filter((e) => e.kind === 'discard').length, 2);
  assert.equal(state.current, 1);
});

test('a set of jokers can be discarded together', () => {
  const state = makeState({ players: [{ hand: [J, 4, J] }, {}] });
  applyAction(state, 0, { type: 'discard', cards: handCards(state, 0, J), pile: 0 });
  assert.deepEqual(handValues(state, 0), [4]);
  assert.equal(state.players[0].discards[0].length, 2);
});

test('a discarded set must be all of one kind, without mixing jokers in', () => {
  const state = makeState({ players: [{ hand: [5, 6, J, 5] }, {}] });
  const reject = (cards) => assert.throws(() => applyAction(state, 0, { type: 'discard', cards, pile: 0 }), RuleError);
  reject([handCard(state, 0, 5), handCard(state, 0, 6)]);
  reject([handCard(state, 0, 5), handCard(state, 0, J)]);
  reject([handCard(state, 0, 5), handCard(state, 0, 5)]);
  reject([]);
  assert.equal(state.players[0].hand.length, 4);
  assert.equal(state.current, 0);
});

test('a joker uncovered on the stock moves into the hand, even beyond five cards', () => {
  const state = makeState({ players: [{ stock: [4, J, J, 1], hand: [6, 6, 6, 6, 6] }, {}] });
  const events = applyAction(state, 0, { type: 'play', from: 'stock', to: 0 });
  assert.deepEqual(handValues(state, 0), [6, 6, 6, 6, 6, J, J]);
  assert.equal(state.values[state.players[0].stock.at(-1)], 4);
  assert.deepEqual(events.filter((e) => e.kind === 'joker').length, 2);
});

test('a player holding five or more cards draws nothing at the start of the turn', () => {
  const state = makeState({
    players: [{ hand: [8] }, { hand: [6, 6, 6, 6, 6, J] }],
    draw: [5, 5, 5],
  });
  applyAction(state, 0, { type: 'discard', cards: [handCard(state, 0, 8)], pile: 0 });
  assert.equal(state.players[1].hand.length, 6);
  assert.equal(state.draw.length, 3);
});

test('race: emptying the hand before uncovering the joker draws five, then the joker joins them', () => {
  const state = makeState({ players: [{ stock: [J, 2], hand: [1] }, {}], draw: [9, 9, 9, 9, 9] });
  applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, 1), to: 0 });
  assert.deepEqual(handValues(state, 0), [9, 9, 9, 9, 9]);
  applyAction(state, 0, { type: 'play', from: 'stock', to: 0 });
  assert.deepEqual(handValues(state, 0), [9, 9, 9, 9, 9, J]);
});

test('race: uncovering the joker before emptying the hand means the joker must be played too', () => {
  const state = makeState({ players: [{ stock: [5, J, 1], hand: [2] }, {}], draw: [9, 9, 9, 9, 9] });
  applyAction(state, 0, { type: 'play', from: 'stock', to: 0 });
  assert.deepEqual(handValues(state, 0), [2, J]);
  applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, 2), to: 0 });
  assert.deepEqual(handValues(state, 0), [J]);
  applyAction(state, 0, { type: 'play', from: 'hand', card: handCard(state, 0, J), to: 0 });
  assert.deepEqual(handValues(state, 0), [9, 9, 9, 9, 9]);
});

test('emptying the stock wins the game', () => {
  const state = makeState({ players: [{ stock: [1], hand: [5] }, {}] });
  const events = applyAction(state, 0, { type: 'play', from: 'stock', to: 0 });
  assert.equal(state.winner, 0);
  assert.ok(events.some((e) => e.kind === 'win'));
  assert.throws(() => applyAction(state, 0, { type: 'discard', cards: [state.players[0].hand[0]], pile: 0 }), RuleError);
});

test('a joker as the last stock card goes into the hand, which empties the stock and wins', () => {
  const state = makeState({ players: [{ stock: [J, 1], hand: [5] }, {}] });
  applyAction(state, 0, { type: 'play', from: 'stock', to: 0 });
  assert.equal(state.players[0].stock.length, 0);
  assert.equal(state.winner, 0);
});

test('only the top card of a discard pile can be played', () => {
  const state = makeState({ players: [{ hand: [9], discards: [[1, 2], [2, 1], [], []] }, {}] });
  assert.throws(() => applyAction(state, 0, { type: 'play', from: 'discard', pile: 0, to: 0 }), RuleError);
  applyAction(state, 0, { type: 'play', from: 'discard', pile: 1, to: 0 });
  applyAction(state, 0, { type: 'play', from: 'discard', pile: 1, to: 0 });
  assert.equal(state.build[0].length, 2);
  assert.equal(state.players[0].discards[1].length, 0);
});

test('the view hides the opponent hand and the cards they draw', () => {
  const state = makeState({ players: [{ hand: [8] }, { hand: [3] }], draw: [5, 5, 5, 5, 5] });
  const events = applyAction(state, 0, { type: 'discard', cards: [handCard(state, 0, 8)], pile: 0 });
  const view = viewFor(state, 0);
  assert.equal(view.players[1].hand, null);
  assert.equal(view.players[1].handCount, 5);
  assert.deepEqual(view.players[0].hand, []);
  const forViewer = eventsFor(state, events, 0).filter((e) => e.kind === 'draw');
  assert.ok(forViewer.every((e) => e.card === null));
  const forDrawer = eventsFor(state, events, 1).filter((e) => e.kind === 'draw');
  assert.ok(forDrawer.every((e) => e.card.v === 5));
});

/** A game a few turns in, written to a file and read back as the host does. */
function savedGame() {
  const { state } = newGame(['A', 'B'], { firstPlayer: 0 });
  for (let turn = 0; turn < 4; turn++) {
    const p = state.current;
    applyAction(state, p, { type: 'discard', cards: [state.players[p].hand[0]], pile: turn % 4 });
  }
  return JSON.parse(JSON.stringify(state));
}

test('a saved game is restored as it was and can be played on', () => {
  const saved = savedGame();
  const state = restoreState({ ...saved, extra: 'ignored' });
  assert.deepEqual(state, saved);
  const p = state.current;
  applyAction(state, p, { type: 'discard', cards: [state.players[p].hand[0]], pile: 0 });
  assert.equal(state.turn, saved.turn + 1);
});

test('a saved game with a card missing, duplicated or out of place is refused', () => {
  const broken = [
    (s) => s.draw.pop(),
    (s) => s.draw.push(s.draw[0]),
    (s) => s.players[0].hand.push(s.draw.pop() + 0.5),
    (s) => s.values.pop(),
    (s) => { s.values[s.values.indexOf(J)] = 1; },
    (s) => s.build[0].push(s.draw.splice(s.draw.findIndex((id) => s.values[id] === 5), 1)[0]),
    (s) => s.players.pop(),
    (s) => s.players[1].discards.pop(),
    (s) => { s.current = 2; },
    (s) => { s.winner = -1; },
    (s) => { s.turn = 0; },
    (s) => { delete s.completed; },
  ];
  for (const breakIt of broken) {
    const saved = savedGame();
    breakIt(saved);
    assert.throws(() => restoreState(saved), RuleError, breakIt.toString());
  }
  assert.throws(() => restoreState(null), RuleError);
  assert.throws(() => restoreState('game'), RuleError);
});
