import * as readline from "readline";
import * as os from "os";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { fork, ChildProcess } from "child_process";
import { randomBytes, createHash } from "crypto";
import * as bech32 from "bech32";
import * as fs from "fs";
import * as path from "path";
import { fromBase64 } from "@cosmjs/encoding";
import {
  ChainGrpcBankApi,
  ChainGrpcWasmApi,
  MsgBroadcasterWithPk,
  PrivateKey,
  MsgExecuteContractCompat,
  toBase64,
} from "@injectivelabs/sdk-ts";
import { Network, getNetworkEndpoints } from "@injectivelabs/networks";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

const DEBUG = process.env.DEBUG === "1";

const ASTATINE_ASCII = `
\x1b[32m
      █████╗ ███████╗████████╗ █████╗ ████████╗██╗███╗   ██╗███████╗
     ██╔══██╗██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██║████╗  ██║██╔════╝
     ███████║███████╗   ██║   ███████║   ██║   ██║██╔██╗ ██║█████╗  
     ██╔══██║╚════██║   ██║   ██╔══██║   ██║   ██║██║╚██╗██║██╔══╝  
     ██║  ██║███████║   ██║   ██║  ██║   ██║   ██║██║ ╚████║███████╗
     ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝ miner-cli
\x1b[0m
`;

const ascii = `
\x1b[32m
     ▗▄▖  ▗▄▄▖▗▄▄▄▖▗▄▖▗▄▄▄▖▗▄▄▄▖▗▖  ▗▖▗▄▄▄▖
    ▐▌ ▐▌▐▌     █ ▐▌ ▐▌ █    █  ▐▛▚▖▐▌▐▌   
    ▐▛▀▜▌ ▝▀▚▖  █ ▐▛▀▜▌ █    █  ▐▌ ▝▜▌▐▛▀▀▘
    ▐▌ ▐▌▗▄▄▞▘  █ ▐▌ ▐▌ █  ▗▄█▄▖▐▌  ▐▌▐▙▄▄▖ miner-cli
\x1b[0m
`;

// Default contract addresses (can be overridden by `CONTRACT_ADDRESSES` env var)
const DEFAULT_NODES = [
  "inj1qfd8vwq0j4ps2mn0felam8f4u8a5xvxn39ezfy",
  "inj1wgvjaat3gna8dvuz7vqv6jmveng8kftlxklxjr",
  "inj1h9uwgtd9dfcgfzvr870ge0cxq3erqrvzd2r5fz",
];

const envNodes = process.env.CONTRACT_ADDRESSES
  ? process.env.CONTRACT_ADDRESSES.split(",").map((s) => s.trim()).filter(Boolean)
  : null;

const nodes = envNodes && envNodes.length > 0 ? envNodes : DEFAULT_NODES;

const NETWORK = (process.env.NETWORK || "testnet") as "mainnet" | "testnet";
const ENDPOINTS = getNetworkEndpoints(
  NETWORK === "mainnet" ? Network.Mainnet : Network.Testnet
);
const GRPC = ENDPOINTS.grpc;
const NETWORK_ENUM = NETWORK === "mainnet" ? Network.Mainnet : Network.Testnet;
const AST_DENOM = process.env.AST_NATIVE_DENOM || "factory/inj1k9hde84nufwmzq0wf6xs4jysll60fy6hd72ws2/AST";
const AST_DECIMALS = Number(process.env.AST_DECIMALS || "18");
let DETECTED_AST_DECIMALS: number | null = null;

async function detectAstDecimals() {
  // Try multiple strategies to detect decimals:
  // 1) If AST_DENOM starts with 'factory/{creator}/{sub}', attempt to query
  //    the creator address as a CW20 contract for `token_info`.
  // 2) Try bank metadata if available on the bank API.
  try {
    if (AST_DENOM.startsWith("factory/")) {
      const parts = AST_DENOM.split("/");
      if (parts.length >= 3 && parts[1]) {
        const creator = parts[1] as string;
        // Try common CW20 `token_info` query
        try {
          const raw = await wasmApi.fetchSmartContractState(
            creator as string,
            toBase64({ token_info: {} })
          );
          const info = JSON.parse(Buffer.from(raw.data).toString());
          if (info && typeof info.decimals === "number") {
            DETECTED_AST_DECIMALS = info.decimals;
            if (DEBUG) console.debug(`Detected AST decimals from token_info: ${DETECTED_AST_DECIMALS}`);
            return;
          }
        } catch (e) {
          if (DEBUG) console.debug("token_info query failed", (e as any)?.message || e);
        }
      }
    }

    // Try bank denom metadata if available
    try {
      const anyBank: any = bankApi as any;
      if (typeof anyBank.fetchDenomMetadata === "function") {
        const meta = await anyBank.fetchDenomMetadata({ denom: AST_DENOM });
        if (meta && meta.metadata && typeof meta.metadata.denom_units === "object") {
          const units = meta.metadata.denom_units;
          // find exponent for denom that has denom equal to AST_DENOM or base denom
          if (Array.isArray(units) && units.length > 0) {
            // choose smallest exponent as decimals
            let best = units.reduce((acc: any, u: any) => (u.exponent > acc ? u.exponent : acc), 0);
            DETECTED_AST_DECIMALS = Number(best) || AST_DECIMALS;
            if (DEBUG) console.debug(`Detected AST decimals from bank metadata: ${DETECTED_AST_DECIMALS}`);
            return;
          }
        }
      }
    } catch (e) {
      if (DEBUG) console.debug("denom metadata query failed", (e as any)?.message || e);
    }
  } catch (e) {
    if (DEBUG) console.debug("detectAstDecimals unexpected error", (e as any)?.message || e);
  }
}
const SELECTED_NODE = process.env.VALIDATOR_NO || "1";

