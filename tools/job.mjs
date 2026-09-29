#!/usr/bin/env node
// Turn a card number into a mining job: the challenge and difficulty to search for.
//
//   node tools/job.mjs 42 --recipient 0xYourAddress   # mint: the card goes to this address
//   node tools/job.mjs 42 --level                     # level-up of a minted card
//
// Writes jobs/<token>-<mint|level>.json for miner/search.py.
import fs from 'node:fs';
import path from 'node:path';
import { getAddress } from 'ethers';
import { ZERO, challenge, collectionEntry, connect, fail, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { recipient: String, level: Boolean, rpc: String, site: String, out: String, data: String });
const tokenId = Number(args._[0]);
if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > 6187) fail('usage: node tools/job.mjs <token 1..6187> (--recipient 0x... | --level)');
const action = args.level ? 1 : 0;
if (!action && !args.recipient) fail('a mint job needs --recipient: the solution only works for that address');
const recipient = action ? ZERO : getAddress(args.recipient);
if (!action && recipient === ZERO) fail('recipient must not be the zero address');
const site = (args.site || 'https://eth2015.com').replace(/\/$/, '');

const c = await connect(site, args.rpc);
const { record } = await collectionEntry(site, c.collectionRoot, tokenId);
const state = await c.contract.tokenState(tokenId);
if (!action && state.owner !== ZERO) fail(`card ${tokenId} is already minted (owner ${state.owner}); mine a level-up with --level instead`);
if (action && state.owner === ZERO) fail(`card ${tokenId} is not minted yet, so it cannot level up`);

const [onchain, difficulty] = await Promise.all([c.contract.challengeFor(action, tokenId, recipient), c.contract.requiredDifficulty(record.difficulty)]);
const derived = challenge(c.chainId, c.nft, c.collectionRoot, tokenId, recipient, action);
if (onchain.toLowerCase() !== derived.toLowerCase()) fail('the contract challenge differs from the derived one; the spec or deployment changed');

const job = {
  site, rpc: c.rpc, chainId: c.chainId.toString(), nftAddress: c.nft, collectionRoot: c.collectionRoot,
  tokenId, action: action ? 'level' : 'mint', recipient,
  epoch: Number(record.epoch), pageCount: record.pageCount, dagRoot: record.dagRoot,
  challenge: derived, difficulty: difficulty.toString(), historicalDifficulty: record.difficulty.toString(),
};
const outDir = args.out || 'jobs', file = path.join(outDir, `${tokenId}-${job.action}.json`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(job, null, 2) + '\n');

const hours = (d, mhs) => (Number(d) / (mhs * 1e6) / 3600);
const fmt = h => (h < 1 / 60 ? 'under a minute' : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
const times = d => `${fmt(hours(d, 100))} at 100 MH/s, ${fmt(hours(d, 225))} at 225 MH/s`;
console.log(`card ${tokenId} (${job.action}) on chain ${job.chainId}, epoch ${job.epoch}, difficulty ${difficulty}`);
console.log(`average time: ${times(difficulty)} (a solution can come much sooner or later)`);
if (difficulty !== record.difficulty) console.log(`this deployment lowers the work for testing; the real 2015 difficulty ${record.difficulty} takes ${times(record.difficulty)}`);
console.log(`wrote ${file}`);
const dagDir = path.join(args.data || 'data', String(job.epoch));
if (!fs.existsSync(path.join(dagDir, 'manifest.json')))
  console.log(`next: build the epoch ${job.epoch} dataset:\n  tools/ethash-tool/ethash-tool -mode generate -epoch ${job.epoch} -dir ${dagDir} -workers $(nproc)`);
else console.log(`next: python3 miner/search.py --job ${file}`);
