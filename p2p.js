import WebTorrent from 'webtorrent';
import { Buffer } from 'buffer';
const EXTENSION_NAME = 'pluribit_protocol_v2'; 
class PluribitP2P {
    constructor(logger) {
        this.log = logger;
        this.client = null;
        this.handlers = new Map();
        this.blockTorrents = new Map();
        this.peerId = null;
        this.knownBlocks = new Map();
        this.knownSnapshots = new Map();
        this.pendingBlocks = new Set();
        this.connectedWires = new Set();
    }

    getTrackers() {
        return [
            'wss://tracker.btorrent.xyz',
            'wss://tracker.openwebtorrent.com',
            'wss://tracker.webtorrent.dev',
            'wss://tracker.files.fm:7073/announce'
        ];
    }

    async start() {
        this.log('Starting WebTorrent-based P2P network...', 'info');
        try {
            this.client = new WebTorrent({
                dht: true,
                tracker: {
                    announce: this.getTrackers()
                }
            });

            this.peerId = this.client.peerId.toString('hex');
            this.log(`WebTorrent client started with peer ID: ${this.peerId}`, 'success');

            this.client.on('error', (err) => this.handleError(err));
            this.client.on('torrent', (torrent) => this.setupTorrentHandlers(torrent));

            this._startChannelSeeding();
            // We can now re-enable the periodic task, as the mutex in worker.js will prevent conflicts.
            this.startPeriodicTasks();

            return this.peerId;

        } catch (error) {
            this.log(`Failed to start WebTorrent client: ${error}`, 'error');
            throw error;
        }
    }
    
    // FIX: Added a stop method to clean up resources.
    stop() {
        this.log('Stopping P2P network...', 'info');
        if (this.peerDiscoveryInterval) {
            clearInterval(this.peerDiscoveryInterval);
            this.peerDiscoveryInterval = null;
        }
        if (this.client) {
            return new Promise((resolve, reject) => {
                this.client.destroy((err) => {
                    if (err) {
                        this.log(`Error destroying WebTorrent client: ${err}`, 'error');
                        return reject(err);
                    }
                    this.log('WebTorrent client destroyed.', 'success');
                    this.client = null;
                    resolve();
                });
            });
        }
        return Promise.resolve();
    }

    _startChannelSeeding() {
        this.log('Starting peer discovery via channel torrents...', 'info');
        const CHANNEL_COUNT = 5;
        const trackers = this.getTrackers();

        for (let i = 0; i < CHANNEL_COUNT; i++) {
            const channelName = `pluribit-channel-v1-${i}`;
            const channelBuffer = Buffer.from(`pluribit-p2p-discovery-channel-${i}`);

            this.client.seed(channelBuffer, { name: channelName, announce: trackers }, (torrent) => {
                this.log(`Seeding discovery channel #${i}. Infohash: ${torrent.infoHash}`, 'info');
            });
        }
    }

    setupTorrentHandlers(torrent) {
        torrent.on('wire', (wire) => this.setupWireProtocol(wire));
        torrent.on('error', (err) => this.log(`Torrent error (${torrent.name}): ${err}`, 'error'));
    }

    // --- THIS IS THE CORRECTED HANDSHAKE LOGIC ---
    setupWireProtocol(wire) {
        if (this.connectedWires.has(wire.peerId)) return;
        this.connectedWires.add(wire.peerId);
        wire.on('close', () => {
            this.connectedWires.delete(wire.peerId);
        });

        const self = this;

        // 1. Define the extension as a constructor function.
        function PluribitExtension() {}

        // 2. The extension name MUST be on the prototype.
        PluribitExtension.prototype.name = EXTENSION_NAME;

        // 3. Implement `onExtendedHandshake`. This is called ONLY AFTER the peer confirms it supports our extension.
        PluribitExtension.prototype.onExtendedHandshake = function(handshake) {
            self.log(`Handshake complete with peer: ${wire.peerId.substring(0, 12)}...`, 'info');
            
            // Now it is safe to send our initial sync message.
            const syncMessage = {
                type: 'INDEX_SYNC',
                knownBlocks: Object.fromEntries(self.knownBlocks),
                knownSnapshots: Object.fromEntries(self.knownSnapshots)
            };
            self.sendWireMessage(wire, syncMessage, EXTENSION_NAME);
        };

        // 4. Implement `onMessage` to handle incoming data for this extension.
        PluribitExtension.prototype.onMessage = function(buffer) {
            try {
                const message = JSON.parse(buffer.toString());
                self.handleWireMessage(message, wire);
            } catch (e) {
                self.log(`Failed to parse incoming wire message: ${e}`, 'error');
            }
        };

        // 5. Register our extension class on the wire.
        wire.use(PluribitExtension);
    }