// Support comma-separated validator indices (e.g. "1,2,3")
const SELECTED_NODES = SELECTED_NODE.split(",").map((s) => s.trim()).filter(Boolean).map(Number);

// Resolve to an array of contract addresses to mine (type-guarded to `string[]`)
const CONTRACTS = SELECTED_NODES.map((n) => nodes[n - 1]).filter(
  (c): c is string => Boolean(c)
);

// Validate mapping and log what we'll mine
if (CONTRACTS.length === 0) {
  console.error("No contract addresses resolved for selected validator indices. Check VALIDATOR_NO and CONTRACT_ADDRESSES.");
}
for (let i = 0; i < CONTRACTS.length; i++) {
  console.log(`Contract[${i}]: ${CONTRACTS[i]}`);
}

const SUBMIT_FEE_INJ = Number(process.env.SUBMIT_FEE_INJ || "0.01");
const GAS_LIMIT = Number(process.env.GAS_LIMIT || "400000");
const HDPATH_DEFAULT = `m/44'/60'/0'/0/0`;
const FINALIZE_COOLDOWN_MS = 4000;
const BEST_POLL_MS = Number("5000");

let logoShown = false;

// Simpler, stable HUD renderer: clear-and-redraw each render to keep boxes
// anchored and avoid accidental terminal scrolling caused by stray logs.
function renderHUD(lines: any[]) {
  try {
    console.clear();
    process.stdout.write(ASTATINE_ASCII);
    logoShown = true;

    for (let i = 0; i < lines.length; i++) {
      process.stdout.write(String(lines[i]) + "\n");
    }
  } catch (e) {
    // Don't allow HUD rendering problems to crash the process
    try {
      console.error("HUD render error:", (e as any)?.message || e);
    } catch {}
  }
}

type WorkResp = {
  height?: string | number;
  seed?: string;
  prev_hash?: string;
  target?: string;
  reward?: string;
  window_expires_at_secs?: string | number;
};
type ContestResp = {
  height?: string | number;
  window_starts_at?: string | number;
  window_expires_at_secs?: string | number;
  has_candidate?: boolean;
  best_miner?: string | null;
  best_hash?: string | null;
  finalized?: boolean;
};

const C = {
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  c: (s: string) => `\x1b[36m${s}\x1b[0m`,
  b: (s: string) => `\x1b[34m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
// ANSI helpers: measure and slice while preserving color codes
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string) {
  return s.replace(ANSI_RE, "");
}
function visibleLength(s: string) {
  return stripAnsi(s).length;
}
function ansiTruncate(s: string, maxVisible: number) {
  if (visibleLength(s) <= maxVisible) return s;
  let out = "";
  let remaining = maxVisible;
  const re = /(\x1b\[[0-9;]*m)|([\s\S])/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null && remaining > 0) {
    if (match[1]) {
      out += match[1];
      continue;
    }
    const ch = match[2];
    out += ch;
    remaining--;
  }
  // append ellipsis in plain text (no color)
  return out + "...";
}
function ansiPadEnd(s: string, width: number) {
  const pad = Math.max(0, width - visibleLength(s));
  return s + " ".repeat(pad);
}
function ansiCenter(s: string, width: number) {
  const vis = visibleLength(s);
  if (vis >= width) return ansiTruncate(s, width);
  const left = Math.floor((width - vis) / 2);
  const right = width - vis - left;
  return " ".repeat(left) + s + " ".repeat(right);
}
function hudLine(s: string) {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(s);
}
function bar(pct: number, width = 24) {
  const full = Math.round(pct * width);
  const fullPart = "▮".repeat(full);
  const emptyPart = "▯".repeat(width - full);
  return C.g(fullPart) + C.dim(emptyPart);
}
function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
function formatClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(m)}:${pad(r)}`;
}
function injToWeiStr(amountInInj: number) {
  const s = amountInInj.toFixed(18);
  const [ip, fp = ""] = s.split(".");
  return (ip + fp).replace(/^0+/, "") || "0";
}
function canonFromBech32(addr: string): Buffer {
  const dec = bech32.bech32.decode(addr);
  const raw = bech32.bech32.fromWords(dec.words);
  return Buffer.from(raw);
}
function hexTo32BE(hex: string) {
  const s = hex.length % 2 ? "0" + hex : hex;
  const buf = Buffer.from(s, "hex");
  if (buf.length === 32) return buf;
  const out = Buffer.alloc(32);
  buf.copy(out, 32 - buf.length);
  return out;
}
function inc128BE(buf: Buffer) {
  if (buf.length < 16)
    throw new Error(`inc128BE expects 16 bytes, got ${buf.length}`);
  for (let i = 15; i >= 0; i--) {
    const b = buf.readUInt8(i);
    if (b === 0xff) {
      buf.writeUInt8(0x00, i);
      continue;
    }
    buf.writeUInt8(b + 1, i);
    break;
  }
}

