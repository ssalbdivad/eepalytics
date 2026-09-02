#!/usr/bin/env node
// ROFL2 ("Replay V2") decoder — verified against NA1-5631300987.rofl (patch 16.17.810.4348)
// Usage: node rofl2.mjs <path-to.rofl> [--dump-segments <dir>]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = "RIOT";
const ZSTD_MAGIC = 0xfd2fb528;

/** Walk one zstd frame per RFC 8878 framing; returns the byte offset just past it. */
function zstdFrameEnd(buf, off) {
  if (buf.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`no zstd frame at ${off}`);
  let p = off + 4;
  const fhd = buf[p++];
  const fcsFlag = (fhd >> 6) & 3, singleSegment = (fhd >> 5) & 1;
  const hasChecksum = (fhd >> 2) & 1, dictIdFlag = fhd & 3;
  if (!singleSegment) p += 1;                 // Window_Descriptor
  p += [0, 1, 2, 4][dictIdFlag];              // Dictionary_ID
  let fcsSize = [0, 2, 4, 8][fcsFlag];
  if (fcsFlag === 0 && singleSegment) fcsSize = 1;
  p += fcsSize;                               // Frame_Content_Size
  for (;;) {                                  // Blocks
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
    p += 3;
    p += type === 1 ? 1 : size;               // RLE block is 1 byte
    if (last) break;
  }
  if (hasChecksum) p += 4;
  return p;
}

export function parseRofl(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4).toString("latin1") !== MAGIC) throw new Error("not a RIOT replay");
  const formatVersion = buf.readUInt16LE(4);
  if (formatVersion !== 2) throw new Error(`unsupported ROFL format version ${formatVersion}`);

  // --- header ---
  const networkProtocolDigest = buf.subarray(6, 14);          // u64, compared client<->replay
  const gameVersionLen = buf[14];
  const gameVersion = buf.subarray(15, 15 + gameVersionLen).toString("latin1");
  const segStart = 15 + gameVersionLen;                       // 0x1D for a 14-char version

  // --- trailer: u32 LE length of the JSON metadata blob, at EOF ---
  const metaLen = buf.readUInt32LE(buf.length - 4);
  const metaOff = buf.length - 4 - metaLen;
  const metadata = JSON.parse(buf.subarray(metaOff, buf.length - 4).toString("utf8"));
  const stats = JSON.parse(metadata.statsJson);              // array of per-player stat maps

  // --- segment table: 17-byte descriptor followed immediately by its payload ---
  const SEG_TYPE = { 1: "chunk", 2: "keyframe", 3: "manifest", 4: "chunk" };
  const segments = [];
  let p = segStart;
  let sawLastChunk = false, sawLastKeyframe = false;
  while (p + 17 <= metaOff && !(sawLastChunk && sawLastKeyframe)) {
    const id       = buf.readUInt32LE(p);
    const nextId   = buf.readUInt32LE(p + 4);
    const type     = buf[p + 8];
    const decLen   = buf.readUInt32LE(p + 9);
    const compLen  = buf.readUInt32LE(p + 13);
    const dataOff  = p + 17;
    let payloadEnd, data;
    if (compLen === 0) {                     // stored uncompressed (observed only for type 4)
      payloadEnd = dataOff + decLen;
      data = buf.subarray(dataOff, payloadEnd);
    } else {
      payloadEnd = zstdFrameEnd(buf, dataOff);
      if (payloadEnd - dataOff !== compLen) throw new Error(`compLen mismatch at ${p}`);
      data = zlib.zstdDecompressSync(buf.subarray(dataOff, payloadEnd));
      if (data.length !== decLen) throw new Error(`decLen mismatch at ${p}`);
    }
    // Payload byte 0 is a record tag; bytes 1..4 are a float32 LE game time in seconds.
    const gameTimeSec = data.length >= 5 ? data.readFloatLE(1) : null;
    segments.push({
      kind: SEG_TYPE[type] ?? `unknown(${type})`,
      type, id, nextId, decLen, compLen,
      descOffset: p, dataOffset: dataOff, gameTimeSec, data,
    });
    if ((type === 1 || type === 4) && id === metadata.lastGameChunkId) sawLastChunk = true;
    if (type === 2 && id === metadata.lastKeyFrameId) sawLastKeyframe = true;
    p = payloadEnd;
  }

  const signature = buf.subarray(p, metaOff);   // 256 bytes observed => RSA-2048

  return {
    file,
    // gameId is NOT stored inside the file; it comes from the "<platformId>-<gameId>.rofl" name
    platformId: path.basename(file).split("-")[0],
    gameId: Number(path.basename(file, ".rofl").split("-")[1]),
    formatVersion,
    gameVersion,
    networkProtocolDigestHex: networkProtocolDigest.toString("hex"),
    networkProtocolDigestLE: networkProtocolDigest.readBigUInt64LE(0).toString(16).padStart(16, "0"),
    gameLengthMs: metadata.gameLength,
    lastGameChunkId: metadata.lastGameChunkId,
    lastKeyFrameId: metadata.lastKeyFrameId,
    stats, segments, signature, metaOffset: metaOff, metaLength: metaLen,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = parseRofl(process.argv[2]);
  const chunks = r.segments.filter(s => s.kind === "chunk");
  const kfs = r.segments.filter(s => s.kind === "keyframe");
  console.log({
    platformId: r.platformId, gameId: r.gameId, gameVersion: r.gameVersion,
    formatVersion: r.formatVersion,
    networkProtocolDigest: r.networkProtocolDigestHex + " (u64 LE 0x" + r.networkProtocolDigestLE + ")",
    gameLengthMs: r.gameLengthMs, gameLengthMin: +(r.gameLengthMs / 60000).toFixed(2),
    lastGameChunkId: r.lastGameChunkId, lastKeyFrameId: r.lastKeyFrameId,
    segments: r.segments.length, chunks: chunks.length, keyframes: kfs.length,
    signatureBytes: r.signature.length,
    metaOffset: r.metaOffset, metaLength: r.metaLength,
    players: r.stats.length, statFieldsPerPlayer: Object.keys(r.stats[0]).length,
  });
  console.log("\nScoreboard:");
  for (const p of r.stats) {
    console.log(
      `${(p.RIOT_ID_GAME_NAME + "#" + p.RIOT_ID_TAG_LINE).padEnd(24)} ` +
      `${p.SKIN.padEnd(14)} team=${p.TEAM} ${p.TEAM_POSITION.padEnd(8)} ` +
      `${p.CHAMPIONS_KILLED}/${p.NUM_DEATHS}/${p.ASSISTS} cs=${p.MINIONS_KILLED} ` +
      `gold=${p.GOLD_EARNED} vs=${p.VISION_SCORE} ${p.WIN}`);
  }
  const dumpIdx = process.argv.indexOf("--dump-segments");
  if (dumpIdx > 0) {
    const dir = process.argv[dumpIdx + 1];
    fs.mkdirSync(dir, { recursive: true });
    for (const s of r.segments)
      fs.writeFileSync(path.join(dir, `${s.kind}_${String(s.id).padStart(3, "0")}.bin`), s.data);
    console.log(`\nwrote ${r.segments.length} segment payloads to ${dir}`);
  }
}
