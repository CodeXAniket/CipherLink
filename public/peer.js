// One WebRTC connection to one peer.
// The server only carries the handshake (via `sendSignal`). Once the DataChannel opens,
// messages flow browser to browser, encrypted by WebRTC's built-in DTLS.
// Text and control messages are JSON strings; file chunks are raw binary (ArrayBuffer).

// Backpressure limits for file chunks: pause sending when more than BUFFER_HIGH bytes are
// queued, resume once the queue drains below BUFFER_LOW.
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;

export function createPeer({ initiator, iceServers, sendSignal, onOpen, onMessage, onBinary, onClose }) {
  const pc = new RTCPeerConnection({ iceServers });
  const pendingCandidates = [];
  let channel = null;
  let closed = false;

  // Each ICE candidate is one possible network path to us; the peer tries them until one works.
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ candidate });
  };

  // 'disconnected' can recover on its own, so only give up on 'failed'.
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close();
  };

  function setupChannel(newChannel) {
    channel = newChannel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    channel.onopen = () => onOpen();
    channel.onclose = () => close();
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        onBinary(event.data);
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      onMessage(message);
    };
  }

  if (initiator) {
    // The initiator creates the channel and the offer; the other side receives both.
    setupChannel(pc.createDataChannel('chat'));
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => sendSignal({ description: pc.localDescription }))
      .catch(close);
  } else {
    pc.ondatachannel = (event) => setupChannel(event.channel);
  }

  async function handleSignal(data) {
    try {
      if (data?.description) {
        await pc.setRemoteDescription(data.description);
        // Candidates that arrived before the offer/answer can be applied now.
        for (const candidate of pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          sendSignal({ description: pc.localDescription });
        }
      } else if (data?.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else pendingCandidates.push(data.candidate);
      }
    } catch (error) {
      console.error('Signaling failed:', error);
      close();
    }
  }

  function send(message) {
    if (channel?.readyState !== 'open') return false;
    channel.send(JSON.stringify(message));
    return true;
  }

  // Sends one file chunk. If the channel's send queue is full, waits for it to drain
  // first, so a large video is streamed instead of piled into memory all at once.
  async function sendBinary(data) {
    if (channel?.readyState !== 'open') throw new Error('Channel closed');
    if (channel.bufferedAmount > BUFFER_HIGH) await waitForDrain();
    channel.send(data);
  }

  function waitForDrain() {
    return new Promise((resolve, reject) => {
      const drained = () => {
        channel.removeEventListener('close', closedEarly);
        resolve();
      };
      const closedEarly = () => {
        channel.removeEventListener('bufferedamountlow', drained);
        reject(new Error('Channel closed'));
      };
      channel.addEventListener('bufferedamountlow', drained, { once: true });
      channel.addEventListener('close', closedEarly, { once: true });
    });
  }

  // Safety number: a hash of both peers' DTLS certificate fingerprints (from the SDP).
  // A man-in-the-middle has to substitute its own certificates, so each user would
  // see a different number. Sorting makes both sides compute the same input.
  async function getSafetyNumber() {
    const mine = extractFingerprint(pc.localDescription?.sdp);
    const theirs = extractFingerprint(pc.remoteDescription?.sdp);
    if (!mine || !theirs || !crypto.subtle) return null;

    const input = new TextEncoder().encode([mine, theirs].sort().join('|'));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    const groups = [];
    for (let i = 0; i < 18; i += 3) {
      const value = (hash[i] << 16) | (hash[i + 1] << 8) | hash[i + 2];
      groups.push(String(value % 100000).padStart(5, '0'));
    }
    return groups.join(' ');
  }

  // Live details from WebRTC's own stats: which network path won (the "selected
  // candidate pair"), the round-trip time, and the DTLS encryption in use.
  async function getConnectionInfo() {
    const stats = await pc.getStats();
    let transport = null;
    let pair = null;
    stats.forEach((report) => {
      if (report.type === 'transport') transport = report;
    });
    if (transport?.selectedCandidatePairId) pair = stats.get(transport.selectedCandidatePairId);
    if (!pair) {
      // Firefox marks the chosen pair with `selected` instead of linking it from the transport.
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && (report.selected || (report.nominated && report.state === 'succeeded'))) pair = report;
      });
    }
    if (!pair) return null;
    return {
      localType: stats.get(pair.localCandidateId)?.candidateType,
      remoteType: stats.get(pair.remoteCandidateId)?.candidateType,
      rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      dtlsVersion: transport?.tlsVersion ?? null,
      cipher: transport?.dtlsCipher ?? null,
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    channel?.close();
    pc.close();
    onClose();
  }

  return { handleSignal, send, sendBinary, getSafetyNumber, getConnectionInfo, close };
}

function extractFingerprint(sdp) {
  const match = sdp?.match(/^a=fingerprint:(\S+ \S+)/m);
  return match ? match[1].toUpperCase() : null;
}