const bankApi = new ChainGrpcBankApi(GRPC);
const wasmApi = new ChainGrpcWasmApi(GRPC);

// Global HUD state for multiple contracts. Each contract reports its own lines here
const GLOBAL_HUD: Record<number, string[]> = {};
function setContractHud(idx: number, lines: string[]) {
  GLOBAL_HUD[idx] = lines;
}
function clearContractHud(idx: number) {
  delete GLOBAL_HUD[idx];
}
function renderGlobalHUD() {
  const keys = Object.keys(GLOBAL_HUD).map((k) => Number(k)).sort((a, b) => a - b);
  if (keys.length === 0) return;

  if (DEBUG) {
    try {
      const snapshotKeys = keys.slice();
      console.debug(`GLOBAL_HUD keys: ${snapshotKeys.join(",")}`);
      for (const k of snapshotKeys) {
        const block = GLOBAL_HUD[k] || [];
        console.debug(`HUD[${k}] preview:\n${block.slice(0, 6).join("\n")}`);
      }
    } catch (e) {
      console.debug("GLOBAL_HUD diagnostic failed", (e as any)?.message || e);
    }
  }

  // Build blocks and compute layout
  const blocks: string[][] = keys.map((k) => GLOBAL_HUD[k] || []);

  const termWidth = (process.stdout && process.stdout.columns) || 80;
  const cols = termWidth >= 160 ? 3 : termWidth >= 120 ? 2 : 1;
  const gap = 3; // spaces between columns
  const blockWidth = Math.max(30, Math.floor((termWidth - gap * (cols - 1)) / cols));

  // Normalize blocks: limit worker lines so blocks have comparable heights
  const MAX_WORKER_LINES = 6;
  const normalized: string[][] = blocks.map((b) => {
    // If block contains many worker lines at the end, truncate them
    if (b.length > 12) {
      const head = b.slice(0, 10);
      const tailCount = b.length - 10;
      head.push(`... and ${tailCount} more lines ...`);
      return head;
    }
    return b.slice();
  });

  const blockHeights = normalized.map((b) => b.length);
  const maxHeight = Math.min(25, Math.max(...blockHeights));

  // Pad blocks to maxHeight with empty strings
  const padded = normalized.map((b) => {
    const out = b.slice();
    while (out.length < maxHeight) out.push("");
    const innerW = blockWidth - 4;
    return out.map((line) => {
      // truncate/pad preserving ANSI colors
      const truncated = visibleLength(line) > innerW ? ansiTruncate(line, innerW - 3) : line;
      return ansiPadEnd(truncated, innerW).slice(0, innerW);
    });
  });

  // Arrange into rows of `cols` blocks
  const rows: string[] = [];
  // Render blocks into boxed columns
  for (let r = 0; r < Math.ceil(padded.length / cols); r++) {
    const rowBlocks: string[][] = [];
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx < padded.length) {
        const content = padded[idx] ?? [];
        const box: string[] = [];
        const innerW = blockWidth - 4; // account for box borders
        // header line (first line) centered (preserve ANSI)
        const header = content[0] ?? "";
        const centered = ansiCenter(header, innerW);
        box.push(C.dim('┌' + '─'.repeat(innerW + 2) + '┐'));
        box.push(C.dim('│ ') + centered + C.dim(' │'));
        box.push(C.dim('│') + ' '.repeat(innerW + 2) + C.dim('│'));
        for (let li = 1; li < (content.length || 0); li++) {
          const line = content[li] ?? "";
          box.push(C.dim('│ ') + ansiPadEnd(line, innerW) + C.dim(' │'));
        }
        box.push(C.dim('└' + '─'.repeat(innerW + 2) + '┘'));
        rowBlocks.push(box);
      } else {
        // empty block
        const innerW = blockWidth - 4;
        rowBlocks.push([
          C.dim('┌' + '─'.repeat(innerW + 2) + '┐'),
          C.dim('│' + ' '.repeat(innerW + 2) + '│'),
          C.dim('└' + '─'.repeat(innerW + 2) + '┘'),
        ]);
      }
    }

    // compute max height for this row of boxes
    const h = Math.max(...rowBlocks.map((b) => b.length));
    for (let lineIdx = 0; lineIdx < h; lineIdx++) {
      const parts: string[] = [];
      for (let c = 0; c < cols; c++) {
        const blk = rowBlocks[c] || [];
        // Use ANSI-aware padding so visible widths match blockWidth
        parts.push(ansiPadEnd(blk[lineIdx] ?? '', blockWidth));
      }
      rows.push(parts.join(' '.repeat(gap)));
    }
    rows.push('');
  }

  renderHUD(rows);
}

