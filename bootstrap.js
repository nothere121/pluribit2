#!/usr/bin/env node

// Polyfill for CustomEvent in Node.js environment
if (typeof CustomEvent === 'undefined') {
  class CustomEvent extends Event {
    constructor(type, options) {
      super(type, options);
      this.detail = options?.detail || null;
    }
  }
  global.CustomEvent = CustomEvent;
}

// Polyfill for Promise.withResolvers
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
import { CONFIG } from './config.js';
import { PluribitP2P } from './libp2p-node.js';

// Bootstrap node that stays online to help peers discover each other
async function runBootstrap() {
  console.log('Starting Pluribit bootstrap node...');
  
    const net = process.env.PLURIBIT_NET || 'mainnet';
    
    // CRITICAL: No public fallback for testnet
    if (net !== 'mainnet') {
        const fs = await import('fs/promises');
        try {
            await fs.access('./bootstrap-config.json');
        } catch {
            console.error('ERROR: bootstrap-config.json required for non-mainnet networks');
            console.error('Public IPFS bootstrappers disabled for testnet isolation');
            process.exit(1);
        }
        console.log(`Running bootstrap node for network: ${net}`);
    }
    
  
  const p2p = new PluribitP2P(console.log, {
    isBootstrap: true,
    tcpPort: CONFIG.P2P.TCP_PORT,
    wsPort: CONFIG.P2P.WS_PORT
  });
  await p2p.initialize();
  
  console.log('\nBootstrap node ready!');
  console.log('Share these addresses with the network:\n');
  
  const addrs = p2p.node.getMultiaddrs();
  const tcpAddr = addrs.find(addr => addr.toString().includes('/tcp/26658'));
  
  if (tcpAddr) {
    // Save the bootstrap address to a config file
    const fs = await import('fs/promises');
    const config = {
      bootstrapNodes: [tcpAddr.toString()]
    };
    await fs.writeFile('./bootstrap-config.json', JSON.stringify(config, null, 2), { mode: 0o600 });
    try { await fs.chmod('./bootstrap-config.json', 0o600); } catch {}
    console.log('\nBootstrap address saved to bootstrap-config.json');
  }
  
  addrs.forEach(addr => {
    console.log(`  ${addr.toString()}`);
  });
  
  // Keep running
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await p2p.stop();
    process.exit(0);
  });
}

runBootstrap().catch(console.error);
