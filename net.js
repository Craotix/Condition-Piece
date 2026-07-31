// ===================== NET.JS =====================
//
// Manual copy-paste WebRTC signaling — no signaling server required.
// One player is the "host", the other "joins" using a code the host gives them.
//
// FLOW:
//   HOST:  const offerCode = await Net.connect.host()
//          → send offerCode to the other player (text, Discord, whatever)
//          → they send back a "join code"
//          await Net.connect.acceptAnswer(joinCode)
//
//   JOIN:  const joinCode = await Net.connect.join(offerCode)
//          → send joinCode back to the host
//          → connection completes automatically once the host accepts it
//
// Once connected, both sides get a 'connected' event and can call
// Net.send(type, data) to talk to each other. Every message arrives on
// both sides (including the sender's own UI, if it listens) via the
// 'message' event as { type, data }.
//
// This module knows nothing about game rules — it's a thin transport +
// pub/sub layer. game.js decides what the messages mean and is the only
// place that should call Net.send / Net.on for gameplay events.

const Net = (() => {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // TURN relay fallback — STUN alone can't get through some NAT types
    // (symmetric NAT, some mobile carrier / corporate networks), where a
    // connection can appear to succeed and then close shortly after. TURN
    // relays traffic through a third-party server as a last resort so the
    // connection survives even when a direct P2P path isn't possible.
    // This is a free public server — fine for testing with friends, but
    // consider a paid/self-hosted TURN server (see net.js comments) if you
    // scale this up or it proves unreliable.
    { urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' },
  ];

  // Manual signaling can't trickle ICE candidates in after the fact — the
  // whole point is a single copy-pasted blob — so we wait for candidate
  // gathering to finish before producing the code the user copies. Some
  // networks never report "complete" cleanly, so we cap the wait and use
  // whatever candidates showed up in time.
  const ICE_GATHER_TIMEOUT_MS = 8000;

  let pc = null;
  let channel = null;
  let role = null; // 'host' | 'join'
  const listeners = {}; // eventName -> [handlers]

  function emit(event, payload) {
    (listeners[event] || []).forEach(fn => {
      try { fn(payload); } catch (err) { console.error(`Net: listener for "${event}" threw`, err); }
    });
  }

  function on(event, handler) {
    (listeners[event] = listeners[event] || []).push(handler);
  }

  function off(event, handler) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(fn => fn !== handler);
  }

  // SDPs are plain ASCII, so a base64 wrapper around the JSON is enough to
  // make the code safely copy-pasteable (no line breaks, no quote issues).
  function encode(obj) {
    return btoa(encodeURIComponent(JSON.stringify(obj)));
  }

  function decode(code) {
    return JSON.parse(decodeURIComponent(atob(code.trim())));
  }

  function waitForIceGatheringComplete(peerConnection) {
    if (peerConnection.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        peerConnection.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (peerConnection.iceGatheringState === 'complete') finish();
      };
      peerConnection.addEventListener('icegatheringstatechange', check);
      setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    });
  }

  function createPeerConnection() {
    const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnection.addEventListener('connectionstatechange', () => {
      const s = peerConnection.connectionState;
      if (s === 'disconnected' || s === 'failed' || s === 'closed') {
        emit('disconnected', { reason: s });
      }
    });
    return peerConnection;
  }

  function wireChannel(dataChannel) {
    channel = dataChannel;
    channel.addEventListener('open', () => emit('connected', { role }));
    channel.addEventListener('close', () => emit('disconnected', { reason: 'channel-closed' }));
    channel.addEventListener('error', (e) => emit('disconnected', { reason: 'channel-error', error: e }));
    channel.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        console.error('Net: received malformed message', e.data);
        return;
      }
      emit('message', msg);
    });
  }

  // ---------- HOST ----------

  async function hostCreateOffer() {
    reset();
    role = 'host';
    pc = createPeerConnection();
    // Host opens the data channel; the join side receives it via 'datachannel'.
    wireChannel(pc.createDataChannel('game'));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    return encode({ sdp: pc.localDescription });
  }

  async function hostAcceptAnswer(answerCode) {
    if (!pc || role !== 'host') throw new Error('Net: call connect.host() before connect.acceptAnswer()');
    const { sdp } = decode(answerCode);
    await pc.setRemoteDescription(sdp);
    // 'connected' fires once the data channel actually opens — no need to await here.
  }

  // ---------- JOIN ----------

  async function joinWithOffer(offerCode) {
    reset();
    role = 'join';
    pc = createPeerConnection();
    pc.addEventListener('datachannel', (e) => wireChannel(e.channel));

    const { sdp } = decode(offerCode);
    await pc.setRemoteDescription(sdp);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    return encode({ sdp: pc.localDescription });
  }

  // ---------- SEND / STATE ----------

  function send(type, data) {
    if (!channel || channel.readyState !== 'open') {
      console.warn(`Net.send('${type}') dropped — channel not open`);
      return false;
    }
    channel.send(JSON.stringify({ type, data }));
    return true;
  }

  function isConnected() {
    return !!channel && channel.readyState === 'open';
  }

  function getRole() {
    return role;
  }

  function reset() {
    if (channel) { try { channel.close(); } catch (_) {} }
    if (pc) { try { pc.close(); } catch (_) {} }
    channel = null;
    pc = null;
    role = null;
  }

  return {
    connect: {
      host: hostCreateOffer,
      acceptAnswer: hostAcceptAnswer,
      join: joinWithOffer,
    },
    send,
    on,
    off,
    isConnected,
    getRole,
    reset,
  };
})();
