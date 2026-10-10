// Page flow: create or join a room, then play.
//
// The host's browser owns the game: it applies every action to the authoritative
// state, keeps that state in localStorage so a reload resumes the game, and sends
// each player only the view they may see. The guest's browser just renders the views
// it receives and forwards the player's actions.

import { RuleError, newGame, applyAction, viewFor, eventsFor } from './game.js';
import { HostLink, GuestLink, randomCode } from './net.js';
import { Board } from './ui.js';

// Both pages must run the same code: a page opened before an update keeps its old
// code, and its moves would be judged by different rules. Raise this number whenever
// the rules or the messages between the pages change.
const VERSION = 2;

const $ = (selector) => document.querySelector(selector);
const lobby = $('#lobby');
const boardRoot = $('#board');
const statusEl = $('#status');
const inviteButton = $('#invite-button');
const overlay = $('#overlay');

const storage = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(`cat-and-mouse:${key}`)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(`cat-and-mouse:${key}`, JSON.stringify(value)); } catch { /* not persisted */ }
  },
};

function clientId() {
  let id = storage.get('client');
  if (!id) {
    id = randomCode(16);
    storage.set('client', id);
  }
  return id;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

function setStatus(text, tone = 'neutral') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function inviteLink(code) {
  return `${location.origin}${location.pathname}?join=${code}`;
}

async function copyInvite(code) {
  try {
    await navigator.clipboard.writeText(inviteLink(code));
    toast('Invite link copied.');
  } catch {
    toast(inviteLink(code));
  }
}

function showLobby(...content) {
  boardRoot.hidden = true;
  lobby.hidden = false;
  lobby.replaceChildren(...content);
}

function fromHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---- game over ------------------------------------------------------------

let overlayTimer;
function showResult(view, delay, onRematch) {
  clearTimeout(overlayTimer);
  if (view.winner === null) {
    overlay.hidden = true;
    return;
  }
  overlayTimer = setTimeout(() => {
    const won = view.winner === view.you;
    $('#overlay-title').textContent = won ? 'You win!' : `${view.players[view.winner].name} wins!`;
    $('#overlay-text').textContent = won
      ? 'Your stock is empty. Well played.'
      : 'Their stock is empty. Better luck next round.';
    $('#again').onclick = () => {
      overlay.hidden = true;
      onRematch();
    };
    overlay.hidden = false;
  }, delay);
}

function showView(board, view, events, onRematch) {
  lobby.hidden = true;
  boardRoot.hidden = false;
  const duration = board.update(view, events);
  const myTurn = view.winner === null && view.current === view.you;
  document.title = myTurn ? '● Your turn · Cat & Mouse' : 'Cat & Mouse';
  showResult(view, duration + 300, onRematch);
}

// ---- host -----------------------------------------------------------------

class HostSession {
  constructor(code, name) {
    this.code = code;
    this.name = name;
    const saved = storage.get(`game:${code}`);
    this.state = saved?.state ?? null;
    this.guestId = saved?.guestId ?? null;
    this.guestName = this.state?.players[1].name ?? null;
    this.guestOnline = false;
    this.board = new Board(boardRoot, {
      onAction: (action) => this.act(0, action),
      onMessage: toast,
    });
    this.link = new HostLink(code, {
      onReady: () => this.refresh(),
      accept: (hello, seatTaken) => !this.guestId || hello.clientId === this.guestId || !seatTaken,
      onGuest: (online) => {
        this.guestOnline = online;
        this.refresh();
      },
      onMessage: (msg) => this.receive(msg),
      onError: (err) => fatal(`Could not open the room (${err.type ?? err.message}).`),
    });
    inviteButton.hidden = false;
    inviteButton.onclick = () => copyInvite(code);
    setStatus('Opening the room…');
    if (this.state) this.publish([]);
    else showLobby(fromHtml('<div class="panel"><h2>Opening the room</h2><p class="hint"><span class="pulse"></span> One moment…</p></div>'));
    this.link.start();
  }

  receive(msg) {
    if (msg.type === 'hello') {
      this.guestName = String(msg.name || 'Partner').slice(0, 24);
      this.outdated = msg.version !== VERSION;
      this.refresh();
      if (this.outdated) {
        this.link.send({ type: 'mismatch' });
        return;
      }
      this.guestId = msg.clientId;
      if (this.state) {
        this.state.players[1].name = this.guestName;
        this.save();
        this.publish([]);
      } else {
        this.start(Math.floor(Math.random() * 2));
      }
    } else if (this.outdated) {
      // A guest running other code is not listened to.
    } else if (msg.type === 'action') {
      this.act(1, msg.action);
    } else if (msg.type === 'rematch') {
      this.rematch();
    }
  }

  start(firstPlayer) {
    const { state, events } = newGame([this.name, this.guestName ?? 'Partner'], { firstPlayer });
    this.state = state;
    this.save();
    this.publish(events);
    this.refresh();
  }

  rematch() {
    // The loser of the last round begins the next one.
    if (this.state?.winner !== null) this.start((this.state.winner + 1) % 2);
  }

  act(p, action) {
    if (!this.state) return;
    let events;
    try {
      events = applyAction(this.state, p, action);
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      if (p === 0) {
        this.board.reject();
        toast(err.message);
      } else {
        this.link.send({ type: 'error', message: err.message });
      }
      return;
    }
    this.save();
    this.publish(events);
  }

  publish(events) {
    showView(this.board, viewFor(this.state, 0), eventsFor(this.state, events, 0), () => this.rematch());
    this.link.send({
      type: 'state', version: VERSION, view: viewFor(this.state, 1), events: eventsFor(this.state, events, 1),
    });
  }

  save() {
    storage.set(`game:${this.code}`, { state: this.state, guestId: this.guestId });
  }

  refresh() {
    const partner = this.guestName ?? 'Your partner';
    if (this.guestOnline && this.outdated) setStatus(`${partner}'s page runs a different version. Both of you reload the page.`, 'bad');
    else if (this.guestOnline) setStatus(`${partner} is connected`, 'good');
    else if (this.state) setStatus(`${partner} is offline. They can rejoin with the invite link.`, 'warn');
    else setStatus('Waiting for your partner…', 'neutral');
    if (!this.state) this.showInvite();
  }

  showInvite() {
    const link = inviteLink(this.code);
    showLobby(fromHtml(`
      <div class="panel">
        <h2>Invite your partner</h2>
        <p>Send them this link. The game starts as soon as they open it.</p>
        <div class="invite">
          <input class="input" id="invite-link" readonly value="${escapeHtml(link)}">
          <button class="button" id="copy-invite">Copy</button>
        </div>
        <p class="hint"><span class="pulse"></span> Waiting for your partner to join…</p>
      </div>`));
    $('#copy-invite').onclick = () => copyInvite(this.code);
    $('#invite-link').onfocus = (e) => e.target.select();
  }
}

// ---- guest ----------------------------------------------------------------

function joinAsGuest(code, name) {
  const board = new Board(boardRoot, {
    onAction: (action) => link.send({ type: 'action', action }),
    onMessage: toast,
  });
  const rematch = () => link.send({ type: 'rematch' });
  let started = false;
  const link = new GuestLink(code, {
    hello: () => ({ type: 'hello', name, clientId: clientId(), version: VERSION }),
    onStatus: (status) => {
      const text = {
        connecting: ['Connecting…', 'neutral'],
        connected: ['Connected', 'good'],
        reconnecting: ['Connection lost, reconnecting…', 'warn'],
        'host-away': ['The host is offline. Retrying…', 'warn'],
        unreachable: ['Cannot reach the host’s browser. Retrying…', 'warn'],
      }[status];
      setStatus(...text);
      if (!started && status !== 'connected') {
        showLobby(fromHtml(`<div class="panel"><h2>Joining the game</h2><p class="hint"><span class="pulse"></span> ${escapeHtml(text[0])}</p></div>`));
      }
    },
    onMessage: (msg) => {
      if (msg.type === 'mismatch' || (msg.type === 'state' && msg.version !== VERSION)) {
        link.stop();
        showMismatch();
      } else if (msg.type === 'state') {
        started = true;
        showView(board, msg.view, msg.events, rematch);
      } else if (msg.type === 'error') {
        board.reject();
        toast(msg.message);
      } else if (msg.type === 'full') {
        link.stop();
        fatal('This game already has two players.');
      }
    },
    onError: (err) => fatal(`Could not connect (${err.type ?? err.message}).`),
  });
  link.start();
}

// ---- start ----------------------------------------------------------------

function fatal(message) {
  setStatus('Not connected', 'bad');
  showLobby(fromHtml(`
    <div class="panel">
      <h2>Something went wrong</h2>
      <p>${escapeHtml(message)}</p>
      <a class="button" href="${escapeHtml(location.pathname)}">Back to the start</a>
    </div>`));
}

function showMismatch() {
  setStatus('Different versions', 'bad');
  showLobby(fromHtml(`
    <div class="panel">
      <h2>Different versions</h2>
      <p>Your page and your partner's page run different versions of the game.
        Both of you reload the page; the game continues where it was.</p>
      <p>If the message stays, reload while holding Shift.</p>
      <button class="button button--primary" id="reload">Reload</button>
    </div>`));
  $('#reload').onclick = () => location.reload();
}

function askName(title, text, buttonLabel, onSubmit) {
  showLobby(fromHtml(`
    <form class="panel" id="name-form">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(text)}</p>
      <label class="field">
        <span>Your name</span>
        <input class="input" id="name" maxlength="24" required autocomplete="nickname">
      </label>
      <button class="button button--primary" type="submit">${escapeHtml(buttonLabel)}</button>
    </form>`), $('#rules-template').content.cloneNode(true));
  const input = $('#name');
  input.value = storage.get('name') ?? '';
  input.focus();
  $('#name-form').onsubmit = (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    storage.set('name', name);
    onSubmit(name);
  };
}

function main() {
  if (typeof Peer === 'undefined') {
    fatal('The connection library could not be loaded. Check your internet connection and reload.');
    return;
  }
  const params = new URLSearchParams(location.search);
  const hostCode = params.get('host');
  const joinCode = params.get('join');
  setStatus('');

  if (hostCode) {
    const name = storage.get('name');
    if (name) new HostSession(hostCode, name);
    else askName('Resume your game', 'Enter your name to reopen the room.', 'Open room', (n) => new HostSession(hostCode, n));
  } else if (joinCode) {
    askName('You are invited', 'Enter your name to join the game.', 'Join game', (name) => {
      joinAsGuest(joinCode, name);
    });
  } else {
    askName('A card game for two', 'Start a room and send the invite link to your partner.', 'Create game', (name) => {
      const code = randomCode();
      history.replaceState(null, '', `?host=${code}`);
      new HostSession(code, name);
    });
  }
}

main();
