```
▓▓▓ ╔══════════════════════════════════════════════════════════╗ ▓▓▓
▓▓  ║                                     ██                   ║  ▓▓
▓   ║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║██║║║║║║║║║║║║║║║║║║║║   ▓
    ║██████╗ ██╗     ██╗   ██╗██████╗ ██╗████║    ██╗████████╗ ║
    ║██╔══██╗██║     ██║   ██║██╔══██╗██║║██ ╚══╗ ██║╚══██╔══╝ ║
    ║██████╔╝██║     ██║   ██║██████╔╝██║║██████║ ██║   ██║    ║
    ║██╔═══╝ ██║     ██║   ██║██╔══██╗██║║██║║║██║║║║║║║║║║║║║║║║║║
    ║██║     ███████╗╚██████╔╝██║  ██║██║║██████║ ██║   ██║    ║
    ║╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚══════╝ ╚═╝   ╚═╝    ║
▓   ║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║   ▓
▓▓  ║                 Digital cash, native to the web          ║  ▓▓
▓▓▓ ╚══════════════════════════════════════════════════════════╝ ▓▓▓

        ▶ Decentralized • Secure • Private ◀
              [Proof of Time]
```
# pluriƀit

An experimental, privacy-focused cryptocurrency featuring a new consensus mechanism. Pluribit is built as a hybrid system with a Rust core compiled to WASM to handle cryptography and consensus rules, and a Node.js layer for networking and orchestration.

## Core Features

  * **Mandatory Privacy:** Implements **MimbleWimble** for confidential transactions. All amounts and addresses are obscured on-chain.
  * **Non-Interactive Transactions:** Utilizes **Stealth Addresses** to allow payments without requiring the sender and receiver to be online simultaneously.
  * **Novel Consensus Mechanism:** A unique three-stage process ($PoW \rightarrow VDF \rightarrow VRF$) designed for fairness and ASIC resistance.
  * **Decentralized P2P Networking:** Built on **libp2p**, using the public DHT for peer discovery without centralized bootstrap servers.
  * **IP Obfuscation:** Implements **Dandelion** for transaction propagation to obscure the originating IP address of a transaction.

-----

## Architecture

Pluriƀit uses a hybrid architecture to combine performance, security, and development speed.

  * **Rust Core (`pluribit_core`)**: Handles the project's core cryptography and consensus rules, compiled to WebAssembly. It manages all critical consensus logic, state validation, transaction construction, and MimbleWimble primitives.
  * **Node.js Orchestration Layer (`pluribit-node`)**: The main process that runs the node. It manages the libp2p network stack, database interactions (LevelDB), mining coordination via worker threads, and a JSON RPC server for the block explorer.
  * **Web Block Explorer**: A simple web interface for viewing blockchain statistics, blocks, and mempool status, served directly by the Node.js process.

-----

## Consensus Mechanism

pluriƀit's consensus is a two-part system designed for decentralization and fairness by reducing the hardware advantages of traditional Proof-of-Work.

### Part 1: Block Production (VDF → VRF Lottery)

This is the "lottery" a miner must win to create a block. It is a time-based search, not a hash-based one.

#### 1\. Nonce Search Loop (VDF as "Work")

  * A miner iteratively tests nonces (`nonce = 0, 1, 2...`) in a sequential search.
  * The "work" required for *each attempt* is the computation of a **VDF (Verifiable Delay Function)**. This VDF computation functions as the rate-limiting mechanism for the search.

#### 2\. Verifiable Delay Function (VDF)

  * The current `nonce` is combined with other block data to create a unique input for the VDF.
  * The VDF requires a fixed duration of sequential computation (`vdfIterations`) that cannot be significantly parallelized or sped up with specialized hardware.
  * This enforces a **time cost** per attempt, which makes hardware advantages less significant.

#### 3\. Verifiable Random Function (VRF)

  * The output of the completed VDF (`vdf_proof.y`) is used as the input for a **VRF**.
  * The VRF produces an unpredictable but verifiable random number.
  * If this number is below the current network target (`vrfThreshold`), the miner wins the lottery and can produce the next block.

