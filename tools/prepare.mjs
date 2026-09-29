#!/usr/bin/env node
// Turn a found nonce into a transaction: build the witness, check it, pack the
// multiproof, encode mint/levelUp, and simulate it. Nothing is signed or sent here.
//
//   node tools/prepare.mjs solutions/42-mint-123456.json [--from 0xSender]
//
// Writes tx/<token>-<action>-<nonce>.json and prints the `cast send` line to send it
// with your own wallet (hardware wallet, keystore, whatever you use).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Interface, getAddress } from 'ethers';
import { ABI, ZERO, cardEntry, challenge, collectionEntry, connect, fail, packProof, parseArgs, target, verifyWitness } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { job: String, from: String, rpc: String, data: String, tool: String, out: String });
if (!args._[0]) fail('usage: node tools/prepare.mjs <solution.json> [--job jobs/N-mint.json] [--from 0x...]');
const solution = JSON.parse(fs.readFileSync(args._[0], 'utf8'));
const job = JSON.parse(fs.readFileSync(args.job || path.join('jobs', `${solution.tokenId}-${solution.action}.json`), 'utf8'));
if (solution.challenge.toLowerCase() !== job.challenge.toLowerCase()) fail('solution was mined for a different challenge than this job');
const action = job.action === 'level' ? 1 : 0, tokenId = job.tokenId, nonce = BigInt(solution.nonce);

// 1. The deployment must still be the one the job was built for, and the action still open.
const c = await connect(job.site, args.rpc);
if (challenge(c.chainId, c.nft, c.collectionRoot, tokenId, job.recipient, action).toLowerCase() !== job.challenge.toLowerCase())
  fail('the live deployment gives a different challenge; this work is for another deployment');
const state = await c.contract.tokenState(tokenId);
if (!action && state.owner !== ZERO) fail(`card ${tokenId} was minted by someone else first (owner ${state.owner}); a mint solution cannot be reused`);
if (action && await c.contract.usedLevelNonces(tokenId, nonce)) fail(`nonce ${nonce} was already used for card ${tokenId}`);

// 2. Witness: the 64 pages and their branches, from dag.bin + tree.bin.
const tool = args.tool || path.join('tools', 'ethash-tool', 'ethash-tool');
const dir = path.join(args.data || 'data', String(job.epoch));
const run = spawnSync(tool, ['-mode', 'witness', '-dir', dir, '-challenge', job.challenge, '-nonce', nonce.toString()], { encoding: 'utf8', maxBuffer: 64 << 20 });
if (run.error || run.status !== 0) fail(`ethash-tool witness failed: ${run.error?.message || run.stderr.trim()}`);
const witness = JSON.parse(run.stdout);
const replay = verifyWitness(job, witness);
if (replay.result.toLowerCase() !== solution.result.toLowerCase() || replay.mixDigest.toLowerCase() !== solution.mixDigest.toLowerCase())
  fail('witness replay does not match the solution; is data/<epoch> the right dataset?');
if (BigInt(replay.result) > target(BigInt(job.difficulty))) fail('result is above the target: not enough work');
const packed = packProof(job, witness, replay.indices);

// 3. Calldata.
const { record, proof } = await collectionEntry(job.site, c.collectionRoot, tokenId);
const iface = new Interface(ABI);
let data;
if (action) data = iface.encodeFunctionData('levelUp', [record, proof, nonce, witness.pages, packed.order, packed.dagProof]);
else {
  const card = await cardEntry(job.site, c.cardRoot, tokenId);
  data = iface.encodeFunctionData('mint', [record, proof, job.recipient, nonce, witness.pages, packed.order, packed.dagProof, card.data, card.proof]);
}

// 4. Simulate from the address that will send it (any address may send either action).
const from = args.from ? getAddress(args.from) : (action ? ZERO : job.recipient);
const tx = { from, to: c.nft, data };
let gas;
try {
  await c.provider.call(tx);
  gas = await c.provider.estimateGas(tx);
} catch (e) {
  const reason = e.revert?.name || e.shortMessage || e.message;
  fail(`simulation reverted: ${reason}`);
}
const gasLimit = gas * 120n / 100n;
const outDir = args.out || 'tx', file = path.join(outDir, `${tokenId}-${job.action}-${nonce}.json`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(file, JSON.stringify({ chainId: c.chainId.toString(), to: c.nft, from, gasEstimate: gas.toString(), gasLimit: gasLimit.toString(),
  tokenId, action: job.action, nonce: nonce.toString(), result: replay.result, proofNodes: packed.nodes, data }, null, 2) + '\n');
fs.writeFileSync(file.replace(/\.json$/, '.hex'), data + '\n');

console.log(`witness verified, ${packed.nodes} proof nodes, ${(data.length - 2) / 2} bytes of calldata`);
console.log(`simulation passed from ${from}: ${gas} gas (limit ${gasLimit})`);
console.log(`wrote ${file}`);
console.log(`\nsend it with your own wallet, for example:`);
console.log(`  cast send ${c.nft} --data "$(cat ${file.replace(/\.json$/, '.hex')})" --gas-limit ${gasLimit} --rpc-url ${c.rpc} --ledger`);
console.log(action ? '' : `\nMinting is a race: if another mint lands first this transaction reverts and still costs gas.`);
