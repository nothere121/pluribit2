// File: generate-key.js
import { createEd25519PeerId } from '@libp2p/peer-id-factory';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

async function generate() {
  console.log('Generating new permanent PeerID...');
  const peerId = await createEd25519PeerId();
  const privKey = peerId.privateKey;
  
  if (!privKey) {
    console.error('Failed to generate key!');
    return;
  }

  console.log('\n--- SUCCESS! ---');
  console.log('Your new permanent PeerID is:');
  console.log(peerId.toString());
  
  console.log('\nYour permanent Private Key (base64) is:');
  console.log(uint8ArrayToString(privKey, 'base64'));
  
  console.log('\nCopy these values and save them somewhere safe.');
}

generate();
