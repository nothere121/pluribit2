
console.log('[P2P] Loading Pluribit WebTorrent P2P module...');

import WebTorrent from 'webtorrent';
import { Buffer } from 'buffer';
import crypto from 'crypto-browserify';

// Ensure Buffer is available globally for WebTorrent
if (typeof window !== 'undefined') {
    window.Buffer = Buffer;
}

class PluribitP2P {
    constructor() {
        console.log('[P2P] Constructor called');
        this.client = null;
        this.handlers = new Map();
        this.blockTorrents = new Map(); // height -> torrent
        this.masterIndexTorrent = null;
        this.peerId = null;
        this.knownBlocks = new Map(); // height -> magnetURI
        this.pendingBlocks = new Set();
        this.connectedWires = new Set(); // Track active wire connections
        this.messageQueue = []; // Queue messages until wire protocol is ready
        this.indexUpdateInterval = null;
        this.peerDiscoveryInterval = null;
    }

    async start() {
        console.log('[P2P] Starting WebTorrent-based P2P network...');
        
        try {
            // Create WebTorrent client with optimized settings
            this.client = new WebTorrent({
                dht: true,
                maxConns: 55,
                tracker: {
                    rtcConfig: {
                        iceServers: [
                            { urls: 'stun:stun.l.google.com:19302' },
                            { urls: 'stun:global.stun.twilio.com:3478' }
                        ]
                    },
                    announce: this.getTrackers()
                }
            });

            // Generate a unique peer ID
            this.peerId = this.client.peerId.toString('hex');
            console.log('[P2P] WebTorrent client started with peer ID:', this.peerId);

            // Set up error handling
            this.client.on('error', (err) => {
                console.error('[P2P] WebTorrent error:', err);
                this.handleError(err);
            });

            // Set up torrent handlers
            this.client.on('torrent', (torrent) => {
                console.log('[P2P] Torrent ready:', torrent.name || torrent.infoHash);
                this.setupTorrentHandlers(torrent);
            });

            // Join the master index torrent
            await this.joinMasterIndex();

            // Start periodic tasks
            this.startPeriodicTasks();

            return this.peerId;
        } catch (error) {
            console.error('[P2P] Failed to start WebTorrent client:', error);
            throw error;
        }
    }

    getTrackers() {
        return [
            'wss://tracker.btorrent.xyz',
            'wss://tracker.openwebtorrent.com',
            'wss://tracker.webtorrent.dev',
            'wss://tracker.files.fm:7073/announce'
        ];
    }