async function getInjBalance(address: string): Promise<bigint> {
  const res = await bankApi.fetchBalance({
    accountAddress: address,
    denom: "inj",
  });
  return BigInt(res.amount || "0");
}
async function getAstBalance(address: string): Promise<string> {
  try {
    const res = await bankApi.fetchBalance({
      accountAddress: address,
      denom: AST_DENOM,
    });

    if (process.env.VERBOSE === "1") {
      try {
        console.debug(`getAstBalance: denom=${AST_DENOM} ->`, JSON.stringify(res));
      } catch {}
    }

    return res.amount || "0";
  } catch {}
  return "0";
}

// Format a base-unit token amount (string) into a human readable string using
// provided decimals. Returns something like `1.2345` and we also expose raw units
function formatTokenBase(amountBase: string, decimals: number, fracDigits = 4) {
  try {
    const base = BigInt(amountBase || "0");
    const ten = 10n;
    const d = BigInt(decimals);
    const whole = base / ten ** d;
    const rem = base % ten ** d;
    if (fracDigits <= 0) return `${whole.toString()}`;
    // get fractional as string padded to `decimals` then cut to fracDigits
    const remStr = rem.toString().padStart(Number(d), "0");
    const frac = remStr.slice(0, Math.min(Number(d), fracDigits));
    const fracPadded = frac.padEnd(fracDigits, "0");
    return `${whole.toString()}.${fracPadded}`;
  } catch (e) {
    return "0";
  }
}
async function qWork(contract: string): Promise<WorkResp> {
  const raw = await wasmApi.fetchSmartContractState(
    contract,
    toBase64({ work: {} })
  );
  return JSON.parse(Buffer.from(raw.data).toString());
}
async function qContest(contract: string): Promise<ContestResp> {
  const raw = await wasmApi.fetchSmartContractState(
    contract,
    toBase64({ contest_summary: {} })
  );
  return JSON.parse(Buffer.from(raw.data).toString());
}

function pkFromMnemonic(mnemonic: string, hdpath = HDPATH_DEFAULT) {
  return PrivateKey.fromMnemonic(mnemonic, hdpath);
}
async function submitSolution(
  mnemonic: string,
  sender: string,
  contract: string,
  headerB64: string,
  nonce: bigint
) {
  const pk = pkFromMnemonic(mnemonic, HDPATH_DEFAULT);
  const broadcaster = new MsgBroadcasterWithPk({
    privateKey: pk.toPrivateKeyHex(),
    network: NETWORK_ENUM,
  });
  const funds = [{ denom: "inj", amount: injToWeiStr(SUBMIT_FEE_INJ) }];
  const msg = MsgExecuteContractCompat.fromJSON({
    contractAddress: contract,
    sender,
    msg: { submit_solution: { header: headerB64, nonce: nonce.toString() } },
    funds,
  });
  const resp = await broadcaster.broadcast({
    msgs: msg,
    gas: { gas: GAS_LIMIT },
  });
  return resp;
}
async function finalizeWindow(
  mnemonic: string,
  sender: string,
  contract: string
) {
  const pk = pkFromMnemonic(mnemonic, HDPATH_DEFAULT);
  const broadcaster = new MsgBroadcasterWithPk({
    privateKey: pk.toPrivateKeyHex(),
    network: NETWORK_ENUM,
  });
  const msg = MsgExecuteContractCompat.fromJSON({
    contractAddress: contract,
    sender,
    msg: { finalize_window: {} },
    funds: [],
  });
  const resp = await broadcaster.broadcast({
    msgs: msg,
    gas: { gas: GAS_LIMIT },
  });
  return resp;
}

function buildPreimageStatic(seed: Buffer, miner: Buffer, header: Buffer) {
  const total = seed.length + miner.length + 16 + header.length;
  const pre = Buffer.allocUnsafe(total);
  let off = 0;
  seed.copy(pre, off);
  off += seed.length;
  miner.copy(pre, off);
  off += miner.length;
  const nonceOffset = off;
  off += 16;
  header.copy(pre, off);
  return { pre, nonceOffset };
}

type WorkerIn = {
  seed: Uint8Array | Buffer;
  header: Uint8Array | Buffer;
  minerCanon: Uint8Array | Buffer;
  target: Uint8Array | Buffer;
  best: Uint8Array | Buffer | null;
  batch: number;
  wid: number;
};

type WorkerOut =
  | { type: "rate"; hps: number; wid: number }
  | { type: "found"; nonce: string; hashHex: string; wid: number };

