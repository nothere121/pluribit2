import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { webRTC } from '@libp2p/webrtc';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { mdns } from '@libp2p/mdns' 
import { dcutr } from '@libp2p/dcutr';
import { multiaddr } from '@multiformats/multiaddr';
import { CONFIG } from './config.js';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import { pipe } from 'it-pipe';

import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping'; 
import { createEd25519PeerId, createFromPubKey } from '@libp2p/peer-id-factory';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import bridge from './js_bridge.cjs';
const { JSONStringifyWithBigInt, JSONParseWithBigInt } = bridge;

import crypto from 'crypto';
import nacl from 'tweetnacl';
import fs from 'fs/promises';
import path from 'path';

// ---- Signing helpers (stable stringify + sha256) ----
function stableStringify(obj) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return null;
      seen.add(v);
      if (Array.isArray(v)) return v.map(walk);
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}
function sha256Hex(inputUtf8) {
  return crypto.createHash('sha256').update(inputUtf8, 'utf8').digest('hex');
}

// Network scoping to prevent cross-talk between networks
const NET = process.env.PLURIBIT_NET || 'mainnet';


// Topic definitions
export const TOPICS = {
  BLOCKS: `/pluribit/${NET}/blocks/1.0.0`,
  TRANSACTIONS: `/pluribit/${NET}/transactions/1.0.0`,
  BLOCK_REQUEST: `/pluribit/${NET}/block-request/1.0.0`,
  SYNC: `/pluribit/${NET}/sync/1.0.0`,   
  GET_HASHES_REQUEST: `/pluribit/${NET}/get-hashes-request/1.0.0`,
  HASHES_RESPONSE: `/pluribit/${NET}/hashes-response/1.0.0`,
  BLOCK_ANNOUNCEMENTS: `/pluribit/${NET}/block-announcements/1.0.0`,
};
const MESSAGE_SCHEMAS = {
    [TOPICS.BLOCKS]: {
        // This topic now supports multiple message types for chunking
        required: ['type'],
        types: { type: 'string', payload: 'object' } // Payload validation happens per-type
    },
    [TOPICS.TRANSACTIONS]: {
        required: ['type', 'payload'],
        types: { type: 'string', payload: 'object' }
    },
    [TOPICS.SYNC]: {
        required: ['type']
    },
    [TOPICS.BLOCK_REQUEST]: {
        required: ['hash'],
        types: { hash: 'string' }
    },
    [TOPICS.BLOCK_ANNOUNCEMENTS]: {
        required: ['type', 'payload'],
        types: { type: 'string', payload: 'object' }
    },
    [TOPICS.GET_HASHES_REQUEST]: {
        required: ['start_height', 'request_id'],
        types: { start_height: 'number', request_id: 'string' }
    },
    [TOPICS.HASHES_RESPONSE]: {
        required: ['hashes', 'request_id', 'final_chunk'], 
        types: { 
            hashes: 'object', 
            request_id: 'string',
            final_chunk: 'boolean' 
        }
     }
 };
