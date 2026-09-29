// Shared helpers for job.mjs and prepare.mjs. Everything here follows the public
// specification at https://eth2015.com/llm.txt (Part 2); the contract is the only
// authority, so every value read from the site is checked against the chain.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AbiCoder, Contract, JsonRpcProvider, concat, getAddress, getBytes, hexlify, id, keccak256 } from 'ethers';

const require = createRequire(import.meta.url);
const { keccak_512 } = require('js-sha3');

export const ZERO = '0x0000000000000000000000000000000000000000';
export const U256 = 1n << 256n;
const coder = AbiCoder.defaultAbiCoder();
const DOMAIN = id('ETH2015_ACTION_WORK_V3');
const RECORD_TYPEHASH = id('Record(uint256 tokenId,address historicalContract,uint256 deploymentBlock,bytes32 blockHash,uint256 difficulty,uint256 epoch,uint32 pageCount,bytes32 dagRoot)');
const CARD_TYPEHASH = id('Card(uint256 tokenId,bytes32 data)');
const RECORD = 'tuple(uint256 tokenId,address historicalContract,uint256 deploymentBlock,bytes32 blockHash,uint256 difficulty,uint256 epoch,uint32 pageCount,bytes32 dagRoot)';

export const ABI = [
  `function mint(${RECORD} record,bytes32[] collectionProof,address recipient,uint64 nonce,bytes pages,bytes order,bytes dagProof,bytes32 card,bytes32[] cardProof)`,
  `function levelUp(${RECORD} record,bytes32[] collectionProof,uint64 nonce,bytes pages,bytes order,bytes dagProof)`,
  'function challengeFor(uint8 action,uint256 tokenId,address recipient) view returns (bytes32)',
  'function requiredDifficulty(uint256 historicalDifficulty) view returns (uint256)',
  'function tokenState(uint256 tokenId) view returns (tuple(uint256 tokenId,address owner,uint256 level,uint8 finish,uint256 rollBlock))',
  'function usedLevelNonces(uint256 tokenId,uint64 nonce) view returns (bool)',
  'function collectionRoot() view returns (bytes32)',
  'function cardRoot() view returns (bytes32)',
  'function WORK_VERSION() view returns (uint256)',
  'function finish(uint256 tokenId) view returns (uint8 status,uint256 rollBlock)',
  'function claimGolden(uint256 tokenId)',
  'event WorkAccepted(uint256 indexed tokenId,address indexed recipient,uint8 indexed action,uint256 level,bytes32 challenge,uint64 nonce,bytes32 mixDigest,bytes32 result)',
  'error InvalidRecord()', 'error InvalidCollectionProof()', 'error InvalidCardProof()', 'error InvalidDagProof()',
  'error InvalidWitness()', 'error InsufficientWork()', 'error WorkAlreadyUsed()', 'error WrongRecipient()',
  'error AlreadyMinted()', 'error InvalidAction()', 'error NotGolden()', 'error RollPending()', 'error AlreadyGolden()',
];

export function fail(message) { console.error('error: ' + message); process.exit(1); }

export function parseArgs(argv, flags) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    if (!(name in flags)) fail(`unknown option ${a}`);
    out[name] = flags[name] === Boolean ? true : argv[++i];
  }
  return out;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) fail(`${url}: HTTP ${r.status}`);
  return r.json();
}

// The site's config names the live deployment; the chain has to agree with it.
export async function connect(site, rpcUrl) {
  const config = await getJSON(`${site}/mint/config.json`);
  const rpc = rpcUrl || process.env.ETH2015_RPC_URL || config.rpcUrls[0];
  const provider = new JsonRpcProvider(rpc);
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) fail(`RPC is chain ${network.chainId}, the site uses ${config.chainId}`);
  const nft = getAddress(config.nftAddress);
  if (await provider.getCode(nft) === '0x') fail(`no contract at ${nft}`);
  const contract = new Contract(nft, ABI, provider);
  const [version, collectionRoot, cardRoot] = await Promise.all([contract.WORK_VERSION(), contract.collectionRoot(), contract.cardRoot()]);
  if (version !== 3n) fail(`WORK_VERSION is ${version}, this kit speaks 3`);
  if (collectionRoot.toLowerCase() !== config.collectionRoot.toLowerCase()) fail('collectionRoot on chain differs from the site config');
  if (config.cardRoot && cardRoot.toLowerCase() !== config.cardRoot.toLowerCase()) fail('cardRoot on chain differs from the site config');
  return { config, provider, contract, chainId: network.chainId, nft, collectionRoot, cardRoot, rpc };
}

// collection.json is about 7.7 MB; keep one copy per collection root.
export async function collectionEntry(site, root, tokenId, cacheDir = 'cache') {
  const file = path.join(cacheDir, `collection-${root.slice(2, 10)}.json`);
  let data;
  if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    data = await getJSON(`${site}/mint/collection.json`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }
  const entry = data.records[tokenId - 1];
  if (Number(entry?.record?.tokenId) !== tokenId) fail(`token ${tokenId} is not in collection.json`);
  const r = entry.record;
  const record = { tokenId: BigInt(r.tokenId), historicalContract: getAddress(r.historicalContract), deploymentBlock: BigInt(r.deploymentBlock),
    blockHash: r.blockHash, difficulty: BigInt(r.difficulty), epoch: BigInt(r.epoch), pageCount: Number(r.pageCount), dagRoot: r.dagRoot };
  if (sortedProof(recordLeaf(record), entry.proof) !== root.toLowerCase()) fail(`collection proof for ${tokenId} does not reach the root`);
  return { record, proof: entry.proof };
}

