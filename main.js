import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import readline from 'readline';
import util from 'node:util';

// --- Setup ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: chalk.cyan('> ')
});

// --- State Management ---
let loadedWalletId = null;
let isMining = false;
let isStaking = false;
let isNetworkOnline = false;

// --- Worker Setup ---
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

worker.on('message', (event) => {
    const { type, payload, error } = event;

    switch (type) {
        case 'log':
            // Hide debug-level messages to reduce console noise
            if (payload.level === 'debug' && payload.message.startsWith('[P2P]')) break;

            const levelColor = {
                info: chalk.blue,
                success: chalk.green,
                warn: chalk.yellow,
                error: chalk.red,
            }[payload.level] || chalk.white;
            // Clear the current line, print the log, then redraw the prompt
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            console.log(`[${levelColor(payload.level.toUpperCase())}] ${payload.message}`);
            rl.prompt(true);
            break;

        case 'networkInitialized':
            isNetworkOnline = true; 
            console.log(chalk.green.bold('\nNetwork Online. Type "help" for commands.'));
            rl.prompt();
            break;
            
         case 'peerList':
            console.log(chalk.cyan.bold('\nConnected Peers:'));
            if (payload.length === 0) {
                console.log('  (None)');
            } else {
                payload.forEach(peer => console.log(`  - ${peer.id}`));
            }
            rl.prompt(true);
            break;        
               
        case 'walletLoaded':
            loadedWalletId = payload.walletId;
            console.log(chalk.green(`\nWallet '${payload.walletId}' loaded successfully.`));
            console.log(chalk.yellow(`Balance: ${payload.balance} | Address: ${payload.address}`));
            rl.prompt(true);
            break;
            
        case 'walletBalance':
            console.log(chalk.yellow(`\nBalance updated for ${payload.wallet_id}: ${payload.balance}`));
            rl.prompt(true);
            break;
        
        case 'minerStatus':
            isMining = payload.active;
            break;
        
        case 'validatorStatus':
            isStaking = payload.active;
            break;

        case 'totalSupply': 
            console.log(chalk.yellow(`\nTotal Supply: ${payload.supply} bits`));
            console.log(`   (Which is ${(Number(payload.supply) / 100_000_000).toFixed(8)} PLB)`);
            rl.prompt(true);
            break;

        case 'error':
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            console.error(chalk.red.bold(`\n[WORKER ERROR] ${error}`));
            rl.prompt(true);
            break;

           
    }
});

worker.on('error', (err) => {
    console.error('Worker thread error:', err?.stack || err?.message || util.inspect(err, { depth: 5 }));
});

worker.on('exit', (code) => {
    if (code !== 0) console.error(chalk.red.bold(`Worker stopped with exit code ${code}`));
});


// --- Command Handling ---
rl.on('line', (line) => {
    const args = line.trim().split(' ');
    const command = args.shift().toLowerCase();

    handleCommand(command, args);
    
}).on('close', () => {
    console.log(chalk.cyan('Shutting down...'));
    worker.terminate();
    process.exit(0);
});

async function handleCommand(command, args) {
    switch (command) {
        case 'help':
            console.log('\nAvailable Commands:');
            console.log('  create <wallet_name>   - Create a new wallet');
            console.log('  load <wallet_name>     - Load an existing wallet');
            console.log('  send <to> <amount>     - Send a transaction');
            console.log('  mine                   - Toggle PoW+PoST mining on/off');
            console.log('  status                 - Show current chain status');
            console.log('  balance                - Show wallet balance');
            console.log('  supply                 - Audit the total circulating supply');
            console.log('  connect <peer>         - Manually connect to a peer');
            console.log('  peers                  - List connected P2P peers');
            console.log('  exit                   - Shutdown the node\n');
            break;

        case 'audit':
            worker.postMessage({ action: 'auditDetailed' });
            break;
        case 'inspect':
            worker.postMessage({ action: 'inspectBlock', height: args[0] });
            break;
        case 'verify':
            worker.postMessage({ action: 'verifySupply' });
            break;

        case 'whodid':
            worker.postMessage({ action: 'checkMiners' });
            break;

        case 'create':
            if (args[0]) worker.postMessage({ action: 'initWallet', walletId: args[0] });
            else console.log('Usage: create <wallet_name>');
            break;
            
        case 'load':
            if (args[0]) worker.postMessage({ action: 'loadWallet', walletId: args[0] });
            else console.log('Usage: load <wallet_name>');
            break;

        case 'connect':
            if (args[0]) {
                worker.postMessage({ action: 'connectPeer', address: args[0] });
            } else {
                console.log('Usage: connect <multiaddr>');
            }
            break;

        case 'send':
            if (args.length < 2) {
                console.log('Usage: send <to_address> <amount>');
            } else if (!loadedWalletId) {
                console.log(chalk.red('Error: No wallet loaded.'));
            } else {
                const amt = Number(args[1]);
                if (!Number.isFinite(amt) || amt <= 0) {
                  console.log(chalk.red('Error: amount must be a positive finite number.'));
                  break;
                }
                worker.postMessage({
                    action: 'createTransaction',
                    from: loadedWalletId,
                    to: args[0],
                    amount: amt,
                    fee: 1
                });
            }
            break;

        case 'mine':
            if (!isNetworkOnline) {
                console.log(chalk.red('Error: Network is not yet online. Please wait.'));
            } else if (!loadedWalletId) {
                console.log(chalk.red('Error: Load a wallet before mining.'));
            } else {
                worker.postMessage({ action: 'setMinerActive', active: !isMining, minerId: loadedWalletId });
            }
            break;
            
        case 'status':
            worker.postMessage({ action: 'getMiningParams' });
            break;

        case 'supply':
            // Audit the total circulating supply via worker
            worker.postMessage({ action: 'getSupply' });
            break;

        case 'balance':
            if (!loadedWalletId) {
                console.log(chalk.red('Error: No wallet loaded.'));
            } else {
                worker.postMessage({ action: 'getBalance', walletId: loadedWalletId });
            }
            break;
            
        case 'peers':
            worker.postMessage({ action: 'getPeers' });
            break;

        case 'exit':
            await gracefulShutdown(0);
            return; // don't prompt again

        default:
            if(command) console.log(`Unknown command: "${command}". Type "help".`);
            break;
    }
    rl.prompt();
}


// -------- Graceful shutdown (main) ----------
let shuttingDown = false;
async function gracefulShutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(chalk.cyan('Shutting down...'));

  // Ask worker to stop cleanly (it will close libp2p, stop miner, etc.)
  try { worker.postMessage({ action: 'shutdown' }); } catch {}

  // Wait for the worker to exit, with a fallback terminator
  const done = new Promise((resolve) => {
    const onExit = () => {
      worker.removeListener('exit', onExit);
      resolve();
    };
    worker.on('exit', onExit);
    // Hard fallback after 5s if worker doesn’t exit by itself
    setTimeout(() => {
      worker.terminate().finally(resolve);
    }, 5000);
  });
  await done;
  process.exit(code);
}

// Handle Ctrl-C directly (so we don’t crash mdns sockets)
process.on('SIGINT', () => rl.close());
process.on('SIGTERM', () => rl.close());

// --- Initial Start ---
worker.postMessage({ action: 'initializeNetwork' });
