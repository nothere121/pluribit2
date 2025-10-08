// inspect-block.js
import { loadBlock } from './js_bridge.cjs';

import { inspect } from 'util';

// Get the block height from the command line arguments
const blockHeightArg = process.argv[2];

if (!blockHeightArg) {
  console.error('Error: Please provide a block height to inspect.');
  console.log('Usage: node inspect-block.js <height>');
  process.exit(1);
}

const height = parseInt(blockHeightArg, 10);

if (isNaN(height)) {
    console.error(`Error: Invalid block height "${blockHeightArg}". Please provide a number.`);
    process.exit(1);
}


async function pullBlock() {
  console.log(`--- Pulling Block #${height} From Database ---`);

  try {
    const block = await loadBlock(height);
    
    if (!block) {
      console.log(`Block #${height} not found in the database.`);
      return;
    }

    // Print the full, detailed block content
    console.log(inspect(block, { depth: null, colors: true }));

  } catch (error) {
    console.error(`Error while fetching block #${height}:`, error);
  }
}

pullBlock();
