import WebTorrent from 'webtorrent';
import { messageBus } from './message-bus.js';
import { normalizePeerId } from '../utils.js';
import { CONFIG } from '../config.js';

// --- STATE ---
let client = null;
let connectedPeers = new Map(); // idKey -> peerData
let dhtInstance = null;
let hyparviewInstance = null;

// --- CONSTANTS ---
const BOOTSTRAP_TORRENT_NAME = 'pluribit-bootstrap-v1';
const TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.btorrent.xyz',
];

/**
 * Initializes the P2P network stack.
 * @param {KademliaDHT} dht - The DHT instance for routing.
 * @param {HyParView} hyparview - The HyParView instance for peer management.
 */
export function initP2P(dht, hyparview) {
    if (client) {
        console.warn('[P2P] Network manager already initialized.');
        return;
    }

    dhtInstance = dht;
    hyparviewInstance = hyparview;

    try {
        client = new WebTorrent({
            dht: true, // Enable DHT for peer discovery
            tracker: {
                announce: TRACKERS,
                // wrtc is required for WebRTC in Node.js
                // webtorrent-hybrid handles this automatically.
            },
        });

        client.on('error', (err) => {
            console.error('[P2P] WebTorrent client error:', err.message);
        });

        client.on('warning', (warn) => {
            console.warn('[P2P] WebTorrent client warning:', warn.message);
        });

        // Use a bootstrap torrent to find initial peers.
        // The infoHash of this torrent acts as a meeting point.
        const bootstrapBuffer = Buffer.from(BOOTSTRAP_TORRENT_NAME);
        client.seed(bootstrapBuffer, { name: BOOTSTRAP_TORRENT_NAME }, (torrent) => {
            console.log(`[P2P] Seeding bootstrap torrent. InfoHash: ${torrent.infoHash}`);
            torrent.on('wire', handleWire);
        });

        // Set up the message bus to use our send function
        messageBus.setSendPeer(sendPeer);

    } catch (e) {
        console.error('[P2P] Failed to create WebTorrent client:', e);
        throw e;
    }
}

/**
 * Handles a new peer connection (wire).
 * @param {import('webtorrent').Wire} wire - The peer connection wire.
 */
function handleWire(wire) {
    const idKey = normalizePeerId(wire.peerId);
    if (!idKey || connectedPeers.has(idKey)) {
        return; // Ignore invalid or duplicate connections
    }

    console.log(`[P2P] New peer connected: ${idKey.substring(0, 12)}...`);

    const peerData = {
        wire,
        idKey,
        id: wire.peerIdBuffer, // Store the original buffer ID
        connectedAt: Date.now(),
    };

    connectedPeers.set(idKey, peerData);

    // Integrate with other P2P modules
    if (dhtInstance) {
        dhtInstance.addPeer(peerData.id, { wire });
    }
    if (hyparviewInstance && hyparviewInstance.activeView.size < hyparviewInstance.activeViewSize) {
        hyparviewInstance.addToActiveView(peerData.id, { wire, isOutgoing: false });
    }

    // Attach our custom message passing extension
    attachEphemeralExtension(wire);

    wire.on('close', () => {
        console.log(`[P2P] Peer disconnected: ${idKey.substring(0, 12)}...`);
        connectedPeers.delete(idKey);
        if (dhtInstance) dhtInstance.removePeer(peerData.id);
        if (hyparviewInstance) hyparviewInstance.handlePeerFailure(peerData.id);
    });

    wire.on('error', (err) => {
        console.error(`[P2P] Wire error for peer ${idKey.substring(0, 12)}...:`, err.message);
    });
}

/**
 * Attaches the custom protocol extension for message passing.
 * @param {import('webtorrent').Wire} wire - The peer connection wire.
 */
function attachEphemeralExtension(wire) {
    function EphemeralExtension() {
        this._ready = false;
    }
    EphemeralExtension.prototype.name = 'ephemeral_msg';

    EphemeralExtension.prototype.onExtendedHandshake = function (handshake) {
        if (!handshake.m || typeof handshake.m[this.name] === 'undefined') {
            return wire.destroy('Peer does not support ephemeral_msg extension');
        }
        this._ready = true;
        
        // If there are queued messages, send them now
        if (wire._pendingMessages && wire._pendingMessages.length > 0) {
            wire._pendingMessages.forEach(msg => sendPeer(wire, msg));
            wire._pendingMessages = [];
        }
    };

    EphemeralExtension.prototype.onMessage = function (buf) {
        try {
            const msg = JSON.parse(new TextDecoder().decode(buf));
            // Dispatch the message to the central handler
            messageBus.handleMessage(msg.type, msg, wire);
        } catch (e) {
            console.error('[P2P] Received invalid peer message:', e.message);
        }
    };

    wire.use(EphemeralExtension);
}

/**
 * Sends a message to a specific peer.
 * @param {import('webtorrent').Wire} wire - The target peer's wire.
 * @param {object} msg - The message object to send.
 */
export function sendPeer(wire, msg) {
    if (!wire || wire.destroyed) return;

    try {
        const msgStr = JSON.stringify(msg);
        if (msgStr.length > CONFIG.MAX_MESSAGE_SIZE) {
            console.warn(`[P2P] Message too large to send (${msgStr.length} bytes), dropping.`);
            return;
        }
        const data = Buffer.from(msgStr);

        // Check if the extension is ready
        if (wire.ephemeral_msg && wire.ephemeral_msg._ready) {
            wire.extended('ephemeral_msg', data);
        } else {
            // Queue the message if the handshake isn't complete yet
            if (!wire._pendingMessages) wire._pendingMessages = [];
            wire._pendingMessages.push(msg);
        }
    } catch (e) {
        console.error('[P2P] Failed to send message:', e.message);
    }
}

/**
 * Broadcasts a message to all active peers in the HyParView overlay.
 * @param {object} message - The message object to broadcast.
 * @param {import('webtorrent').Wire} [excludePeerWire=null] - A wire to exclude from the broadcast.
 */
export function broadcast(message, excludePeerWire = null) {
    if (!hyparviewInstance) {
        console.warn('[P2P] HyParView not initialized, cannot broadcast.');
        return;
    }

    const activePeers = hyparviewInstance.getActivePeers();
    if (activePeers.length === 0) {
        console.warn('[P2P] No active peers to broadcast to.');
        return;
    }

    for (const peer of activePeers) {
        if (peer.wire && !peer.wire.destroyed && peer.wire !== excludePeerWire) {
            sendPeer(peer.wire, message);
        }
    }
}

/**
 * Stops the P2P client and cleans up connections.
 */
export function stopP2P() {
    return new Promise((resolve) => {
        if (client) {
            client.destroy(err => {
                if (err) console.error('[P2P] Error destroying client:', err);
                else console.log('[P2P] WebTorrent client destroyed.');
                client = null;
                connectedPeers.clear();
                resolve();
            });
        } else {
            resolve();
        }
    });
}
