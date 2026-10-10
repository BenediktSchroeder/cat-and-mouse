// The STUN and TURN servers WebRTC uses to connect host and guest. The TURN relay
// (Metered) forwards the traffic when the two browsers cannot reach each other
// directly, as on guest Wi-Fi or behind a mobile carrier's NAT. Its credential is
// readable by anyone who opens the page; it only grants use of the relay, and it
// can be replaced in the Metered dashboard if it is abused.

const relay = {
  username: 'f2f0432181c68bffad8b13a3',
  credential: 'HnXqrLV1SSgXlZc1',
};

export const ICE_SERVERS = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', ...relay },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', ...relay },
  { urls: 'turn:global.relay.metered.ca:443', ...relay },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', ...relay },
];