if (!isMainThread) {
  try {
    const { seed, header, minerCanon, target, best, batch, wid } =
      workerData as WorkerIn;

  const sU8 = seed instanceof Uint8Array ? seed : new Uint8Array(seed as any);
  const hU8 =
    header instanceof Uint8Array ? header : new Uint8Array(header as any);
  const mU8 =
    minerCanon instanceof Uint8Array
      ? minerCanon
      : new Uint8Array(minerCanon as any);
  const tU8 =
    target instanceof Uint8Array ? target : new Uint8Array(target as any);
  const bU8 = best
    ? best instanceof Uint8Array
      ? best
      : new Uint8Array(best as any)
    : null;

  // Copy the incoming Uint8Array into fresh Buffers to avoid sharing
  const seedBuf = Buffer.from(sU8);
  const headerBuf = Buffer.from(hU8);
  const minerBuf = Buffer.from(mU8);
  const targetBuf = Buffer.from(tU8);
  let bestBuf: Buffer | null = bU8 ? Buffer.from(bU8) : null;

    parentPort!.on("message", (msg: any) => {
      if (msg?.type === "best") {
        const bestHex: string | null = msg.bestHex ?? null;
        if (bestHex) {
          const s = bestHex.length % 2 ? "0" + bestHex : bestHex;
          const raw = Buffer.from(s, "hex");
          const out = Buffer.alloc(32);
          raw.copy(out, 32 - raw.length);
          bestBuf = out;
        } else {
          bestBuf = null;
        }
      }
    });

  const { pre, nonceOffset } = buildPreimageStatic(
    seedBuf,
    minerBuf,
    headerBuf
  );

  const BATCH = Math.max(10_000, Math.min(400_000, batch || 100_000));
  const nonceB = Buffer.allocUnsafe(16);
  randomBytes(16).copy(nonceB);
  let attempts = 0;
  let last = Date.now();

    for (;;) {
    for (let i = 0; i < BATCH; i++) {
      inc128BE(nonceB);
      nonceB.copy(pre, nonceOffset);

      const h1 = createHash("sha256").update(pre).digest();
      const h2 = createHash("sha256").update(h1).digest();

      attempts++;

      if (h2.compare(targetBuf) <= 0 && (!bestBuf || h2.compare(bestBuf) < 0)) {
        parentPort!.postMessage({
          type: "found",
          nonce: BigInt("0x" + nonceB.toString("hex")).toString(),
          hashHex: h2.toString("hex"),
          wid,
        });
        // gracefully close the worker
        try {
          parentPort!.close();
        } catch {}
        try {
          process.exit(0);
        } catch {}
      }
    }
    const now = Date.now();
    if (now - last >= 500) {
      parentPort!.postMessage({ type: "rate", hps: attempts * 2, wid });
      attempts = 0;
      last = now;
    }
    }
    } catch (e) {
      try {
        parentPort?.postMessage({ type: "error", message: (e as any)?.message || String(e) });
      } catch {}
      try {
        process.exit(1);
      } catch {}
    }
  }


