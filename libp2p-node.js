import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { webRTC } from '@libp2p/webrtc';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { createEd25519PeerId } from '@libp2p/peer-id-factory';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

// Topic definitions
export const TOPICS = {
  BLOCKS: '/pluribit/blocks/1.0.0',
  TRANSACTIONS: '/pluribit/transactions/1.0.0',
  BLOCK_REQUEST: '/pluribit/block-request/1.0.0'
};

export class PluribitP2P {
  constructor(log) {
    this.log = log;
    this.node = null;
    this.handlers = new Map();
    this.config = {
      listen: {
        tcp: 26658,
        ws: 26659
      },
      bootstrap: [
        // Add bootstrap nodes here when deployed
        // '/dns4/bootstrap1.pluribit.org/tcp/26658/p2p/QmPeerId...'
      ]
    };
  }

  async initialize() {
    this.log('[P2P] Initializing libp2p node...');
    // Load or create peer ID
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
      transports: [tcp(), webSockets(), webRTC()],
      connectionEncryption: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        dht: kadDHT({
          clientMode: false,
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
          emitSelf: false,
          gossipIncoming: true,
          fallbackToFloodsub: false,
          floodPublish: false,
          doPX: true,
          msgIdFn: (msg) => {
            const hash = crypto.createHash('sha256');
            hash.update(msg.data);
            return hash.digest('hex').substring(0, 20);
          },
          // Message validation
          globalSignaturePolicy: 'StrictSign',
          scoreParams: {
            topics: {
              [TOPICS.BLOCKS]: {
                topicWeight: 1.0,
                timeInMeshWeight: 0.5,
                timeInMeshQuantum: 12000,
                timeInMeshCap: 300,
                firstMessageDeliveriesWeight: 1.0,
                firstMessageDeliveriesDecay: 0.5,
                firstMessageDeliveriesCap: 100,
                meshMessageDeliveriesWeight: -1.0,
                meshMessageDeliveriesDecay: 0.5,
                meshMessageDeliveriesThreshold: 5,
                meshMessageDeliveriesCap: 10,
                meshMessageDeliveriesActivation: 30000,
                meshMessageDeliveriesWindow: 5000,
                invalidMessageDeliveriesWeight: -10.0,
                invalidMessageDeliveriesDecay: 0.5
              },
              [TOPICS.TRANSACTIONS]: {
                topicWeight: 0.5,
                timeInMeshWeight: 0.5,
                timeInMeshQuantum: 12000,
                timeInMeshCap: 300,
                firstMessageDeliveriesWeight: 0.5,
                firstMessageDeliveriesDecay: 0.5,
                firstMessageDeliveriesCap: 1000
              }
            }
          }
        })
      },
      peerDiscovery: this.config.bootstrap.length > 0 ?
      [
        bootstrap({ list: this.config.bootstrap })
      ] : [],
      connectionManager: {
        minConnections: 10,
        maxConnections: 50,
        autoDial: true,
        autoDialInterval: 10000,
        maxParallelDials: 10
      }
    });

    // Setup event handlers
    this.setupEventHandlers();
    
    // Start the node
    await this.node.start();
    this.log(`[P2P] Node started with ID: ${this.node.peerId.toString()}`);
    
    const addrs = this.node.getMultiaddrs();
    addrs.forEach(addr => this.log(`[P2P] Listening on ${addr.toString()}`));

    // Start DHT
    await this.node.services.dht.start();
    
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
      await fs.writeFile(peerIdPath, JSON.stringify(data, null, 2));
      this.log('[P2P] Created new peer ID');
      return peerId;
    }
  }

  setupEventHandlers() {
    this.node.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail;
      this.log(`[P2P] Connected to ${peerId.toString()}`);
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail;
      this.log(`[P2P] Disconnected from ${peerId.toString()}`);
    });

    // GossipSub message handler
    this.node.services.pubsub.addEventListener('message', (evt) => {
      this.handleGossipMessage(evt.detail);
    });
  }

  async handleGossipMessage(msg) {
    try {
      const data = JSON.parse(uint8ArrayToString(msg.data));
      const handlers = this.handlers.get(msg.topic) || [];
      
      for (const handler of handlers) {
        try {
          await handler(data, {
            from: msg.from.toString(),
            topic: msg.topic
          });
        } catch (e) {
          this.log(`[P2P] Handler error for ${msg.topic}: ${e.message}`, 'error');
        }
      }
    } catch (e) {
      this.log(`[P2P] Failed to parse message: ${e.message}`, 'error');
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
    const message = {
      ...data,
      timestamp: Date.now(),
      from: this.node.peerId.toString()
    };
    await this.node.services.pubsub.publish(
      topic,
      uint8ArrayFromString(JSON.stringify(message))
    );
  }

  async store(key, value) {
    const data = {
      type: 'pluribit',
      value,
      timestamp: Date.now()
    };
    await this.node.services.dht.put(
      uint8ArrayFromString(key),
      uint8ArrayFromString(JSON.stringify(data))
    );
  }

  async get(key) {
    try {
      const result = await this.node.services.dht.get(uint8ArrayFromString(key));
      const data = JSON.parse(uint8ArrayToString(result));
      return data.value;
    } catch {
      return null;
    }
  }

  getConnectedPeers() {
    return this.node.getPeers().map(peer => ({
      id: peer.toString(),
      protocols: this.node.peerStore.protoBook.get(peer) || []
    }));
  }

  async stop() {
    await this.node.stop();
  }
}