export class PluribitP2P {
    constructor(log, options = {}) {
        this._peerVerificationState = new Map(); // peerId -> { powSolved: bool, isSubscribed: bool }
        this.log = log;
        this.node = null;
        this.handlers = new Map();
        this.isBootstrap = options.isBootstrap || false;
        this._peerChallenges = new Map(); // peer -> {challenge, timestamp, attempts}
        this._maxChallengeAttempts = 3;
        this._challengeDifficulty = '000'; // Require 3 leading zeros in PoW (i.e. 1 in 16^5, or 1 in 1,048,576 hashes)
        // Periodic cleanup of stale challenges to prevent memory leak
        this._challengeGcTimer = setInterval(() => {
            const now = Date.now();
            for (const [peerId, challenge] of this._peerChallenges) {
                if (now - challenge.timestamp > 120000) { // 2 minutes
                    this._peerChallenges.delete(peerId);
                }
            }
        }, 60000); // Run every minute
        this.config = {
          listen: {
            tcp: options.tcpPort || 26658,
            ws: options.wsPort || 26659
          },
          bootstrap: this.isBootstrap ? [] : [
            // Public IPFS/libp2p bootstrappers (DNSADDR -> stable peer IDs)
            '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
            '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
            '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
            '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
            '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ'
          ]
        };
    }
    
_updateVerificationState(peerId, { powSolved, isSubscribed }) {
    const state = this._peerVerificationState.get(peerId) || { 
        powSolved: false, 
        isSubscribed: false,
        firstSeen: Date.now()
    };
    const wasVerified = state.powSolved && state.isSubscribed;

    if (powSolved !== undefined) state.powSolved = powSolved;
    if (isSubscribed !== undefined) state.isSubscribed = isSubscribed;

    const isNowVerified = state.powSolved && state.isSubscribed;
    
    
    this._peerVerificationState.set(peerId, state);

    if (isNowVerified && !wasVerified) {
        this.log(`[P2P] ✅ Fully Verified Peer: ${peerId}`, 'success');
    }
    
    // Return true if verified 
    return isNowVerified ;
}


// Add this new method to the PluribitP2P class
async sendDirectChallenge(peerId) {
    try {
        const challenge = crypto.randomBytes(32).toString('hex');
        
        // Store challenge for verification
        this._peerChallenges.set(peerId, {
            challenge,
            timestamp: Date.now(),
            attempts: 0
        });
        
        // Open a stream to the peer
        const connection = this.node.getConnections(peerId)[0];
        if (!connection) {
            throw new Error('No connection to peer');
        }
        
        const stream = await connection.newStream('/pluribit/challenge/1.0.0');
        
        const message = JSON.stringify({
            type: 'CHALLENGE',
            challenge,
            from: this.node.peerId.toString()
        });
        
        await pipe(
            [new TextEncoder().encode(message)],
            stream.sink
        );
        
        // Listen for response
        const chunks = [];
        for await (const chunk of stream.source) {
            // Convert to a standard Uint8Array to prevent type errors
            chunks.push(chunk.subarray());
        }
        const response = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
        
        if (response.type === 'CHALLENGE_RESPONSE') {
            // Verify the solution
            const verify = crypto.createHash('sha256')
                .update(challenge)
                .update(response.nonce)
                .digest('hex');
            
            if (verify === response.solution && response.solution.startsWith(this._challengeDifficulty)) {
                this._updateVerificationState(peerId, { powSolved: true });
                this._peerChallenges.delete(peerId);
                this.log(`[P2P] ✓ Peer ${peerId} solved challenge`, 'success');
                return true;
            }
        }
        
        return false;
    } catch (e) {
        const msg = e?.message || '';
        // Treat both "protocol selection failed" and "No connection" as expected, non-critical events
        const isExpected = /protocol selection failed|No connection to peer/i.test(msg);
        const logLevel = isExpected ? 'debug' : 'error';
        this.log(`[P2P] Failed to send challenge to ${peerId}: ${msg}`, logLevel);
        return false;
    }
} // <-- close sendDirectChallenge method


async _addToAddressBookCompat(id, multiaddrs) {
  const ps = this.node.peerStore;
  if (!ps || !multiaddrs?.length) return;

  try {
    if (ps.addressBook?.add) {
      return await ps.addressBook.add(id, multiaddrs);
    }
    if (ps.addressBook?.set) {
      return await ps.addressBook.set(id, multiaddrs);
    }
    if (ps.merge) {
      return await ps.merge(id, { multiaddrs });
    }
    if (ps.patch) {
      return await ps.patch(id, { multiaddrs });
    }
    this.log('[P2P] No compatible addressBook API found', 'debug');
  } catch (e) {
    const isAbort = e?.name === 'AbortError' || /aborted/i.test(e?.message || '');
    this.log(`[P2P] address book update ${isAbort ? 'aborted' : 'failed'} for ${id.toString()}: ${e?.message || e}`, isAbort ? 'debug' : 'warn');
  }
}


