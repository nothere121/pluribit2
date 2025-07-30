#!/usr/bin/env node
import { PluribitP2P } from './libp2p-node.js';

// Bootstrap node that stays online to help peers discover each other
async function runBootstrap() {
  console.log('Starting Pluribit bootstrap node...');
  
  const p2p = new PluribitP2P(console.log);
  await p2p.initialize();
  
  console.log('\nBootstrap node ready!');
  console.log('Share these addresses with the network:\n');
  
  const addrs = p2p.node.getMultiaddrs();
  addrs.forEach(addr => {
    console.log(`  ${addr.toString()}/p2p/${p2p.node.peerId.toString()}`);
  });
  
  // Keep running
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await p2p.stop();
    process.exit(0);
  });
}

runBootstrap().catch(console.error);
