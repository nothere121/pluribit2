// File: generate-key.js
import { createEd25519PeerId } from '@libp2p/peer-id-factory';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

async function generate() {
  console.log('Generating new permanent PeerID...');
  const peerId = await createEd25519PeerId();
  
  // --- THIS IS THE FIX ---
  // The private key is directly on the peerId object.
  // We access .privateKey.bytes, not .keypair.privateKey.bytes
  const rawPrivKey = peerId.privateKey.bytes;
  // --- END FIX ---

  if (!rawPrivKey || rawPrivKey.length !== 32) {
    console.error('Failed to generate 32-byte raw private key!');
    return;
  }

  console.log('\n--- SUCCESS! ---');
  console.log('Your new permanent PeerID is:');
  console.log(peerId.toString());
  
  console.log('\nYour permanent 32-byte Private Key (base64) is:');
  console.log(uint8ArrayToString(rawPrivKey, 'base64'));
  
  console.log('\nCopy these values and save them somewhere safe.');
}

generate();