async function mineOneContract(
  mnemonic: string,
  address: string,
  contract: string,
  threads: number,
  astBal: string,
  injBal: bigint,
  contractIndex: number
) {
  let work = await qWork(contract);
  let contest = await qContest(contract);
  if (contest.window_expires_at_secs == 131313) {
    console.log(C.r("Genesis not ready. Skipping."));
    return;
  }

  const expires = Number(
    work.window_expires_at_secs || contest.window_expires_at_secs || 0
  );
  const seedB64 = work.seed!;
  const headerB64 = work.prev_hash!;
  const targetHex = BigInt(work.target!).toString(16).padStart(64, "0");
  let bestHex: string | null = contest.best_hash
    ? Buffer.from(fromBase64(contest.best_hash)).toString("hex")
    : null;

  const seedBuf = Buffer.from(fromBase64(seedB64));
  const headerBuf = Buffer.from(fromBase64(headerB64));
  const minerBuf = canonFromBech32(address);
  const targetBuf = hexTo32BE(targetHex);
  let bestBuf = bestHex ? hexTo32BE(bestHex) : null;

  const height = work.height ?? contest.height ?? "?";

  const cpu = os.cpus()?.length || 1;
  const nWorkers = threads > 0 ? threads : Math.max(1, cpu);
  const baseBatch = 100_000;

  const workers: Worker[] = [];
  const perWorker = new Array(nWorkers).fill(0);
  let found: { nonce: bigint; hashHex: string } = {
    nonce: BigInt(1),
    hashHex: "none",
  };

  // Per-contract state (do not share between contracts)
  let best_addr: string | undefined;
  let finalizeTx: string | undefined;
  let submitTx: string | undefined;

  // Supervisor: spawn workers with restart logic and crash logging
  const compiledWorkerPath = new URL("./dist/miner.js", import.meta.url);
  const useCompiled = fs.existsSync(compiledWorkerPath);
  const cjsWorkerScript = path.join(process.cwd(), "worker_process.cjs");
  const jsWorkerScript = path.join(process.cwd(), "worker_process.js");
  const workerScript = fs.existsSync(cjsWorkerScript)
    ? cjsWorkerScript
    : jsWorkerScript;
  const restartCounts = new Array(nWorkers).fill(0);
  const maxRestarts = Number(process.env.WORKER_MAX_RESTARTS || "3");
  const crashLogPath = path.join(process.cwd(), "logs", "worker_crashes.log");
  try {
    fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
  } catch {}

  function logCrash(entry: Record<string, any>) {
    try {
      fs.appendFileSync(crashLogPath, JSON.stringify(entry) + "\n");
    } catch {}
  }

  function terminateWorker(ww: any) {
    try {
      if (!ww) return;
      if (typeof (ww as any).terminate === 'function') {
        (ww as any).terminate();
        return;
      }
      if (typeof (ww as any).kill === 'function') {
        try { (ww as any).kill('SIGTERM'); } catch { (ww as any).kill?.(); }
        return;
      }
      if (typeof (ww as any).postMessage === 'function') {
        try { (ww as any).postMessage({ type: 'stop' }); } catch {}
        return;
      }
    } catch {}
  }

  function spawnWorker(idx: number) {
    // If a compiled worker (dist/miner.js) exists we still prefer worker_threads for it,
    // otherwise fork a separate child process to isolate crashes.
    if (useCompiled) {
      const payload = {
        seed: Uint8Array.from(seedBuf),
        header: Uint8Array.from(headerBuf),
        minerCanon: Uint8Array.from(minerBuf),
        target: Uint8Array.from(targetBuf),
        best: bestBuf ? Uint8Array.from(bestBuf) : null,
        batch: baseBatch,
        wid: idx,
      } as unknown as WorkerIn;

      const w = new Worker(compiledWorkerPath, { workerData: payload });
      if (DEBUG) console.log(`spawned worker_threads worker ${idx} for contract ${contractIndex}`);
      w.on("message", (m: any) => {
        if (m?.type === "rate") {
          perWorker[m.wid] = m.hps ?? 0;
        } else if (m?.type === "found") {
          found = { nonce: BigInt(m.nonce), hashHex: m.hashHex };
          for (const ww of workers) try { terminateWorker(ww); } catch {}
        } else if (m?.type === "error") {
          console.error(`worker_threads ${idx} error: ${m.message}`);
        }
      });
      w.on("error", (err) => console.error(`worker_threads ${idx} error: ${err?.message ?? err}`));
      w.on("exit", (code: number | null, signal: string | null) => {
        if (DEBUG) console.debug(`worker_threads ${idx} exit code=${code} signal=${signal}`);
        const crashed = (code && code !== 0) || (signal && signal !== null);
        if (crashed) {
          logCrash({ ts: new Date().toISOString(), contractIndex, worker: idx, code, signal, mode: 'worker_threads' });
          if (restartCounts[idx] < maxRestarts) {
            restartCounts[idx]++;
            if (DEBUG) console.debug(`Restarting worker_threads ${idx}`);
            spawnWorker(idx);
          } else console.error(`Worker ${idx} exceeded max restarts`);
        }
      });
      workers[idx] = w as unknown as any;
      return;
    }

    // Fork child-process worker
    const child = fork(workerScript, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    if (DEBUG) console.log(`forked child worker ${idx} pid=${child.pid} for contract ${contractIndex}`);

    child.on('message', (m: any) => {
      if (m?.type === 'rate') {
        perWorker[m.wid] = m.hps ?? 0;
      } else if (m?.type === 'found') {
        found = { nonce: BigInt(m.nonce), hashHex: m.hashHex };
        for (const ww of workers) try { terminateWorker(ww); } catch {}
      } else if (m?.type === 'error') {
        console.error(`Child worker ${idx} error: ${m.message}`);
      }
    });

    child.on('error', (err) => {
      console.error(`Child worker ${idx} process error: ${err?.message ?? err}`);
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (DEBUG) console.debug(`child ${idx} exit code=${code} signal=${signal}`);
      const crashed = (code && code !== 0) || (signal && signal !== null);
      if (crashed) {
        logCrash({ ts: new Date().toISOString(), contractIndex, worker: idx, code, signal, mode: 'child' });
        if (restartCounts[idx] < maxRestarts) {
          restartCounts[idx]++;
          if (DEBUG) console.debug(`Restarting child ${idx} (attempt ${restartCounts[idx]}/${maxRestarts})`);
          spawnWorker(idx);
        } else {
          console.error(`Child worker ${idx} exceeded max restarts (${maxRestarts}); not restarting.`);
        }
      }
    });

    // send initial payload (Buffers will be serialized over IPC)
    child.send({
      seed: seedBuf,
      header: headerBuf,
      minerCanon: minerBuf,
      target: targetBuf,
      best: bestBuf,
      batch: baseBatch,
      wid: idx,
    });

    workers[idx] = child as unknown as any;
  }

  for (let i = 0; i < nWorkers; i++) spawnWorker(i);

  let lastHud = Date.now();
  let lastBestPoll = 0;
  let lastBestHexSent: string | null = bestHex ?? null;

  for (;;) {
    await sleep(250);

    const left = Math.max(0, expires - Math.floor(Date.now() / 1000));
    if (left === 0) {
      for (const ww of workers) {
        try {
          ww.terminate();
        } catch {}
      }
      try {
        const resp = await finalizeWindow(mnemonic, address, contract);
        if (resp) {
          finalizeTx = resp.txHash;
          submitTx = undefined;
        }
      } catch (e: any) {
        finalizeTx = e.message;
      }
      await sleep(FINALIZE_COOLDOWN_MS);
      // Clear HUD for this contract before returning
      clearContractHud(contractIndex);
      return;
    }

    const nowMs = Date.now();
    if (nowMs - lastBestPoll >= BEST_POLL_MS) {
      lastBestPoll = nowMs;
      try {
        const c2 = await qContest(contract);
        const incomingHex = c2.best_hash
          ? Buffer.from(fromBase64(c2.best_hash)).toString("hex")
          : null;
        best_addr = c2.best_miner ? c2.best_miner : undefined;

        if (incomingHex !== lastBestHexSent) {
          lastBestHexSent = incomingHex;

          if (incomingHex) {
            bestHex = incomingHex;
            bestBuf = hexTo32BE(incomingHex);
          } else {
            bestHex = null;
            bestBuf = null;
          }

          for (const w of workers) {
            try {
              w.postMessage({ type: "best", bestHex: incomingHex ?? null });
            } catch {}
          }
        }
      } catch {}
    }

    if (Date.now() - lastHud >= 1000) {
      if (process.env.VERBOSE === "1") {
        console.debug(`Starting HUD publish for contractIndex=${contractIndex} threads=${nWorkers}`);
      }
      const totalHps = perWorker.reduce((a, b) => a + (b ?? 0), 0);
      const astatineTitle =
        `${C.g("Astatine Miner")}  ` +
        `| Address ${C.y(
          address.slice(0, 5) +
            ".." +
            address.slice(address.length - 5, address.length - 1)
        )}  `;

      // Format AST using AST_DECIMALS (default 18). Show human + raw units.
      const astHuman = formatTokenBase(astBal || "0", AST_DECIMALS, 4);
      const astRaw = astBal || "0";
      const balances =
        `AST Balance ${C.b(astHuman)} ${C.dim(`(${astRaw} base)`) }  ` +
        `INJ Balance ${C.y(String((Number(injBal) / 10 ** 18).toFixed(2)))}  `;
      const headerLine =
        `${C.c(`H/s ${totalHps.toLocaleString()}`)}  ` +
        `| Left ${C.r(formatClock(left))}  ` +
        `| Block ${C.g(String(height))}  ` +
        `| Target ${C.dim("0x" + targetHex.slice(0, 8) + "…")}`;

      const infoLine =
        `${"Reward"} ${C.g(
          work.reward
            ? (Number(work.reward) / 10 ** 18).toFixed() + " AST"
            : "?"
        )} | ` +
        `${"Best"} ${C.dim(bestHex ? "0x" + bestHex.slice(0, 8) + "…" : "—")}`;
      const finalizePart = `${"Finalize TX : "} ${
        finalizeTx ? C.dim(finalizeTx) : C.dim("not available")
      } `;
      const submitPart = `${"Mining TX : "} ${
        submitTx ? C.dim(submitTx) : C.dim("not available")
      }  `;
      const currentWinner = `${"Best Miner : "} ${
        best_addr
          ? best_addr == address
            ? C.dim(
                best_addr.slice(0, 5) +
                  "..." +
                  best_addr.slice(best_addr.length - 5, best_addr.length - 1)
              ) + C.g(" (you)")
            : C.dim(
                best_addr.slice(0, 5) +
                  "..." +
                  best_addr.slice(best_addr.length - 5, best_addr.length - 1)
              )
          : C.dim("not available")
      }  `;
      const avg = totalHps / Math.max(1, perWorker.length);

      let workers = [];

      for (let i = 0; i < perWorker.length; i++) {
        const v = perWorker[i] ?? 0;
        const rel = Math.min(1, avg ? v / avg : 0);

        workers.push(
          ` w${i.toString().padStart(2, "0")}: ${bar(rel)} ${C.dim(
            v.toLocaleString() + " H/s"
          )}`
        );
      }

      // Publish per-contract HUD block to the global HUD renderer
      setContractHud(contractIndex, [
        `=== Contract ${contractIndex + 1} (${contract.slice(0, 8)}...) ===`,
        astatineTitle,
        balances,
        headerLine,
        infoLine,
        finalizePart,
        submitPart,
        currentWinner,
        ...workers,
      ]);

      lastHud = Date.now();
    }

    if (found.hashHex !== "none") {
      const freshWork = await qWork(contract);
      const freshContest = await qContest(contract);
      if (!freshWork.seed || !freshWork.prev_hash || !freshWork.target) {
        found.hashHex = "none";
        continue;
      }

      const s2 = Buffer.from(fromBase64(freshWork.seed));
      const h2 = Buffer.from(fromBase64(freshWork.prev_hash));
      const m2 = minerBuf;
      const { pre: pre2, nonceOffset: no2 } = buildPreimageStatic(s2, m2, h2);

      const nonceHex = found.nonce.toString(16).padStart(32, "0");
      Buffer.from(nonceHex, "hex").copy(pre2, no2);

      const f1 = createHash("sha256").update(pre2).digest();
      const f2 = createHash("sha256").update(f1).digest();

      const tgt2 = hexTo32BE(
        BigInt(freshWork.target).toString(16).padStart(64, "0")
      );
      const bst2 = freshContest.best_hash
        ? hexTo32BE(
            Buffer.from(fromBase64(freshContest.best_hash)).toString("hex")
          )
        : null;

      const okTarget = f2.compare(tgt2) <= 0;
      const okBest = !bst2 || f2.compare(bst2) < 0;

      if (!(okTarget && okBest)) {
        found.hashHex = "none";
        continue;
      }

      try {
        const prevHashStr = freshWork.prev_hash as string;
        const resp = await submitSolution(
          mnemonic,
          address,
          contract,
          prevHashStr,
          found.nonce
        );
        if (resp) {
          submitTx = resp.txHash;
        }
      } catch (e: any) {
        submitTx = e.message;
      }
      found.hashHex = "none";
    }
  }
}

async function prompt(question: string) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((res) =>
    rl.question(question, (ans) => {
      rl.close();
      res(ans);
    })
  );
}

