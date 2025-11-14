const { randomBytes, createHash } = require('crypto');

function inc128BE(buf) {
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

function buildPreimageStatic(seed, miner, header) {
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

process.on('message', (payload) => {
  try {
    const { seed, header, minerCanon, target, best, batch, wid } = payload;

    const seedBuf = Buffer.from(seed);
    const headerBuf = Buffer.from(header);
    const minerBuf = Buffer.from(minerCanon);
    const targetBuf = Buffer.from(target);
    const bestBuf = best ? Buffer.from(best) : null;

    const { pre, nonceOffset } = buildPreimageStatic(seedBuf, minerBuf, headerBuf);
    const BATCH = Math.max(10000, Math.min(400000, batch || 100000));
    const nonceB = Buffer.allocUnsafe(16);
    randomBytes(16).copy(nonceB);
    let attempts = 0;
    let last = Date.now();

    for (;;) {
      for (let i = 0; i < BATCH; i++) {
        inc128BE(nonceB);
        nonceB.copy(pre, nonceOffset);
        const h1 = createHash('sha256').update(pre).digest();
        const h2 = createHash('sha256').update(h1).digest();

        attempts++;
        if (h2.compare(targetBuf) <= 0 && (!bestBuf || h2.compare(bestBuf) < 0)) {
          process.send({ type: 'found', nonce: BigInt('0x' + nonceB.toString('hex')).toString(), hashHex: h2.toString('hex'), wid });
          process.exit(0);
        }
      }
      const now = Date.now();
      if (now - last >= 500) {
        process.send({ type: 'rate', hps: attempts * 2, wid });
        attempts = 0;
        last = now;
      }
    }
  } catch (e) {
    try {
      process.send({ type: 'error', message: e && e.message ? e.message : String(e) });
    } catch {}
    process.exit(1);
  }
});

// keep the process alive until we receive payload
