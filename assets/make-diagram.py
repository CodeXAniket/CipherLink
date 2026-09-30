# Generates the "How it works" diagram for the README in a light and a dark version,
# so it matches whichever GitHub theme the reader uses. Same black-and-white style as the app.
TEMPLATE = r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 940 540" font-family="'Segoe UI',Helvetica,Arial,sans-serif" role="img" aria-label="CipherLink architecture: two browsers connect directly over an encrypted WebRTC DataChannel for messages, photos and videos, while a signaling server only relays presence and the handshake and never sees messages.">
  <rect x="0" y="0" width="940" height="540" fill="{BG}"/>

  <!-- direct encrypted link between the two browsers -->
  <text x="470" y="96" text-anchor="middle" fill="{INK}" font-size="17" font-weight="700" letter-spacing="1.5">DIRECT &#183; ENCRYPTED (DTLS 1.3)</text>
  <g stroke="{INK}" stroke-width="4" stroke-linecap="round">
    <line x1="322" y1="150" x2="618" y2="150"/>
    <line x1="322" y1="150" x2="344" y2="138"/>
    <line x1="322" y1="150" x2="344" y2="162"/>
    <line x1="618" y1="150" x2="596" y2="138"/>
    <line x1="618" y1="150" x2="596" y2="162"/>
  </g>
  <!-- lock on the link -->
  <g transform="translate(454,132)">
    <rect x="0" y="8" width="32" height="22" rx="4" fill="{BG}" stroke="{INK}" stroke-width="3"/>
    <path d="M6 8 V4 a10 10 0 0 1 20 0 V8" fill="none" stroke="{INK}" stroke-width="3"/>
    <circle cx="16" cy="18" r="3.2" fill="{INK}"/>
  </g>
  <text x="470" y="196" text-anchor="middle" fill="{SUB}" font-size="15" font-weight="600">messages &#183; photos &#183; videos, peer to peer</text>

  <!-- Browser A -->
  <g>
    <rect x="40" y="70" width="282" height="160" rx="14" fill="{CARD}" stroke="{INK}" stroke-width="3"/>
    <path d="M40 100 h282" stroke="{INK}" stroke-width="2" opacity="0.35"/>
    <circle cx="62" cy="85" r="4" fill="{SUB}"/><circle cx="78" cy="85" r="4" fill="{SUB}"/><circle cx="94" cy="85" r="4" fill="{SUB}"/>
    <text x="181" y="90" text-anchor="middle" fill="{SUB}" font-size="12" font-weight="700" letter-spacing="1.5">YOUR BROWSER</text>
    <text x="64" y="132" fill="{INK}" font-size="16" font-weight="700">Chat UI</text>
    <text x="64" y="160" fill="{INK}" font-size="15">IndexedDB &#8212; history</text>
    <text x="64" y="186" fill="{INK}" font-size="15">Device key (ECDSA)</text>
    <text x="64" y="212" fill="{SUB}" font-size="13">Friend code &#183; contacts</text>
  </g>

  <!-- Browser B -->
  <g>
    <rect x="618" y="70" width="282" height="160" rx="14" fill="{CARD}" stroke="{INK}" stroke-width="3"/>
    <path d="M618 100 h282" stroke="{INK}" stroke-width="2" opacity="0.35"/>
    <circle cx="640" cy="85" r="4" fill="{SUB}"/><circle cx="656" cy="85" r="4" fill="{SUB}"/><circle cx="672" cy="85" r="4" fill="{SUB}"/>
    <text x="759" y="90" text-anchor="middle" fill="{SUB}" font-size="12" font-weight="700" letter-spacing="1.5">FRIEND'S BROWSER</text>
    <text x="642" y="132" fill="{INK}" font-size="16" font-weight="700">Chat UI</text>
    <text x="642" y="160" fill="{INK}" font-size="15">IndexedDB &#8212; history</text>
    <text x="642" y="186" fill="{INK}" font-size="15">Device key (ECDSA)</text>
    <text x="642" y="212" fill="{SUB}" font-size="13">Friend code &#183; contacts</text>
  </g>

  <!-- lines down to the signaling server -->
  <g stroke="{INK}" stroke-width="3" stroke-dasharray="2 8" stroke-linecap="round">
    <line x1="181" y1="230" x2="181" y2="404"/>
    <line x1="759" y1="230" x2="759" y2="404"/>
  </g>
  <g fill="{INK}">
    <path d="M181 412 l-7 -12 h14 z"/>
    <path d="M759 412 l-7 -12 h14 z"/>
  </g>
  <text x="196" y="322" fill="{SUB}" font-size="13" font-weight="600">WebSocket</text>
  <text x="744" y="322" text-anchor="end" fill="{SUB}" font-size="13" font-weight="600">WebSocket</text>

  <!-- Signaling server -->
  <g>
    <rect x="150" y="416" width="640" height="96" rx="14" fill="{SERVERBG}"/>
    <text x="470" y="452" text-anchor="middle" fill="{SERVERTX}" font-size="19" font-weight="700" letter-spacing="1">SIGNALING SERVER &#183; Node.js + WebSocket</text>
    <text x="470" y="478" text-anchor="middle" fill="{SERVERSUB}" font-size="14">signed sign-in &#183; presence of known codes &#183; chat requests &#183; WebRTC handshake</text>
    <g transform="translate(360,490)">
      <rect x="0" y="0" width="220" height="16" rx="8" fill="none" stroke="{SERVERSUB}" stroke-width="1.5"/>
      <text x="110" y="12" text-anchor="middle" fill="{SERVERTX}" font-size="11" font-weight="700" letter-spacing="1">NEVER SEES YOUR MESSAGES</text>
    </g>
  </g>

  <!-- CipherLink logo mark, bottom-left watermark -->
  <g transform="translate(40,506)" opacity="0.9">
    <circle cx="6" cy="8" r="5" fill="{INK}"/><circle cx="42" cy="8" r="5" fill="{INK}"/>
    <path d="M11 8 h26" stroke="{INK}" stroke-width="2.5" stroke-linecap="round"/>
    <text x="56" y="12" fill="{SUB}" font-size="12" font-weight="700" letter-spacing="1">CIPHERLINK</text>
  </g>
</svg>
'''

THEMES = {
    'light': {
        'BG': '#ffffff', 'INK': '#111111', 'SUB': '#707072', 'CARD': '#ffffff',
        'SERVERBG': '#111111', 'SERVERTX': '#ffffff', 'SERVERSUB': '#c9c9cb',
    },
    'dark': {
        'BG': '#0d1117', 'INK': '#e6edf3', 'SUB': '#9198a1', 'CARD': '#161b22',
        'SERVERBG': '#e6edf3', 'SERVERTX': '#0d1117', 'SERVERSUB': '#57606a',
    },
}

for name, colors in THEMES.items():
    svg = TEMPLATE
    for token, value in colors.items():
        svg = svg.replace('{' + token + '}', value)
    with open(f'assets/architecture-{name}.svg', 'w', encoding='utf-8') as f:
        f.write(svg)
    print(f'wrote assets/architecture-{name}.svg')