function recordLeaf(r) {
  return keccak256(keccak256(coder.encode(
    ['bytes32', 'uint256', 'address', 'uint256', 'bytes32', 'uint256', 'uint256', 'uint32', 'bytes32'],
    [RECORD_TYPEHASH, r.tokenId, r.historicalContract, r.deploymentBlock, r.blockHash, r.difficulty, r.epoch, r.pageCount, r.dagRoot])));
}

// OpenZeppelin sorted pairs: used for the collection and card proofs, never for the DAG.
export function sortedProof(leaf, proof) {
  let x = leaf.toLowerCase();
  for (const s of proof) x = keccak256(BigInt(x) < BigInt(s) ? concat([x, s]) : concat([s, x]));
  return x;
}

export async function cardEntry(site, cardRoot, tokenId) {
  const shard = await getJSON(`${site}/mint/card-proofs/${Math.floor((tokenId - 1) / 128)}.json`);
  const card = shard.records.find(c => Number(c.tokenId) === tokenId);
  if (!card) fail(`no card data for ${tokenId}`);
  const leaf = keccak256(keccak256(coder.encode(['bytes32', 'uint256', 'bytes32'], [CARD_TYPEHASH, tokenId, card.data])));
  if (sortedProof(leaf, card.proof) !== cardRoot.toLowerCase()) fail(`card proof for ${tokenId} does not reach cardRoot`);
  return card;
}

export function challenge(chainId, nft, root, tokenId, recipient, action) {
  return keccak256(coder.encode(['bytes32', 'uint256', 'address', 'bytes32', 'uint256', 'address', 'uint8'],
    [DOMAIN, chainId, nft, root, tokenId, action === 1 ? ZERO : recipient, action]));
}

export const target = d => (d === 1n ? U256 - 1n : U256 / d);
const fnv = (a, b) => (Math.imul(a, 0x01000193) ^ b) >>> 0;

// Replays Hashimoto from the witness pages and checks every page's branch against dagRoot.
export function verifyWitness(job, w) {
  const pages = getBytes(w.pages), depth = Math.ceil(Math.log2(job.pageCount));
  if (pages.length !== 8192 || w.siblings.length !== 64 * depth) fail('witness has the wrong shape');
  const input = new Uint8Array(40);
  input.set(getBytes(job.challenge));
  new DataView(input.buffer).setBigUint64(32, BigInt(w.nonce), true);
  const seed = new Uint8Array(keccak_512.arrayBuffer(input)), sv = new DataView(seed.buffer);
  const mix = Array.from({ length: 32 }, (_, j) => sv.getUint32((j % 16) * 4, true)), s0 = mix[0], indices = [];
  for (let a = 0; a < 64; a++) {
    const index = fnv(a ^ s0, mix[a % 32]) % job.pageCount, page = pages.subarray(a * 128, a * 128 + 128);
    const prefix = new Uint8Array(5);
    new DataView(prefix.buffer).setUint32(1, index, false);
    let node = keccak256(concat([prefix, page])), pos = index;
    for (let level = 0; level < depth; level++, pos >>>= 1) {
      const s = w.siblings[a * depth + level];
      node = keccak256(concat(pos & 1 ? ['0x01', s, node] : ['0x01', node, s]));
    }
    if (node.toLowerCase() !== job.dagRoot.toLowerCase()) fail(`page for access ${a} is not in the dataset`);
    const v = new DataView(page.buffer, page.byteOffset, 128);
    for (let j = 0; j < 32; j++) mix[j] = fnv(mix[j], v.getUint32(j * 4, true));
    indices.push(index);
  }
  const digest = new Uint8Array(32), dv = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, fnv(fnv(fnv(mix[4 * i], mix[4 * i + 1]), mix[4 * i + 2]), mix[4 * i + 3]), true);
  const result = keccak256(concat([seed, digest]));
  return { mixDigest: hexlify(digest), result, indices };
}

// One positional multiproof for all 64 pages (llm.txt Part 2, section 7).
export function packProof(job, w, indices) {
  const depth = Math.ceil(Math.log2(job.pageCount)), pages = getBytes(w.pages);
  const order = [...indices.keys()].sort((a, b) => indices[a] - indices[b] || a - b);
  let nodes = [];
  for (const a of order) {
    if (nodes.length && nodes.at(-1).index === indices[a]) continue; // a repeated page appears once
    const prefix = new Uint8Array(5);
    new DataView(prefix.buffer).setUint32(1, indices[a], false);
    nodes.push({ index: indices[a], access: a, hash: keccak256(concat([prefix, pages.subarray(a * 128, a * 128 + 128)])) });
  }
  const proof = [];
  for (let level = 0; level < depth; level++) {
    const up = [];
    for (let k = 0; k < nodes.length;) {
      const x = nodes[k], y = nodes[k + 1];
      let pair;
      if (x.index % 2 === 0 && y && y.index === x.index + 1) { pair = [x.hash, y.hash]; k += 2; }
      else {
        const s = w.siblings[x.access * depth + level];
        proof.push(s);
        pair = x.index % 2 ? [s, x.hash] : [x.hash, s];
        k += 1;
      }
      up.push({ index: x.index >>> 1, access: x.access, hash: keccak256(concat(['0x01', ...pair])) });
    }
    nodes = up;
  }
  if (nodes.length !== 1 || nodes[0].hash.toLowerCase() !== job.dagRoot.toLowerCase()) fail('multiproof does not reach dagRoot');
  return { order: hexlify(Uint8Array.from(order)), dagProof: concat(proof), nodes: proof.length };
}
