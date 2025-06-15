/* tslint:disable */
/* eslint-disable */
export function greet(name: string): string;
/**
 * Computes a VDF proof.
 * Takes an input string (which will be hashed) and the number of iterations.
 * Returns the VDFProof struct serialized as a JsValue, or a JsValue error.
 */
export function perform_vdf_computation(input_str: string, iterations: bigint): any;
/**
 * Verifies a VDF proof.
 * Takes an input string, the VDFProof (as JsValue),
 * Returns true if valid, false otherwise, or a JsValue error.
 */
export function verify_vdf_proof(input_str: string, proof_js: any): boolean;
export function create_genesis_block(): any;
export function init_vdf_clock(ticks_per_block: bigint): any;
export function tick_vdf_clock(): any;
export function get_vdf_clock_state(): any;
export function check_block_submission(block_height: bigint): any;
export function compute_block_hash(block_json: any): string;
export function init_blockchain(): any;
export function add_block_to_chain(block_json: any): any;
export function get_blockchain_state(): any;
export function get_latest_block_hash(): string;
export function consensus_tick(): any;
export function submit_pow_candidate(block_js: any): void;
export function get_block_with_hash(block_json: any): any;
export function get_blockchain_with_hashes(): any;
export function create_stake_lock(validator_id: string, stake_amount: bigint, lock_duration: bigint): any;
export function compute_stake_vdf(validator_id: string): any;
export function activate_stake_with_vdf(validator_id: string, vdf_proof_js: any): void;
export function vote_for_block(validator_id: string): any;
export function verify_validator_vote(validator_id: string, block_height: bigint, block_hash: string, stake_amount: bigint, signature_bytes: Uint8Array): boolean;
export function get_validators(): any;
export function create_wallet_transaction(from_wallet_id: string, to_wallet_id: string, amount: bigint, fee: bigint): any;
export function init_wallet(wallet_id: string, initial_balance: bigint): void;
export function get_wallet_balance(wallet_id: string): any;
export function get_tx_pool(): any;
export function mine_block_with_txs(height: bigint, prev_hash: string, miner_id: string, difficulty: number, max_attempts: bigint, vdf_proof_js: any): any;
export function add_transaction_to_pool(tx_json: any): void;
export function verify_transaction(tx_json: any): boolean;
export function clear_transaction_pool(): void;
export function get_transaction_hash(tx_json: any): string;
export function update_utxo_set_from_block(block_json: any): void;
export function get_utxo_set_size(): number;
export function sync_blockchain(blocks_json: any): any;
export function validate_and_sync_chain(chain_json: any): any;
export function get_wallet_data(wallet_id: string): any;
export function restore_wallet(wallet_id: string, wallet_data_js: any): void;
export function get_current_difficulty(): number;
export function check_and_report_double_votes(reporter_id: string): any;
export function report_double_vote(validator_id: string, height: bigint, block_hash1: string, block_hash2: string, reporter_id: string): void;
export function create_utxo_snapshot(): any;
export function restore_from_utxo_snapshot(snapshot_js: any): void;
export function apply_block_cut_through(block_js: any): any;
export function prune_blockchain(keep_recent_blocks: bigint): void;
export function get_chain_storage_size(): any;
export function compute_block_vdf_proof(prev_hash: string): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly greet: (a: number, b: number) => [number, number];
  readonly perform_vdf_computation: (a: number, b: number, c: bigint) => [number, number, number];
  readonly verify_vdf_proof: (a: number, b: number, c: any) => [number, number, number];
  readonly create_genesis_block: () => [number, number, number];
  readonly init_vdf_clock: (a: bigint) => [number, number, number];
  readonly tick_vdf_clock: () => [number, number, number];
  readonly get_vdf_clock_state: () => [number, number, number];
  readonly check_block_submission: (a: bigint) => [number, number, number];
  readonly compute_block_hash: (a: any) => [number, number, number, number];
  readonly init_blockchain: () => [number, number, number];
  readonly add_block_to_chain: (a: any) => [number, number, number];
  readonly get_blockchain_state: () => [number, number, number];
  readonly get_latest_block_hash: () => [number, number, number, number];
  readonly consensus_tick: () => [number, number, number];
  readonly submit_pow_candidate: (a: any) => [number, number];
  readonly get_block_with_hash: (a: any) => [number, number, number];
  readonly get_blockchain_with_hashes: () => [number, number, number];
  readonly create_stake_lock: (a: number, b: number, c: bigint, d: bigint) => [number, number, number];
  readonly compute_stake_vdf: (a: number, b: number) => [number, number, number];
  readonly activate_stake_with_vdf: (a: number, b: number, c: any) => [number, number];
  readonly vote_for_block: (a: number, b: number) => [number, number, number];
  readonly verify_validator_vote: (a: number, b: number, c: bigint, d: number, e: number, f: bigint, g: number, h: number) => [number, number, number];
  readonly get_validators: () => [number, number, number];
  readonly create_wallet_transaction: (a: number, b: number, c: number, d: number, e: bigint, f: bigint) => [number, number, number];
  readonly init_wallet: (a: number, b: number, c: bigint) => [number, number];
  readonly get_wallet_balance: (a: number, b: number) => [number, number, number];
  readonly get_tx_pool: () => [number, number, number];
  readonly mine_block_with_txs: (a: bigint, b: number, c: number, d: number, e: number, f: number, g: bigint, h: any) => [number, number, number];
  readonly add_transaction_to_pool: (a: any) => [number, number];
  readonly verify_transaction: (a: any) => [number, number, number];
  readonly clear_transaction_pool: () => [number, number];
  readonly get_transaction_hash: (a: any) => [number, number, number, number];
  readonly update_utxo_set_from_block: (a: any) => [number, number];
  readonly get_utxo_set_size: () => number;
  readonly sync_blockchain: (a: any) => [number, number, number];
  readonly validate_and_sync_chain: (a: any) => [number, number, number];
  readonly get_wallet_data: (a: number, b: number) => [number, number, number];
  readonly restore_wallet: (a: number, b: number, c: any) => [number, number];
  readonly get_current_difficulty: () => [number, number, number];
  readonly check_and_report_double_votes: (a: number, b: number) => [number, number, number];
  readonly report_double_vote: (a: number, b: number, c: bigint, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
  readonly create_utxo_snapshot: () => [number, number, number];
  readonly restore_from_utxo_snapshot: (a: any) => [number, number];
  readonly apply_block_cut_through: (a: any) => [number, number, number];
  readonly prune_blockchain: (a: bigint) => [number, number];
  readonly get_chain_storage_size: () => [number, number, number];
  readonly compute_block_vdf_proof: (a: number, b: number) => [number, number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_4: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