  // Simple per-peer token bucket
  _buckets = new Map();
  _dhtSeen = new Map();  // nsKey -> last accepted timestamp
  _bucketGcTimer = null;
  _allowMessage(from) {
    const now = Date.now();
    const windowMs = CONFIG.RATE_LIMIT_WINDOW;
    const cap = CONFIG.RATE_LIMIT_MESSAGES;

    let b = this._buckets.get(from);
    if (!b) {
      b = { tokens: cap, windowStart: now };
      this._buckets.set(from, b);
    }

    // refill per window
    if (now - b.windowStart >= windowMs) {
      b.tokens = cap;
      b.windowStart = now;
    }

    b.last = now;
    if (b.tokens <= 0) return false;
    b.tokens -= 1;
    return true;
  }

  _rendezvousStr = process.env.PLURIBIT_RENDEZVOUS || 'pluribit:mainnet:v1';
  _rendezvousCid = null;
  _rendezvousTimer = null;


async _provideCompat(cid) {
  const cr = this.node.contentRouting;
  if (cr?.provide) {
    const ret = cr.provide(cid);
    if (ret?.[Symbol.asyncIterator]) {
      for await (const _ of ret) {} // drain
    } else {
      await ret; // Promise<void> or undefined
    }
    return true;
  }
  const dht = this.node.services?.dht;
  if (dht?.provide) { await dht.provide(cid); return true; }
  return false;
}

async _findProvidersCompat(cid, opts) {
  const out = [];
  const cr = this.node.contentRouting;
  if (cr?.findProviders) {
    const res = cr.findProviders(cid, opts);
    if (res?.[Symbol.asyncIterator]) {
      for await (const p of res) out.push(p);
    } else {
      const arr = await res; // some versions return Promise<Provider[]>
      if (Array.isArray(arr)) out.push(...arr);
    }
    return out;
  }
  const dht = this.node.services?.dht;
  if (dht?.findProviders) {
    for await (const p of dht.findProviders(cid, opts)) out.push(p);
  }
  return out;
}



  async _getRendezvousCID() {
    if (this._rendezvousCid) return this._rendezvousCid;
    const bytes = new TextEncoder().encode(this._rendezvousStr);
    const digest = await sha256.digest(bytes);
    this._rendezvousCid = CID.createV1(raw.code, digest);
    return this._rendezvousCid;
  }

    async _announceAndDiscoverProviders() {
      try {
        const cid = await this._getRendezvousCID();

        // Announce
        try {
            const ok = await this._provideCompat(cid);
            if (ok) this.log(`[P2P] 📣 Provided rendezvous CID ${cid.toString()}`);
        } catch (e) {
          const isAbort = e?.name === 'AbortError' || /aborted/i.test(e?.message || '');
          this.log(`[P2P] Provide ${isAbort ? 'aborted' : 'error'}: ${e?.message || e}`, isAbort ? 'debug' : 'warn');
        }

        // Discover (with a timeout)
        let providers = await this._findProvidersCompat(cid, { timeout: 15_000 });

        const myId = this.node.peerId.toString();
        for (const p of providers) {
          const id = p.id?.toString?.();
          if (!id || id === myId) continue;

          const already = this.node.getConnections(id).length > 0;
         if (!already) {
                try {
                    if (p.multiaddrs?.length) {
                        await this._addToAddressBookCompat(p.id, p.multiaddrs);
                    }
                    await this.node.dial(p.id);
                    
                    // The peer:connect event will handle challenging
                    this.log(`[P2P] 🔌 Connected to rendezvous provider ${id}`);
                    
                } catch (e) {
                    const isAbort = e?.name === 'AbortError' || /aborted/i.test(e?.message || '');
                    this.log(`[P2P] Rendezvous dial ${isAbort ? 'aborted' : 'failed'}: ${id} — ${e?.message || e}`, isAbort ? 'debug' : 'warn');
                }
            }
        }
      } catch (e) {
        this.log(`[P2P] Rendezvous error: ${e?.message || e}`, 'warn');
      }
    }



