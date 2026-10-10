// Peer-to-peer connection between the two browsers, built on PeerJS (loaded as the
// global `Peer`). The host registers a predictable peer id derived from the room
// code, so the guest can reach it with nothing but the code from the invite link.
//
// Both ends send a ping every few seconds and drop a connection that has gone quiet:
// WebRTC can take a long time to notice a vanished peer on its own, and a stale
// connection would keep a returning guest out.

const PEER_PREFIX = 'cat-and-mouse-';
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PING_INTERVAL = 3000;
const SILENCE_LIMIT = 10000;

export function randomCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Wraps a DataConnection with the ping protocol; `onMessage` never sees the pings. */
function watch(conn, { onMessage, onClose }) {
  let lastHeard = Date.now();
  let closed = false;
  const timer = setInterval(() => {
    if (Date.now() - lastHeard > SILENCE_LIMIT) return close();
    if (conn.open) conn.send({ type: 'ping' });
  }, PING_INTERVAL);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    conn.close();
    onClose();
  };
  conn.on('data', (msg) => {
    lastHeard = Date.now();
    if (msg?.type !== 'ping') onMessage(msg);
  });
  conn.on('close', close);
  conn.on('error', close);
  return { send: (msg) => conn.open && conn.send(msg), close, get open() { return !closed && conn.open; } };
}

/**
 * The host's side. A guest is only accepted after it introduced itself with a
 * `hello` message, and `accept(hello)` decides whether it may take the seat.
 */
export class HostLink {
  constructor(code, { onReady, onMessage, onGuest, onError, accept }) {
    Object.assign(this, { code, onReady, onMessage, onGuest, onError, accept });
    this.guest = null;
    this.attempts = 0;
  }

  start() {
    const peer = new Peer(PEER_PREFIX + this.code);
    this.peer = peer;
    peer.on('open', () => {
      this.attempts = 0;
      this.onReady();
    });
    peer.on('connection', (conn) => this.#incoming(conn));
    peer.on('disconnected', () => {
      if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000);
    });
    peer.on('error', (err) => {
      // The signalling server holds on to the id of a page that was just reloaded
      // for a moment, so a taken id is retried before giving up.
      if (err.type === 'unavailable-id' && this.attempts++ < 10) {
        peer.destroy();
        setTimeout(() => this.start(), 2000);
      } else if (!['peer-unavailable', 'network'].includes(err.type)) {
        this.onError(err);
      }
    });
  }

  #incoming(conn) {
    let link = null;
    conn.on('open', () => {
      link = watch(conn, {
        onMessage: (msg) => {
          if (this.guest === link) return this.onMessage(msg);
          if (msg?.type !== 'hello') return;
          if (!this.accept(msg, this.guest?.open ?? false)) {
            link.send({ type: 'full' });
            setTimeout(() => link.close(), 500);
            return;
          }
          const previous = this.guest;
          this.guest = link;
          previous?.close();
          this.onGuest(true);
          this.onMessage(msg);
        },
        onClose: () => {
          if (this.guest !== link) return;
          this.guest = null;
          this.onGuest(false);
        },
      });
    });
  }

  send(msg) {
    this.guest?.send(msg);
  }
}

/** The guest's side, which keeps reconnecting to the host until the page is closed. */
export class GuestLink {
  constructor(code, { onMessage, onStatus, onError, hello }) {
    Object.assign(this, { code, onMessage, onStatus, onError, hello });
    this.link = null;
    this.retryTimer = null;
    this.stopped = false;
  }

  start() {
    this.onStatus('connecting');
    const peer = new Peer();
    this.peer = peer;
    peer.on('open', () => this.#connect());
    peer.on('disconnected', () => {
      if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000);
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        this.onStatus('host-away');
        this.#retry();
      } else if (['network', 'disconnected', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        this.onStatus('reconnecting');
        this.#retry();
      } else {
        this.onError(err);
      }
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.link?.close();
    this.peer?.destroy();
  }

  #connect() {
    if (this.stopped || this.link?.open) return;
    if (this.peer.disconnected) {
      this.peer.reconnect();
      return this.#retry();
    }
    const conn = this.peer.connect(PEER_PREFIX + this.code, { reliable: true });
    const giveUp = setTimeout(() => {
      conn.close();
      this.#retry();
    }, 15000);
    conn.on('open', () => {
      clearTimeout(giveUp);
      const link = watch(conn, {
        onMessage: (msg) => this.onMessage(msg),
        onClose: () => {
          if (this.link !== link) return;
          this.link = null;
          if (this.stopped) return;
          this.onStatus('reconnecting');
          this.#retry();
        },
      });
      this.link = link;
      this.onStatus('connected');
      link.send(this.hello());
    });
  }

  #retry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.#connect(), 3000);
  }

  send(msg) {
    this.link?.send(msg);
  }
}
