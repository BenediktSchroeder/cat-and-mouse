# Cat & Mouse

A card game for two players in the browser. The two browsers talk to each other directly
over WebRTC ([PeerJS](https://peerjs.com/)); the public PeerJS server only introduces
them to each other. The page is static and runs on GitHub Pages without a build step.

## Playing

1. Open the page, enter your name and click **Create game**.
2. Send the invite link to your partner. The game starts as soon as they open it.
3. Click a card and then where it should go, or drag it there. Double-clicking a
   number card plays it onto the first building pile it fits. To discard a set, click
   each of its cards in your hand, then click a discard pile or drag the set there.

The browser that created the game hosts it and keeps it in its local storage, so
either player can reload the page or lose the connection and carry on where they left off.
The host must keep the tab open (or reopen it) for the game to continue.

## Rules

The basic rules for two players: 162 cards (twelve each of 1–12 and 18
jokers), 30 cards per stock pile, four shared building piles from 1 to 12, four
discard piles per player. Draw up to five cards at the start of your turn, draw five
more whenever your hand runs empty during your turn, end your turn by discarding a
hand card. Whoever empties their stock first wins.

House rule: a joker that turns up on top of your stock moves into your hand
automatically, no matter how many cards you hold. Holding five or more cards at the
start of your turn, you draw none. Everything is resolved the moment it happens, so
if your hand runs empty before the joker turns up you draw five and then get the
joker, but if the joker turns up first you have to play it too before you draw
again. At the start of the game every player gets five cards, and a joker on top of
their stock comes on top of those.

A joker that is the last card of the stock goes into the hand like any other, which
empties the stock and wins the game.

Second house rule: a turn may end by discarding several hand cards of the same
number together onto one discard pile. Jokers can form such a set among themselves,
but never join a set of numbers. The cards are stacked in the order they were picked.

## Development

The page is plain HTML, CSS and JavaScript modules.

```
npm start   # serves the page on http://localhost:8080
npm test    # runs the rules engine tests (Node 20+)
```

To try it alone, create a game in one browser tab and open the invite link in a
second one.

- `js/game.js`: the rules engine, free of any browser API
- `js/net.js`: the PeerJS connection between host and guest
- `js/ui.js`: rendering, input and animations
- `js/main.js`: lobby and the host and guest sessions

## Hosting on GitHub Pages

Push the repository to GitHub, then under **Settings → Pages** choose
**Deploy from a branch** with the branch `main` and the folder `/ (root)`.