async function main() {
  if (!isMainThread) return;

  const args = process.argv.slice(2);
  const idxMnemonic = args.indexOf("--mnemonic");

  const mnemonic =
    idxMnemonic >= 0
      ? args[idxMnemonic + 1]
      : await prompt("12-word mnemonic: ");
  const hd = HDPATH_DEFAULT;
  // Allow controlling threads per contract via env `MINER_THREADS_PER_CONTRACT`.
  // If 0 (default) mineOneContract will use CPU count as before.
  const threads = Number(process.env.MINER_THREADS_PER_CONTRACT || "0");

  if (!mnemonic) return;

  const pk = pkFromMnemonic(mnemonic, hd);
  const address = pk.toBech32();

  const injBalance = await getInjBalance(address);

  if (injBalance < BigInt(1e18)) {
    console.error(C.r("Min 1 INJ required. Exiting..."));
    process.exit(1);
  }

  while (true) {
    const injBal = await getInjBalance(address);
    if (injBal <= BigInt(1e16)) {
      console.clear();
      console.log(
        C.r(
          "Your INJ balance is less than 0.01 INJ, please add at least 1 INJ and reboot the cli."
        )
      );
      process.exit(1);
    }
    const astBal = await getAstBalance(address);
    if (!CONTRACTS || CONTRACTS.length === 0) {
      console.log("Contract(s) not found");
      return;
    }

    // Determine threads allocation per contract.
    const nContracts = CONTRACTS.length;
    let perContractThreads: number[] = [];

    if (threads > 0) {
      // Explicit per-contract override from MINER_THREADS_PER_CONTRACT.
      // Respect TOTAL_THREADS (or CPU count) to avoid oversubscription/crashes.
      const totalAllowed = Number(process.env.TOTAL_THREADS || os.cpus().length) || os.cpus().length;
      const totalRequested = threads * nContracts;
      if (totalRequested > totalAllowed) {
        console.warn(
          `Requested ${totalRequested} threads (MINER_THREADS_PER_CONTRACT=${threads} × ${nContracts}) > TOTAL_THREADS ${totalAllowed}. Redistributing to avoid oversubscription.`
        );
        let base = Math.floor(totalAllowed / nContracts);
        let rem = totalAllowed % nContracts;
        if (base === 0) {
          base = 1;
          rem = 0;
        }
        for (let i = 0; i < nContracts; i++) {
          perContractThreads.push(base + (i < rem ? 1 : 0));
        }
      } else {
        perContractThreads = CONTRACTS.map(() => threads);
      }
    } else {
      // Automatic division using TOTAL_THREADS or CPU count.
      const totalThreads = Number(process.env.TOTAL_THREADS || os.cpus().length) || os.cpus().length;
      let base = Math.floor(totalThreads / nContracts);
      let rem = totalThreads % nContracts;

      if (base === 0) {
        // Not enough threads to give at least one to each contract.
        // Choose to give 1 to each (may oversubscribe) but warn the user.
        console.warn(
          `TOTAL_THREADS (${totalThreads}) < contracts (${nContracts}); assigning 1 thread each (may oversubscribe).`
        );
        base = 1;
        rem = 0;
      }

      for (let i = 0; i < nContracts; i++) {
        perContractThreads.push(base + (i < rem ? 1 : 0));
      }
    }

    // Log allocation
    console.log(`Mining ${nContracts} contract(s) with threads per contract: ${perContractThreads.join(",")}`);

    // Start global HUD renderer
    const hudInterval = setInterval(() => {
      try {
        renderGlobalHUD();
      } catch {}
    }, 1000);

    // Start mining concurrently for all selected contracts with allocated threads.
    const miners = CONTRACTS.map((contract, idx) =>
      mineOneContract(
        mnemonic,
        address,
        contract,
        perContractThreads[idx] ?? 0,
        astBal,
        injBal,
        idx
      )
    );

    // Wait for all miners to finish their current window (they return when finalizeWindow completes),
    // then the outer loop will iterate and start them again.
    await Promise.all(miners);
    clearInterval(hudInterval);
    // clear HUD after miners finish
    renderHUD([]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