    async initialize() {
        this.log('[P2P] Initializing libp2p node...');
        
        // Try to load bootstrap addresses from config
        if (!this.isBootstrap) {
            try {
                const fs = await import('fs/promises');
                const configData = await fs.readFile('./bootstrap-config.json', 'utf-8');
                const config = JSON.parse(configData);
                if (config.bootstrapNodes && config.bootstrapNodes.length > 0) {
                    this.config.bootstrap = config.bootstrapNodes;
                    this.log('[P2P] Loaded bootstrap addresses from config');
                }
            } catch (err) {
                this.log('[P2P] No bootstrap config found, using defaults', 'warn');
            }
        }
        const peerId = await this.loadOrCreatePeerId();

        // Create libp2p node
        this.node = await createLibp2p({
            peerId,
            addresses: {
                listen: [
                    `/ip4/0.0.0.0/tcp/${this.config.listen.tcp}`,
                    `/ip4/0.0.0.0/tcp/${this.config.listen.ws}/ws`
                ]
            },
            transports: [
                tcp(),
                webSockets(),
                webRTC(),
                // Conditionally configure relay client
                circuitRelayTransport({
                    discoverRelays: this.isBootstrap ? 0 : 1
                })
            ],
            connectionEncrypters: [noise()],
            streamMuxers: [yamux()],
            services: {
                // Conditionally enable the relay server for bootstrap nodes
                ...(this.isBootstrap && { relay: circuitRelayServer() }),

                identify: identify(),
                dht: kadDHT({
                  // Use the public IPFS DHT protocol so we can use content routing on the open network
                  protocol: '/ipfs/kad/1.0.0',
                  clientMode: !this.isBootstrap,

                  validators: {
                    pluribit: {
                      func: (key, value) => {
                        try {
                          const data = JSON.parse(uint8ArrayToString(value));
                          return data.type === 'pluribit' && data.timestamp;
                        } catch {
                          return false;
                        }
                      }
                    }
                  }
                }),

                pubsub: gossipsub({
                    allowPublishToZeroPeers: true,
                    emitSelf: true,
                }),
                ping: ping(),
                 dcutr: dcutr(),
            },
            peerDiscovery: this.config.bootstrap.length > 0 
                ?
                [
                    bootstrap({
                        list: this.config.bootstrap,
                        interval: 30000,
                        timeout: 30000
                    }),
                    mdns() 
                ]
                : [mdns()],
           connectionManager: {
                minConnections: 0, 
                maxConnections: CONFIG.P2P.MAX_CONNECTIONS, 
                autoDial: false,
                autoDialInterval: 2000, 
                maxParallelDials: 10,
                dialTimeout: 30000      
            }
        });

        // Setup event handlers
        this.setupEventHandlers();
        
        // Start the node
        await this.node.start();
        this.log(`[P2P] Node started with ID: ${this.node.peerId.toString()}`);

      // Self-verify for loopback messages (emitSelf: true in gossipsub)
        this._updateVerificationState(this.node.peerId.toString(), { 
            powSolved: true, 
            isSubscribed: true 
        });

        // Register custom protocol for direct challenge-response
        const CHALLENGE_PROTOCOL = '/pluribit/challenge/1.0.0';

        await this.node.handle(CHALLENGE_PROTOCOL, async ({ stream, connection }) => {
            try {
                const chunks = [];
                for await (const chunk of stream.source) {
                    // Convert to a standard Uint8Array to prevent type errors
                    chunks.push(chunk.subarray());
                }
                const data = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
                
                if (data.type === 'CHALLENGE') {
                    // Solve the challenge
                    const { challenge, from } = data;
                    const difficulty = this._challengeDifficulty;
                    let nonce = 0;
                    let solution = '';
                    
                    while (true) {
                        solution = crypto.createHash('sha256')
                            .update(challenge)
                            .update(String(nonce))
                            .digest('hex');
                        if (solution.startsWith(difficulty)) {
                            break;
                        }
                        nonce++;
                    }
                    
                    // Send response back through the same stream
                    const response = JSON.stringify({
                        type: 'CHALLENGE_RESPONSE',
                        solution,
                        nonce: String(nonce),
                        from: this.node.peerId.toString()
                    });
                    
                    await pipe(
                        [new TextEncoder().encode(response)],
                        stream.sink
                    );
                    
                    this.log(`[P2P] Solved challenge from ${from} with nonce ${nonce}`, 'info');
                }
            } catch (e) {
                this.log(`[P2P] Error handling challenge protocol: ${e.message}`, 'error');
            }
        });        
        
                // Register protocol for direct block transfers
        const BLOCK_TRANSFER_PROTOCOL = `/pluribit/${NET}/block-transfer/1.0.0`;
        await this.node.handle(BLOCK_TRANSFER_PROTOCOL, async ({ stream, connection }) => {

            try {
                const peerId = connection.remotePeer.toString();
                
                // CRITICAL: Require verified peer
                if (!this.isPeerVerified(peerId)) {
                    this.log(`[P2P] Denying block transfer from unverified peer ${peerId}`, 'warn');
                    try { await stream.close(); } catch {}
                    return;
                }
                
                // Rate limiting
                if (!this._allowMessage(peerId)) {
                    this.log(`[P2P] Rate limited block transfer from ${peerId}`, 'warn');
                    try { await stream.close(); } catch {}
                    return;
                }
                
                const chunks = [];
                for await (const chunk of stream.source) {
                    chunks.push(chunk.subarray());
                }
                const request = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
                
                // Input validation
                if (!request.hash || typeof request.hash !== 'string') {
                    this.log(`[P2P] Invalid block request from ${peerId}`, 'warn');
                    const resp = JSON.stringify({ type: 'ERROR', reason: 'BAD_REQUEST' });
                    await pipe([new TextEncoder().encode(resp)], stream.sink);
                    return;
                }
                
                // Validate hash format (64 hex characters)
                if (!/^[0-9a-f]{64}$/i.test(request.hash)) {
                    this.log(`[P2P] Invalid block hash format from ${peerId}`, 'warn');
                    const resp = JSON.stringify({ type: 'ERROR', reason: 'INVALID_HASH' });
                    await pipe([new TextEncoder().encode(resp)], stream.sink);
                    return;
                }
                
                if (request.type === 'GET_BLOCK' && request.hash) {
                    // This request is now handled by the 'main' worker's logic
                    // We just need to proxy it through.
                    // We'll use our existing handlers map.
                    const handlers = this.handlers.get(BLOCK_TRANSFER_PROTOCOL) || [];
                    for (const handler of handlers) {
                        const block = await handler(request.hash);
                        if (block) {
                            const response = JSONStringifyWithBigInt({ type: 'BLOCK_DATA', payload: block });
                            await pipe([new TextEncoder().encode(response)], stream.sink);
                            return; // End after sending
                        }
                    }
                    // Not found
                    const resp = JSON.stringify({ type: 'ERROR', reason: 'NOT_FOUND' });
                    await pipe([new TextEncoder().encode(resp)], stream.sink);
                    return;
                }
                // Bad request type
                const resp = JSON.stringify({ type: 'ERROR', reason: 'BAD_REQUEST' });
                await pipe([new TextEncoder().encode(resp)], stream.sink);
            } catch (e) {
                this.log(`[P2P] Error handling block transfer protocol: ${e.message}`, 'error');
            }
        });
        
        
        const addrs = this.node.getMultiaddrs();
        addrs.forEach(addr => this.log(`[P2P] Listening on ${addr.toString()}`));

        // Proactively dial bootstrap peers once
        if (!this.isBootstrap && Array.isArray(this.config.bootstrap) && this.config.bootstrap.length) {
          const tasks = this.config.bootstrap.map(async (addr) => {
            try {
              await this.node.dial(multiaddr(addr));
              this.log(`[P2P] 🔌 Dialed bootstrap ${addr}`);
            } catch (e) {
              this.log(`[P2P] Could not dial bootstrap ${addr}: ${e.message}`, 'warn');
            }
          });
          await Promise.allSettled(tasks);
        }

        // Start DHT (guard in case libp2p already started it)
        try {
          if (this.node.services.dht?.isStarted?.() === false) {
            await this.node.services.dht.start();
          }
        } catch { /* ignore if already started */ }
        
        // Light GC for rate-limit buckets to bound memory
        this._bucketGcTimer = setInterval(() => {
          const now = Date.now();
          for (const [k, b] of this._buckets) {
            if ((now - (b.last || b.windowStart)) > 15 * 60_000) this._buckets.delete(k);
          }
        }, 5 * 60_000);
        
        // Zero-infra rendezvous: announce & discover via public DHT provider records
        await this._announceAndDiscoverProviders();
        this._rendezvousTimer = setInterval(() => {
          this._announceAndDiscoverProviders().catch((e) => {
            const isAbort = e?.name === 'AbortError' || /aborted/i.test(e?.message || '');
            this.log(`[P2P] Rendezvous ${isAbort ? 'aborted (timeout/cancel)' : 'failed'}: ${e?.message || e}`, isAbort ? 'debug' : 'warn');
          });
        }, 10 * 60 * 1000); //every 10 mins
        
        return this.node;
    }