### Part 2: Fork-Choice Rule (GHOST)

This is the rule nodes use to agree on the "correct" chain if a fork occurs.

  * When a fork is detected, the network does not simply follow the "longest" chain.
  * Instead, nodes use the **GHOST** (Greedy Heaviest Observed Subtree) protocol.
  * The network chooses the chain with the most **total cumulative work** in its entire subtree (the block *plus all* of its known descendants). This ensures the most secure chain is always followed.

-----

## Privacy Model

Privacy is mandatory and enforced at the protocol level.

  * **MimbleWimble**: Transactions consist only of inputs, outputs, and kernels. There are no on-chain addresses or transaction amounts. The protocol validates that no coins are created or destroyed without revealing the values being transacted.
  * **Stealth Addresses**: To enable non-interactive transactions, a sender uses the recipient's public scan key to generate a one-time ephemeral public key (`R`) where the funds are sent. A shared secret, known only to the sender and receiver, is used to encrypt the transaction's value and blinding factor. Only the recipient can use their private scan key to discover and spend these funds.
  * **Block-level Cut-through**: This implementation differs from standard Mimblewimble. Instead of aggregating transactions in the mempool, cut-through is performed at the block level.
    1.  The coinbase transaction is isolated.
    2.  All other transactions selected for the block are scanned. "Internal spends" (outputs created and spent within the same block) are identified.
    3.  If internal spends are found, all non-coinbase transactions are replaced by a single **aggregated transaction**.
    4.  This aggregated transaction contains only the **external inputs** and **unspent outputs**.
    5.  All kernels from all original transactions are concatenated into this single aggregated transaction to maintain cryptographic balance.
  * **Dandelion Propagation**: Transactions are not immediately broadcast to the entire network. They are first passed secretly along a random path of peers (the "stem" phase) before being broadcast widely (the "fluff" phase), making it difficult to trace a transaction back to its source IP.

-----

## Networking

  * **Peer-to-Peer Stack**: The network is built on **libp2p**, handling peer discovery, stream multiplexing, and connection encryption. Nodes use the public Kad-DHT to find each other, eliminating the need for hardcoded bootstrap nodes.
  * **Message Protocol**: All network messages are strictly defined and serialized using **Protocol Buffers (Protobuf)**. This provides a secure, efficient, and unambiguous binary format for communication, preventing a class of parsing-based vulnerabilities.
  * **Peer Verification**: New peers must solve a simple challenge-response PoW before their messages are accepted, mitigating spam and simple DoS attacks.

-----

## How to Run

### Prerequisites

  * Rust and `cargo`
  * Node.js (v18+) and `npm`
  * `wasm-pack`

    ```bash
    # Update package lists
    sudo apt update

    # Install Git, build tools, pkg-config, Protobuf, Clang, and OpenSSL Dev libs
    sudo apt install git curl build-essential pkg-config protobuf-compiler clang libssl-dev -y


    # A. Install Node Version Manager (NVM)
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    source ~/.bashrc
    nvm install 20

    # B. Install Rust (via rustup)
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
    # (Choose option 1: Proceed with installation)
    source ~/.cargo/env

    # C. Install Rust Tools
    cargo install wasm-pack
    ```

### Installation & Build

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/PubliusPseudis/pluribit.git
    cd pluribit
    ```

2.  **Install Node.js dependencies:**

    ```bash
    npm install
    ```

3.  **Build the project:**
    This command will build the Protobuf definitions, compile the Rust core to WASM, and prepare the Node.js application.

    ```bash
    npm run build
    ```

### Running the Node

Start the pluriƀit node using the start script:

```bash
npm run start
```

The node will initialize the P2P network and begin syncing with peers. A command-line interface will become available for interacting with the node.

-----

## Project Status

**Disclaimer:** This is an experimental project built to explore new concepts in cryptocurrency design. It is **not intended for production use** and should not be used to store significant value. The code is provided as-is for educational and research purposes.
