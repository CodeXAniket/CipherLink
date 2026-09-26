# CipherLink: Peer-to-Peer Chat in the Browser

### ▶ Try it live: **[cipherlink.duckdns.org](https://cipherlink.duckdns.org)**

A web messenger where chats, photos and videos go **directly between two browsers** over WebRTC.
The server only introduces users to each other. It never sees, relays or stores messages or files.
Chat history and contacts are saved only on each user's own device.

Built by **Aniket Deotale**.

## How to use it

1. Open [cipherlink.duckdns.org](https://cipherlink.duckdns.org) and join with a random display name.
2. Share your **friend code** (shown in the sidebar, like `K7QM-4XPD`) with a friend.
3. One of you enters the other's code under **Add someone by code**. The other accepts the request.
4. You're connected directly. Chat, send photos and videos, and compare the **safety number**.

Both people need to be online at the same time: there is no server to hold messages for later.

## Features

- **Friend codes:** every device gets a random code (like `K7QM-4XPD`). You add people by code, so strangers can't find you
- **Chat requests:** the other person accepts or declines; accepting saves you in each other's contacts
- **Contacts with live status:** the server only reports the online status of codes you already know
- Direct peer-to-peer text chat (WebRTC DataChannel, encrypted with DTLS)
- **Stays connected:** if the direct link drops (phone app in the background, network change), the chat
  reconnects automatically; only End chat closes it
- **Replies** (hover the reply button, or swipe a message right on touch screens) and a **typing indicator**
- **Delete messages** for yourself, or for everyone while connected (long-press on touch screens)
- **Cancel** a photo or video while it's sending or receiving, from either side
- **Photos and videos** up to 100 MB, sent in 16 KB chunks with backpressure and a progress bar
- **Live connection panel:** network route, latency and encryption, read from WebRTC's own stats
- **Safety number** to verify that nobody is intercepting the chat (MITM detection)
- Chat history stored locally in IndexedDB, with export to JSON
- Notification sounds synthesized with the Web Audio API (no audio files), with an on/off toggle
- Responsive design for desktop and mobile

## How it works

```
   Your browser                                     Friend's browser
 ┌─────────────────┐   direct, encrypted (DTLS)   ┌─────────────────┐
 │ UI + IndexedDB  │◄════════════════════════════►│ UI + IndexedDB  │
 └────────┬────────┘   text, photos, videos        └────────┬────────┘
          │  WebSocket: presence of known codes,            │
          │  chat requests, WebRTC handshake                │
          ▼                                                 ▼
        ┌───────────────────────────────────────────────────────┐
        │   Signaling server (Node.js) — never sees messages     │
        └───────────────────────────────────────────────────────┘
```

1. Each browser creates a random friend code and joins the signaling server with it.
2. You enter a friend's code; the server forwards your chat request.
3. They accept. The browsers exchange an **offer/answer** (SDP) and **ICE candidates** through the server.
4. A direct **WebRTC DataChannel** opens. Messages and files go browser to browser.
   Even if the server is shut down, the open chat keeps working.

### Presence without a public user list
Clients send the server the codes of their contacts ("watch" list). The server only tells each
client about those codes. There is no global list of who is online.

### Photos and videos
A file is sent as a JSON `file-start` (name, type, size), then 16 KB binary chunks, then `file-end`.
The sender pauses whenever more than 1 MB is queued in the channel (**backpressure**) and resumes when
it drains, so large videos never pile up in memory. Only formats that render inside `<img>` or
`<video>` are accepted (no SVG), and media is never opened as a page.

### Safety number (MITM detection)
Each WebRTC connection uses a DTLS certificate whose fingerprint is included in the SDP. Both users
hash the two fingerprints (SHA-256) into a 30-digit number. A server attempting a man-in-the-middle
attack would have to swap in its own certificates, so the two users would see different numbers.

## Tech stack

| Part | Technology |
|---|---|
| Frontend | HTML, CSS, vanilla JavaScript (ES modules) |
| P2P connection | WebRTC (RTCPeerConnection, DataChannel), Google STUN server |
| Local storage | IndexedDB (messages, media blobs, contacts) |
| Hashing / randomness | Web Crypto API |
| Signaling server | Node.js, Express (static files), `ws` (WebSocket) |
| Hosting | AWS EC2 (Ubuntu), systemd, Caddy (automatic HTTPS via Let's Encrypt), DuckDNS |

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser tabs. The second tab gets its own temporary code. Copy one
tab's code, add it from the other tab, and accept the request.

## Deployment

The live site runs on a single AWS EC2 `t3.micro` instance:

```
Visitor ──HTTPS──► Caddy (ports 80/443, automatic Let's Encrypt certificate)
                     └──► Node.js app on localhost:3000 (systemd service, restarts on failure)
```

Only ports 80 and 443 are open to the internet; the app port is reachable only through Caddy.
Photos and videos never pass through the server, so hosting costs stay the same no matter how much
media people send.

## Project structure

```
server.js          Signaling server: friend codes, watch-list presence, relays requests and handshakes
public/index.html  Page layout
public/style.css   Styling
public/app.js      App logic: identity, contacts, chat-request flow, file transfer, UI
public/peer.js     WebRTC connection, DataChannel, backpressure, stats and safety number
public/storage.js  IndexedDB: messages, media and contacts
public/sounds.js   Notification sounds (Web Audio API)
```

## Design decisions and limitations

- **Both users must be online.** Offline delivery would require a central store; this app has none.
  File transfers also need both people online until they finish.
- **One chat at a time.** New requests are auto-declined as "busy" while you're in a chat.
- **Encrypted in transit, not at rest.** Messages and media saved in IndexedDB are not encrypted.
- **Codes are not accounts.** Someone who learns your code could use it while you're offline. The
  safety number would reveal this; binding codes to a device key pair is the proper fix.
- **Strict networks** (some mobile and corporate networks) need a TURN relay. The server supports one
  through the `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL` environment variables.
- **Clearing browser data deletes your code, contacts and history.** Use Export to keep a copy of chats.

## Future improvements

- Encrypt local storage with a password-derived key
- Tie friend codes to a persistent device key pair
- Several chats at once (one peer connection per contact)
- TURN server for strict networks

## License

[MIT](LICENSE) © Aniket Deotale