    sendWireMessage(wire, message, extensionName = 'pluribit_protocol_v2') {
        if (wire.destroyed) return;
        try {
            // The first argument to wire.extended is the extension name.
            wire.extended(extensionName, Buffer.from(JSON.stringify(message)));
        } catch (e) {
            this.log(`Failed to serialize and send wire message: ${e}`, 'error');
        }
    }

    handleWireMessage(message) {
        const handler = this.handlers.get(message.type);
        if (handler) {
            handler(message);
        } else {
            // It's normal to receive messages you don't handle, like INDEX_SYNC from others.
            // Only log a warning for truly unknown types.
            if (message.type !== 'INDEX_SYNC') {
                this.log(`No handler for message type: ${message.type}`, 'warn');
            }
        }
    }

    async seedBlock(block) {
        const blockData = Buffer.from(JSON.stringify(block));
        const torrentName = `pluribit-block-${block.height}`;

        return new Promise((resolve) => {
            this.client.seed(blockData, { name: torrentName, announce: this.getTrackers() }, (torrent) => {
                this.blockTorrents.set(block.height, torrent);
                this.knownBlocks.set(block.height, torrent.magnetURI);
                this.broadcast({ type: 'BLOCK_ANNOUNCEMENT', height: block.height, magnetURI: torrent.magnetURI });
                this.log(`Seeding new block #${block.height}`, 'success');
                resolve(torrent);
            });
        });
    }

    async downloadBlock(height, magnetURI) {
        if (this.blockTorrents.has(height) || this.pendingBlocks.has(height)) return;
        this.log(`Downloading block #${height}...`, 'info');
        this.pendingBlocks.add(height);

        this.client.add(magnetURI, (torrent) => {
            torrent.on('done', () => {
                this.pendingBlocks.delete(height);
                const file = torrent.files[0];
                file.getBuffer((err, buffer) => {
                    if (err) return this.log(`Failed to read downloaded block: ${err}`, 'error');
                    try {
                        const block = JSON.parse(buffer.toString());
                        this.blockTorrents.set(height, torrent);
                        const handler = this.handlers.get('BLOCK_DOWNLOADED');
                        if (handler) handler({ block });
                    } catch (e) {
                        this.log(`Failed to parse downloaded block: ${e}`, 'error');
                    }
                });
            });
            torrent.on('error', (err) => {
                this.log(`Error downloading block #${height}: ${err}`, 'error');
                this.pendingBlocks.delete(height);
            });
        });
    }

    async broadcast(data) {
        const message = { ...data, timestamp: Date.now() };
        if (this.client.torrents.length === 0) return;
        this.client.torrents.forEach(torrent => {
            torrent.wires.forEach(wire => {
                // Check if the wire supports our extension before sending
                if (wire.peerExtensions[EXTENSION_NAME]) {
                    this.sendWireMessage(wire, message, EXTENSION_NAME);
                }
            });
        });
    }

    startPeriodicTasks() {
        this.peerDiscoveryInterval = setInterval(async () => {
            // Use the mutex from worker.js to prevent conflicts
            await acquireLock();
            try {
                const peerCount = this.getPeerCount();
                this.log(`Connected to ${peerCount} unique peers`, 'info');
            } finally {
                releaseLock();
            }
        }, 30000);
    }

    onMessage(type, handler) {
        this.handlers.set(type, handler);
    }

    getPeerCount() {
        const uniquePeers = new Set();
        this.client.torrents.forEach(t => t.wires.forEach(w => uniquePeers.add(w.peerId)));
        return uniquePeers.size;
    }

    handleError(err) {
        const msg = typeof err === 'string' ? err : err.message;
        if (msg.includes('ice') || msg.includes('tracker')) {
            this.log(`A non-critical WebRTC/tracker connection issue occurred: ${msg}`, 'warn');
        } else {
            this.log(`A critical WebTorrent error occurred: ${err}`, 'error');
        }
    }
}

// These functions need to be passed from worker.js to be used here.
// This is a placeholder; the actual implementation is in worker.js.
let acquireLock = async () => {};
let releaseLock = () => {};

export function setLockFunctions(acq, rel) {
    acquireLock = acq;
    releaseLock = rel;
}

export default PluribitP2P;