    async joinMasterIndex() {
        console.log('[P2P] Joining master index torrent...');
        
        // Well-known info hash for the master index
        const MASTER_INDEX_INFOHASH = this.sha1('pluribit-block-index-v1');
        const magnetURI = `magnet:?xt=urn:btih:${MASTER_INDEX_INFOHASH}&dn=pluribit-block-index-v1&tr=${this.getTrackers().map(t => encodeURIComponent(t)).join('&tr=')}`;
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                console.log('[P2P] Master index timeout - creating new index');
                this.seedEmptyIndex();
                resolve();
            }, 10000); // 10 second timeout

            this.masterIndexTorrent = this.client.add(magnetURI, {
                path: '/tmp/pluribit-index',
                destroyStoreOnDestroy: false
            }, (torrent) => {
                clearTimeout(timeout);
                console.log('[P2P] Connected to master index torrent');
                this.setupMasterIndexHandlers(torrent);
                resolve();
            });

            this.masterIndexTorrent.on('error', (err) => {
                clearTimeout(timeout);
                console.error('[P2P] Master index error:', err);
                this.seedEmptyIndex();
                resolve();
            });
        });
    }

    setupMasterIndexHandlers(torrent) {
        torrent.on('done', () => {
            console.log('[P2P] Master index download complete');
            this.loadBlockIndex();
        });

        torrent.on('download', (bytes) => {
            console.log('[P2P] Master index progress:', (torrent.progress * 100).toFixed(1) + '%');
        });

        torrent.on('wire', (wire, addr) => {
            console.log('[P2P] Master index peer connected:', addr || 'WebRTC');
            this.setupWireProtocol(wire);
        });

        // If we already have the file, load it
        if (torrent.done) {
            this.loadBlockIndex();
        }
    }

    seedEmptyIndex() {
        const emptyIndex = {
            version: 1,
            blocks: {},
            lastUpdate: Date.now(),
            genesisHash: 'pluribit-genesis-2025'
        };

        const indexBuffer = Buffer.from(JSON.stringify(emptyIndex, null, 2));
        const blob = new Blob([indexBuffer], { type: 'application/json' });
        
        // Create file for seeding
        const file = new File([blob], 'index.json', { 
            type: 'application/json',
            lastModified: Date.now()
        });
        
        // Seed with proper metadata
        this.masterIndexTorrent = this.client.seed(file, {
            name: 'pluribit-block-index-v1',
            announce: this.getTrackers(),
            private: false
        }, (torrent) => {
            console.log('[P2P] Seeding empty master index:', torrent.magnetURI);
            this.setupMasterIndexHandlers(torrent);
        });
    }

    loadBlockIndex() {
        if (!this.masterIndexTorrent || !this.masterIndexTorrent.files || !this.masterIndexTorrent.files[0]) {
            console.log('[P2P] No index file available yet');
            return;
        }

        this.masterIndexTorrent.files[0].getBuffer((err, buffer) => {
            if (err) {
                console.error('[P2P] Failed to read index:', err);
                return;
            }

            try {
                const index = JSON.parse(buffer.toString());
                console.log('[P2P] Loaded block index v' + index.version + ' with', Object.keys(index.blocks).length, 'blocks');
                
                // Update our known blocks
                Object.entries(index.blocks).forEach(([height, magnetURI]) => {
                    const heightNum = parseInt(height);
                    if (!this.knownBlocks.has(heightNum)) {
                        this.knownBlocks.set(heightNum, magnetURI);
                    }
                });

                // Notify about known blocks
                const handler = this.handlers.get('BLOCK_HEIGHTS_KNOWN');
                if (handler) {
                    const heights = Array.from(this.knownBlocks.keys()).sort((a, b) => a - b);
                    handler(heights);
                }

                // Start syncing missing blocks
                this.syncMissingBlocks();
            } catch (e) {
                console.error('[P2P] Failed to parse index:', e);
            }
        });
    }

    syncMissingBlocks() {
        // Download any missing blocks in parallel (max 5 at a time)
        const missingBlocks = [];
        this.knownBlocks.forEach((magnetURI, height) => {
            if (!this.blockTorrents.has(height) && !this.pendingBlocks.has(height)) {
                missingBlocks.push({ height, magnetURI });
            }
        });

        // Download in batches
        const BATCH_SIZE = 5;
        for (let i = 0; i < Math.min(BATCH_SIZE, missingBlocks.length); i++) {
            const { height, magnetURI } = missingBlocks[i];
            this.downloadBlock(height, magnetURI);
        }
    }

    setupTorrentHandlers(torrent) {
        torrent.on('wire', (wire, addr) => {
            console.log('[P2P] Peer connected:', addr || 'WebRTC peer');
            this.setupWireProtocol(wire);
        });

        torrent.on('error', (err) => {
            console.error('[P2P] Torrent error:', err);
        });
    }

    setupWireProtocol(wire) {
        // Implement custom wire protocol for real-time messages
        const self = this;
        
        // Extended handshake for custom protocol
        wire.use(function(wire) {
            const name = 'pluribit_protocol';
            
            // Store reference to P2P instance
            wire._p2p = self;
            
            wire.extendedHandshake.pluribit_protocol = {
                version: 1,
                peerId: self.peerId,
                knownBlocks: Array.from(self.knownBlocks.keys())
            };

            wire.on('extended', function(ext, buf) {
                if (ext === 'pluribit_protocol') {
                    try {
                        const message = JSON.parse(buf.toString());
                        self.handleWireMessage(message, wire);
                    } catch (e) {
                        console.error('[P2P] Failed to parse wire message:', e);
                    }
                }
            });

            // Send queued messages
            if (self.messageQueue.length > 0) {
                self.messageQueue.forEach(msg => {
                    self.sendWireMessage(wire, msg);
                });
                self.messageQueue = [];
            }

            // Track this wire
            self.connectedWires.add(wire);
            
            wire.on('close', () => {
                self.connectedWires.delete(wire);
            });

            // Send initial block announcements
            const announcements = {
                type: 'BLOCK_ANNOUNCEMENTS',
                blocks: Array.from(self.knownBlocks.entries())
            };
            self.sendWireMessage(wire, announcements);
        });
    }

    sendWireMessage(wire, message) {
        if (!wire.destroyed) {
            try {
                const buf = Buffer.from(JSON.stringify(message));
                wire.extended('pluribit_protocol', buf);
            } catch (e) {
                console.error('[P2P] Failed to send wire message:', e);
            }
        }
    }

    handleWireMessage(message, wire) {
        console.log('[P2P] Received wire message:', message.type);
        
        switch (message.type) {
            case 'NEW_BLOCK':
                if (!this.knownBlocks.has(message.height)) {
                    this.knownBlocks.set(message.height, message.magnetURI);
                    this.downloadBlock(message.height, message.magnetURI);
                }
                break;
                
            case 'BLOCK_REQUEST':
                message.heights.forEach(height => {
                    if (this.knownBlocks.has(height)) {
                        this.sendWireMessage(wire, {
                            type: 'NEW_BLOCK',
                            height: height,
                            magnetURI: this.knownBlocks.get(height)
                        });
                    }
                });
                break;
                
            case 'TRANSACTION':
                const txHandler = this.handlers.get('TRANSACTION');
                if (txHandler) txHandler(message);
                break;
                
            case 'BLOCK_ANNOUNCEMENTS':
                message.blocks.forEach(([height, magnetURI]) => {
                    if (!this.knownBlocks.has(height)) {
                        this.knownBlocks.set(height, magnetURI);
                        this.downloadBlock(height, magnetURI);
                    }
                });
                break;
                
            case 'CANDIDATE':
                const candidateHandler = this.handlers.get('CANDIDATE');
                if (candidateHandler) candidateHandler(message);
                break;
                
            case 'VOTE':
                const voteHandler = this.handlers.get('VOTE');
                if (voteHandler) voteHandler(message);
                break;
        }
    }

    async seedBlock(block) {
        console.log('[P2P] Seeding block', block.height);

        const blockData = Buffer.from(JSON.stringify(block));
        const blob = new Blob([blockData], { type: 'application/json' });
        const file = new File([blob], `block-${block.height}.json`, { 
            type: 'application/json',
            lastModified: Date.now()
        });
        
        return new Promise((resolve, reject) => {
            const torrent = this.client.seed(file, {
                name: `pluribit-block-${block.height}`,
                announce: this.getTrackers(),
                private: false
            }, (torrent) => {
                const magnetURI = torrent.magnetURI;
                console.log('[P2P] Block', block.height, 'seeding with magnet:', magnetURI);
                
                // Store in our maps
                this.blockTorrents.set(block.height, torrent);
                this.knownBlocks.set(block.height, magnetURI);
                
                // Update master index
                this.updateMasterIndex(block.height, magnetURI);
                
                // Announce to connected peers
                this.broadcastNewBlock(block.height, magnetURI);
                
                // Setup handlers
                this.setupTorrentHandlers(torrent);
                
                resolve(torrent);
            });

            torrent.on('error', (err) => {
                console.error('[P2P] Failed to seed block:', err);
                reject(err);
            });
        });
    }

    async downloadBlock(height, magnetURI) {
        if (this.blockTorrents.has(height) || this.pendingBlocks.has(height)) {
            return; // Already have or downloading
        }

        console.log('[P2P] Downloading block', height);
        this.pendingBlocks.add(height);

        const torrent = this.client.add(magnetURI, {
            path: '/tmp/pluribit-blocks',
            destroyStoreOnDestroy: false
        });

        torrent.on('ready', () => {
            console.log('[P2P] Started downloading block', height);
        });

        torrent.on('done', () => {
            console.log('[P2P] Block', height, 'download complete');
            
            torrent.files[0].getBuffer((err, buffer) => {
                if (err) {
                    console.error('[P2P] Failed to read block:', err);
                    this.pendingBlocks.delete(height);
                    return;
                }

                try {
                    const block = JSON.parse(buffer.toString());
                    this.blockTorrents.set(height, torrent);
                    this.pendingBlocks.delete(height);

                    // Notify handler
                    const handler = this.handlers.get('BLOCK_DOWNLOADED');
                    if (handler) {
                        handler({ block });
                    }

                    // Continue seeding
                    console.log('[P2P] Now seeding block', height);
                    
                    // Setup handlers for this torrent
                    this.setupTorrentHandlers(torrent);
                    
                    // Check for more blocks to download
                    this.syncMissingBlocks();
                } catch (e) {
                    console.error('[P2P] Failed to parse block:', e);
                    this.pendingBlocks.delete(height);
                }
            });
        });

        torrent.on('error', (err) => {
            console.error('[P2P] Block download error:', err);
            this.pendingBlocks.delete(height);
        });
    }

    broadcastNewBlock(height, magnetURI) {
        const message = {
            type: 'NEW_BLOCK',
            height: height,
            magnetURI: magnetURI,
            timestamp: Date.now()
        };

        // Send to all connected wires
        this.connectedWires.forEach(wire => {
            this.sendWireMessage(wire, message);
        });

        console.log('[P2P] Broadcast new block to', this.connectedWires.size, 'peers');
    }

    async broadcast(data) {
        const message = { ...data, timestamp: Date.now() };
        
        // If no wires connected yet, queue the message
        if (this.connectedWires.size === 0) {
            this.messageQueue.push(message);
            console.log('[P2P] No peers connected, queued message');
            return;
        }

        // Send to all connected wires
        let sentCount = 0;
        this.connectedWires.forEach(wire => {
            if (!wire.destroyed) {
                this.sendWireMessage(wire, message);
                sentCount++;
            }
        });

        console.log(`[P2P] Broadcast ${message.type} to ${sentCount} peers`);
    }

    updateMasterIndex(height, magnetURI) {
        if (!this.masterIndexTorrent || !this.masterIndexTorrent.files[0]) {
            console.log('[P2P] Master index not ready for update');
            return;
        }

        // Read current index
        this.masterIndexTorrent.files[0].getBuffer((err, buffer) => {
            if (err) {
                console.error('[P2P] Failed to read index for update:', err);
                return;
            }

            try {
                const index = JSON.parse(buffer.toString());
                index.blocks[height] = magnetURI;
                index.lastUpdate = Date.now();

                // Create updated file
                const updatedBuffer = Buffer.from(JSON.stringify(index, null, 2));
                const blob = new Blob([updatedBuffer], { type: 'application/json' });
                const file = new File([blob], 'index.json', { 
                    type: 'application/json',
                    lastModified: Date.now()
                });

                // Destroy old torrent
                this.masterIndexTorrent.destroy(() => {
                    // Re-seed with updated index
                    this.masterIndexTorrent = this.client.seed(file, {
                        name: 'pluribit-block-index-v1',
                        announce: this.getTrackers(),
                        private: false
                    }, (torrent) => {
                        console.log('[P2P] Master index updated with block', height);
                        this.setupMasterIndexHandlers(torrent);
                    });
                });
            } catch (e) {
                console.error('[P2P] Failed to update index:', e);
            }
        });
    }

    startPeriodicTasks() {
        // Periodic peer discovery
        this.peerDiscoveryInterval = setInterval(() => {
            const peerCount = this.getPeerCount();
            console.log('[P2P] Connected to', peerCount, 'unique peers');
            
            // Re-announce torrents if peer count is low
            if (peerCount < 3) {
                [this.masterIndexTorrent, ...this.blockTorrents.values()].forEach(torrent => {
                    if (torrent && !torrent.destroyed && typeof torrent.announce === 'function') {
                        torrent.announce();
                    }
                });
            }
        }, 30000); // Every 30 seconds

        // Periodic index save
        this.indexUpdateInterval = setInterval(() => {
            if (this.masterIndexTorrent && this.masterIndexTorrent.files[0]) {
                // Force a piece verification to ensure integrity
                this.masterIndexTorrent.verify();
            }
        }, 60000); // Every minute
    }

    onMessage(type, handler) {
        console.log('[P2P] Registering handler for:', type);
        this.handlers.set(type, handler);
    }

    getPeerCount() {
        const uniquePeers = new Set();
        
        // Collect all unique peer IDs
        const torrents = [this.masterIndexTorrent, ...this.blockTorrents.values()];
        torrents.forEach(torrent => {
            if (torrent && torrent.wires) {
                torrent.wires.forEach(wire => {
                    if (wire.peerId) {
                        uniquePeers.add(wire.peerId.toString('hex'));
                    }
                });
            }
        });

        return uniquePeers.size;
    }

    sha1(str) {
        return crypto.createHash('sha1').update(str).digest('hex');
    }

    handleError(err) {
        // Handle specific error types
        if (err.message && err.message.includes('Ice connection failed')) {
            console.log('[P2P] WebRTC connection failed, will retry via DHT');
        } else if (err.message && err.message.includes('Signaling server')) {
            console.log('[P2P] Tracker connection failed, continuing with DHT');
        }
    }

    async stop() {
        console.log('[P2P] Stopping P2P network...');
        
        // Clear intervals
        if (this.peerDiscoveryInterval) {
            clearInterval(this.peerDiscoveryInterval);
        }
        if (this.indexUpdateInterval) {
            clearInterval(this.indexUpdateInterval);
        }

        // Destroy all torrents
        if (this.client) {
            await new Promise((resolve) => {
                this.client.destroy((err) => {
                    if (err) {
                        console.error('[P2P] Error destroying client:', err);
                    }
                    console.log('[P2P] WebTorrent client stopped');
                    resolve();
                });
            });
        }
    }
    
    async seedUTXOSnapshot(snapshot) {
        console.log(`[P2P] Seeding UTXO snapshot at height ${snapshot.height}`);
        
        // Compress the snapshot data
        const snapshotData = JSON.stringify(snapshot);
        const compressed = pako.deflate(snapshotData);
        
        // Create deterministic filename
        const filename = `utxo-snapshot-${snapshot.height}.json.gz`;
        const file = new File([compressed], filename, {
            type: 'application/gzip',
            lastModified: Date.now()
        });
        
        // Seed with deterministic info hash
        const infoHashBase = `pluribit-utxo-snapshot-${snapshot.height}`;
        const infoHash = this.sha1(infoHashBase);
        
        return new Promise((resolve, reject) => {
            const torrent = this.client.seed(file, {
                name: `pluribit-utxo-${snapshot.height}`,
                infoHash: infoHash,
                announce: this.getTrackers(),
                private: false
            }, (torrent) => {
                console.log(`[P2P] UTXO snapshot seeding: ${torrent.magnetURI}`);
                
                // Update master index with snapshot info
                this.updateMasterIndexWithSnapshot(snapshot.height, torrent.magnetURI, {
                    merkle_root: Array.from(snapshot.merkle_root),
                    utxo_count: snapshot.utxos.length,
                    compressed_size: compressed.byteLength,
                    timestamp: snapshot.timestamp
                });
                
                this.setupTorrentHandlers(torrent);
                resolve(torrent.magnetURI);
            });
            
            torrent.on('error', (err) => {
                console.error('[P2P] Failed to seed UTXO snapshot:', err);
                reject(err);
            });
        });
    }

    async downloadUTXOSnapshot(height) {
        console.log(`[P2P] Downloading UTXO snapshot at height ${height}`);
        
        // Get snapshot info from master index
        const snapshotInfo = await this.getUTXOSnapshotInfo(height);
        if (!snapshotInfo) {
            throw new Error(`No UTXO snapshot found for height ${height}`);
        }
        
        return new Promise((resolve, reject) => {
            const torrent = this.client.add(snapshotInfo.magnetURI, {
                path: '/tmp/pluribit-snapshots',
                destroyStoreOnDestroy: false
            });
            
            torrent.on('ready', () => {
                console.log(`[P2P] Started downloading UTXO snapshot ${height}`);
            });
            
            torrent.on('done', () => {
                console.log(`[P2P] UTXO snapshot ${height} download complete`);
                
                torrent.files[0].getBuffer((err, buffer) => {
                    if (err) {
                        console.error('[P2P] Failed to read snapshot:', err);
                        reject(err);
                        return;
                    }
                    
                    try {
                        // Decompress
                        const decompressed = pako.inflate(buffer, { to: 'string' });
                        const snapshot = JSON.parse(decompressed);
                        
                        // Verify merkle root matches
                        const expectedRoot = new Uint8Array(snapshotInfo.merkle_root);
                        const actualRoot = new Uint8Array(snapshot.merkle_root);
                        
                        if (!this.arraysEqual(expectedRoot, actualRoot)) {
                            throw new Error('UTXO snapshot merkle root mismatch');
                        }
                        
                        console.log(`[P2P] UTXO snapshot verified: ${snapshot.utxos.length} UTXOs`);
                        resolve(snapshot);
                    } catch (e) {
                        console.error('[P2P] Failed to parse snapshot:', e);
                        reject(e);
                    }
                });
            });
            
            torrent.on('error', (err) => {
                console.error('[P2P] Snapshot download error:', err);
                reject(err);
            });
        });
    }

    async updateMasterIndexWithSnapshot(height, magnetURI, metadata) {
        if (!this.masterIndexTorrent || !this.masterIndexTorrent.files[0]) {
            console.log('[P2P] Master index not ready for snapshot update');
            return;
        }
        
        this.masterIndexTorrent.files[0].getBuffer((err, buffer) => {
            if (err) {
                console.error('[P2P] Failed to read index for snapshot update:', err);
                return;
            }
            
            try {
                const index = JSON.parse(buffer.toString());
                
                // Initialize snapshots object if needed
                if (!index.utxo_snapshots) {
                    index.utxo_snapshots = {};
                }
                
                // Add snapshot info
                index.utxo_snapshots[height] = {
                    magnet: magnetURI,
                    merkle_root: metadata.merkle_root,
                    utxo_count: metadata.utxo_count,
                    compressed_size: metadata.compressed_size,
                    timestamp: metadata.timestamp
                };
                
                // Update latest snapshot height
                index.latest_snapshot = Math.max(
                    index.latest_snapshot || 0,
                    height
                );
                
                index.lastUpdate = Date.now();
                
                // Create updated file
                const updatedBuffer = Buffer.from(JSON.stringify(index, null, 2));
                const blob = new Blob([updatedBuffer], { type: 'application/json' });
                const file = new File([blob], 'index.json', {
                    type: 'application/json',
                    lastModified: Date.now()
                });
                
                // Destroy old torrent and re-seed
                this.masterIndexTorrent.destroy(() => {
                    this.masterIndexTorrent = this.client.seed(file, {
                        name: 'pluribit-block-index-v1',
                        announce: this.getTrackers(),
                        private: false
                    }, (torrent) => {
                        console.log('[P2P] Master index updated with UTXO snapshot', height);
                        this.setupMasterIndexHandlers(torrent);
                    });
                });
            } catch (e) {
                console.error('[P2P] Failed to update index with snapshot:', e);
            }
        });
    }

    async getUTXOSnapshotInfo(height) {
        if (!this.masterIndexTorrent || !this.masterIndexTorrent.files[0]) {
            return null;
        }
        
        return new Promise((resolve) => {
            this.masterIndexTorrent.files[0].getBuffer((err, buffer) => {
                if (err) {
                    console.error('[P2P] Failed to read index:', err);
                    resolve(null);
                    return;
                }
                
                try {
                    const index = JSON.parse(buffer.toString());
                    const snapshotInfo = index.utxo_snapshots?.[height];
                    
                    if (snapshotInfo) {
                        resolve({
                            magnetURI: snapshotInfo.magnet,
                            ...snapshotInfo
                        });
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    console.error('[P2P] Failed to parse index:', e);
                    resolve(null);
                }
            });
        });
    }

    async getLatestSnapshotHeight() {
        if (!this.masterIndexTorrent || !this.masterIndexTorrent.files[0]) {
            return 0;
        }
        
        return new Promise((resolve) => {
            this.masterIndexTorrent.files[0].getBuffer((err, buffer) => {
                if (err) {
                    resolve(0);
                    return;
                }
                
                try {
                    const index = JSON.parse(buffer.toString());
                    resolve(index.latest_snapshot || 0);
                } catch (e) {
                    resolve(0);
                }
            });
        });
    }

    arraysEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
    
    
}

// Export the class as default
export default PluribitP2P;
