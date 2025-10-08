// inspect-db.cjs
import { getAllBlocks, getChainTip, getTipHeight } from './js_bridge.cjs';
import { inspect } from 'util';

async function inspectChain() {
  console.log('--- Inspecting Pluribit Blockchain DB ---');

  try {
    const tipHeight = await getTipHeight();
    if (tipHeight === 0) {
      const genesis = await getAllBlocks();
      if (genesis.length > 0) {
        console.log('Blockchain contains only the genesis block.');
        console.log(inspect(genesis[0], { depth: null, colors: true }));
      } else {
        console.log('The blockchain is empty.');
      }
      return;
    }
    
    const tip = await getChainTip();
    console.log(`Current chain tip is at height: ${tip.height}`);
    console.log(`Fetching all ${tip.height + 1} blocks...`);

    const allBlocks = await getAllBlocks();
    
    console.log(`\nFound ${allBlocks.length} blocks in the database.`);
    
    // Print a summary of each block
    allBlocks.forEach(block => {
      const txCount = block.transactions ? block.transactions.length : 0;
      console.log(
        `[Block #${block.height}] Hash: ${block.hash.substring(0, 24)}... | Txs: ${txCount}`
      );
    });

    // Print the full details of the latest block
    if (tip) {
        console.log('\n--- Details of Latest Block ---');
        // Use util.inspect for better object logging
        console.log(inspect(tip, { depth: null, colors: true }));
    }

  } catch (error) {
    console.error('Error while inspecting database:', error);
  }
}

inspectChain();