  async loadOrCreatePeerId() {
    const peerIdPath = './pluribit-data/peer-id.json';
    try {
      await fs.mkdir('./pluribit-data', { recursive: true });
      const data = await fs.readFile(peerIdPath, 'utf-8');
      const stored = JSON.parse(data);
      return await createEd25519PeerId({
        privateKey: uint8ArrayFromString(stored.privKey, 'base64')
      });
    } catch {
      // Create new
      const peerId = await createEd25519PeerId();
      const data = {
        id: peerId.toString(),
        privKey: uint8ArrayToString(peerId.privateKey, 'base64'),
        pubKey: uint8ArrayToString(peerId.publicKey, 'base64')
      };
      await fs.writeFile(peerIdPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      try { await fs.chmod(peerIdPath, 0o600); } catch {}
      this.log('[P2P] Created new peer ID');
      return peerId;
    }
  }

    isPeerVerified(peerId) {
        const state = this._peerVerificationState.get(peerId.toString());
        if (!state) return false;
        // A peer is verified if they have solved the PoW and are subscribed to our main topic.
        return state.powSolved && state.isSubscribed;
    }

    setupEventHandlers() {
        this.node.addEventListener('peer:connect', async (evt) => {
            const peerId = evt.detail.toString();
            this.log(`[P2P] Connected to ${peerId}`, 'debug');

            // Give the connection a moment to stabilize before sending a challenge.
            setTimeout(async () => {
                try {
                    await this.sendDirectChallenge(peerId);
                } catch (e) {
                    this.log(`[P2P] Challenge error for ${peerId}: ${e.message}`, 'error');
                }
            }, 2000); // Increased delay to 2 seconds
        });
        
    this.node.addEventListener('peer:disconnect', (evt) => {
        const peerId = evt.detail;
        this.log(`[P2P] Disconnected from ${peerId.toString()}`, 'debug');
        // Clean up state for disconnected peer
        const peerIdStr = peerId.toString();
        this._peerChallenges.delete(peerIdStr);
        this._peerVerificationState.delete(peerIdStr);
        this._buckets.delete(peerIdStr);
    });
    
    // Add discovery events with auto-dial
    this.node.addEventListener('peer:discovery', async (evt) => {
      const { id, multiaddrs } = evt.detail;

      // ignore self
      if (id?.toString?.() === this.node.peerId.toString()) return;

      // persist addresses so the conn mgr can use them
     if (multiaddrs?.length) {
       await this._addToAddressBookCompat(id, multiaddrs);
     }

      this.log(`[P2P] Discovered peer: ${id.toString()} (${multiaddrs?.length ?? 0} addrs)`, 'debug');

      // if we're under the target and not already connected, dial now
      const already = this.node.getConnections(id).length > 0;
      const total = this.node.getConnections().length;
      const target = CONFIG.P2P.MIN_CONNECTIONS;

      if (!already && total < target) {
        try {
          await this.node.dial(id);
          this.log(`[P2P] Auto-dialed discovered peer ${id.toString()}`, 'debug');
        } catch (e) {
          this.log(`[P2P] Auto-dial to ${id.toString()} failed: ${e.message}`, 'warn');
        }
      }
    });

    
    // Add connection events for debugging
    this.node.addEventListener('connection:open', (evt) => {
        const connection = evt.detail;
        this.log(`[P2P] Connection opened to ${connection.remotePeer.toString()}`, 'debug');
    });
    
    this.node.addEventListener('connection:close', (evt) => {
        const connection = evt.detail;
        this.log(`[P2P] Connection closed to ${connection.remotePeer.toString()}`, 'debug');
    });
    
    // GossipSub message handler
    this.node.services.pubsub.addEventListener('message', (evt) => {
                this.log(`[P2P PUBSUB EVENT] 'message' event fired for topic: ${evt.detail.topic}`, 'debug');

        this.handleGossipMessage(evt.detail);
    });
    
    // ** Listen for subscription changes to confirm Pluribit peers **
    this.node.services.pubsub.addEventListener('subscription-change', (evt) => {
        const { peerId, subscriptions } = evt.detail;
        // Check if the peer is now subscribed to our main block topic
        const sub = subscriptions.find(s => s.topic === TOPICS.BLOCKS);

        if (sub) {
            if (sub.subscribe) {
                // Peer subscribed, update state
                this._updateVerificationState(peerId.toString(), { isSubscribed: true });
            } else {
                // Peer unsubscribed, update state
                this._updateVerificationState(peerId.toString(), { isSubscribed: false });
            }
        }
    });
}

async handleGossipMessage(msg) {
    try {
        const from = msg.from?.toString?.() ?? String(msg.from);
        this.log(`[P2P RAW] Received message on topic ${msg.topic} from ${from}`, 'debug');
        // CRITICAL: Verify ALL peers (including self for loopback)
        if (!this.isPeerVerified(from)) {
            this.log(`[P2P] Dropping message from unverified peer ${from}`, 'warn');
            return;
        }

        if (!Object.values(TOPICS).includes(msg.topic)) {
            return;
        }

        const bytes = msg?.data;
        if (bytes && bytes.byteLength > CONFIG.MAX_MESSAGE_SIZE) {
            this.log(`[P2P] Dropping oversize message on ${msg.topic} from ${from}`, 'warn');
            return;
        }

        if (!this._allowMessage(from)) {
            this.log(`[P2P] Rate-limited ${from} on ${msg.topic}`, 'warn');
            return;
        }

        const data = JSONParseWithBigInt(uint8ArrayToString(msg.data));
        
        const schema = MESSAGE_SCHEMAS[msg.topic];
        if (schema) {
            for (const field of (schema.required || [])) {
                if (!(field in data)) {
                    this.log(`[P2P] Missing required field '${field}' in ${msg.topic} from ${from}`, 'warn');
                    return;
                }
            }
            for (const [field, expectedType] of Object.entries(schema.types || {})) {
                if (field in data && typeof data[field] !== expectedType) {
                    this.log(`[P2P] Invalid type for field '${field}' from ${from}: expected ${expectedType}, got ${typeof data[field]}`, 'warn');
                    return;
                }
            }
        }

        const handlers = this.handlers.get(msg.topic) || [];
        for (const handler of handlers) {
            try {
                await handler(data, { from, topic: msg.topic });
            } catch (e) {
                this.log(`[P2P] Handler error for ${msg.topic}: ${e.message}`, 'error');
            }
        }
    } catch (e) {
        // Catch JSON parsing errors specifically for better debugging.
        if (e instanceof SyntaxError) {
            this.log(`[P2P] Failed to parse JSON message: ${e.message}`, 'error');
        } else {
            this.log(`[P2P] Error in message handler: ${e.message}`, 'error');
        }
    }
}


  // Public API

  async subscribe(topic, handler) {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, []);
      this.node.services.pubsub.subscribe(topic);
      this.log(`[P2P] Subscribed to ${topic}`);
    }
    this.handlers.get(topic).push(handler);
  }

  async publish(topic, data) {
    // RATIONALE: Always stringify objects using the BigInt-safe method to prevent data loss and ensure consistency.
    const payloadString = JSONStringifyWithBigInt(data);
    const bytes = uint8ArrayFromString(payloadString);

    if (bytes.byteLength > CONFIG.MAX_MESSAGE_SIZE) {
      throw new Error(`Refusing to publish >MAX_MESSAGE_SIZE on ${topic}`);
    }
    await this.node.services.pubsub.publish(topic, bytes);
  }

  // ---- DHT: Signed write ----
  async store(key, value) {
    const nsKey = `/pluribit/${key}`;
    const payload = { type: 'pluribit', value, timestamp: Date.now() };
    // canonical material to sign (avoid reordering issues)
    const toSign = stableStringify({
      ns: nsKey,
      payload,
      from: this.node.peerId.toString(),
      v: 1
    });
    const hashHex = sha256Hex(toSign);
    const hashBytes = uint8ArrayFromString(hashHex, 'hex');
    // sign with our ed25519 private key
    const sig = nacl.sign.detached(hashBytes, this.node.peerId.privateKey);
    const envelope = {
      ns: nsKey,
      payload,                 // { type, value, timestamp }
      from: this.node.peerId.toString(),
      pubKey: uint8ArrayToString(this.node.peerId.publicKey, 'base64'),
      sig: uint8ArrayToString(sig, 'base64'),
      alg: 'ed25519',
      v: 1
    };
    await this.node.services.dht.put(
      uint8ArrayFromString(nsKey),
      uint8ArrayFromString(JSON.stringify(envelope))
    );
  }


  // ---- DHT: Verify on read ----
  async get(key) {
    try {
      const nsKey = `/pluribit/${key}`;
      const result = await this.node.services.dht.get(uint8ArrayFromString(nsKey));
      const env = JSON.parse(uint8ArrayToString(result));

      // quick shape checks
      if (!env || env.ns !== nsKey || env.v !== 1 || env.alg !== 'ed25519') {
        this.log(`[DHT] Rejected value for ${nsKey}: bad envelope`, 'warn');
        return null;
      }
      if (!env.pubKey || !env.sig || !env.payload) {
        this.log(`[DHT] Rejected value for ${nsKey}: missing fields`, 'warn');
        return null;
      }

      // recompute the signed material
      const toSign = stableStringify({
        ns: env.ns,
        payload: env.payload,
        from: env.from,
        v: env.v
      });
      const hashHex = sha256Hex(toSign);
      const hashBytes = uint8ArrayFromString(hashHex, 'hex');
      const pub = uint8ArrayFromString(env.pubKey, 'base64');
      const sig = uint8ArrayFromString(env.sig, 'base64');

      const ok = nacl.sign.detached.verify(hashBytes, sig, pub);
      if (!ok) {
        this.log(`[DHT] Rejected value for ${nsKey}: signature invalid`, 'warn');
        return null;
      }

      // bind claimed "from" to pubKey -> derived PeerId
      try {
        const derived = await createFromPubKey({ publicKey: pub });

        if (derived.toString() !== env.from) {
          this.log(`[DHT] Rejected value for ${nsKey}: pubKey does not match 'from'`, 'warn');
          return null;
        }
      } catch (e) {
        this.log(`[DHT] Could not derive PeerId from pubKey: ${e?.message || e}`, 'warn');
        return null;
      }

      // freshness guard: drop payloads older than 24h
      if (Date.now() - (env.payload?.timestamp || 0) > 86_400_000) return null;

      // skew guard: drop payloads >5m in the future
      if ((env.payload?.timestamp || 0) > Date.now() + 5 * 60_000) return null;

      // anti-replay: only accept strictly newer timestamps per key
      const last = this._dhtSeen.get(nsKey) || 0;
      if ((env.payload?.timestamp || 0) <= last) return null;
      this._dhtSeen.set(nsKey, env.payload.timestamp);

      return env.payload?.value ?? null;
    } catch (e) {
      this.log(`[DHT] get error for /pluribit/${key}: ${e?.message || e}`, 'debug');
      return null;
    }
  }

  getConnectedPeers() {
    // Get all connected peer IDs
    const peerIds = this.node.getPeers();

    // Map over the peer IDs to get their details
    return peerIds.map(peerId => {
      // CORRECTED: First, get the full peer object from the peerStore
      const peer = this.node.peerStore.get(peerId);
      
      // If the peer exists, get its protocols, otherwise return an empty array
      const protocols = peer ? peer.protocols : [];
      
      return {
        id: peerId.toString(),
        protocols: protocols
      };
    });
  }

async stop() {
  if (this._rendezvousTimer) {
    clearInterval(this._rendezvousTimer);
    this._rendezvousTimer = null;
  }
  if (this._challengeGcTimer) {
    clearInterval(this._challengeGcTimer);
    this._challengeGcTimer = null;
  }
  await this.node.stop();
}
}
