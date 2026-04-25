#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseTrace, EVENT_TYPES } = require("./trace_parser.js");

let failures = 0;

function fail(msg) { console.log(`✗ ${msg}`); failures++; }
function pass(msg) { console.log(`✓ ${msg}`); }
function assert(cond, msg) { if (cond) pass(msg); else fail(msg); }

function setupDir(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d9-test-dir-"));
  const demo = path.join(__dirname, "demo-trace.bin");
  for (let i = 0; i < n; i++) {
    fs.copyFileSync(demo, path.join(dir, `trace-${String(i).padStart(3, "0")}.bin`));
  }
  return dir;
}

function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

async function main() {
  const demoPath = path.join(__dirname, "demo-trace.bin");
  if (!fs.existsSync(demoPath)) { console.error("demo-trace.bin not found"); process.exit(1); }

  // ── Single file path ──
  console.log("\nparseTrace with file path:");
  {
    const trace = await parseTrace(demoPath);
    assert(trace.magic === "D9TF", "file path: returns valid trace");
    assert(trace.events.length > 0, "file path: has events");
    assert(trace.taskSpawnTimes instanceof Map, "file path: taskSpawnTimes is Map");
  }

  // ── Directory: returns merged analysis ──
  console.log("\nparseTrace with directory (merged):");
  {
    const dir = setupDir(3);
    try {
      const a = await parseTrace(dir);
      assert(Array.isArray(a.files), "merged: has files array");
      assert(a.files.length === 3, `merged: 3 files (got ${a.files.length})`);
      assert(Array.isArray(a.workerIds), "merged: has workerIds");
      assert(a.workerIds.length > 0, "merged: has workers");
      assert(a.eventCount > 0, "merged: has eventCount");
      assert(a.workerSpans != null, "merged: has workerSpans");
      assert(a.workerSpans[a.workerIds[0]].polls.length > 0, "merged: has polls");
      assert(a.schedDelays.length > 0, "merged: has schedDelays");
      assert(a.taskSpawnLocs instanceof Map, "merged: taskSpawnLocs is Map");
      assert(a.callframeSymbols instanceof Map, "merged: callframeSymbols is Map");
      assert(a.cpuGroups.length > 0, "merged: has cpuGroups");
      assert(a.queueSamples.length > 0, "merged: has queueSamples");

      // Verify merging: counts should be ~3x single file
      const single = await parseTrace(demoPath);
      const singleEvents = single.events.length;
      assert(a.eventCount >= singleEvents * 2, `merged: eventCount (${a.eventCount}) >= 2x single (${singleEvents})`);
    } finally {
      cleanup(dir);
    }
  }

  // ── Caching ──
  console.log("\nCaching:");
  {
    const dir = setupDir(2);
    try {
      await parseTrace(dir);
      const cacheDir = path.join(dir, ".d9-cache");
      assert(fs.existsSync(cacheDir), "cache: .d9-cache created");
      const cached = fs.readdirSync(cacheDir).filter(f => f.endsWith(".json"));
      assert(cached.length === 2, `cache: 2 files (got ${cached.length})`);

      // Verify NDJSON format
      const firstLine = fs.readFileSync(path.join(cacheDir, cached[0]), "utf8").split("\n")[0];
      const meta = JSON.parse(firstLine);
      assert(meta.t === "m", "cache: first line is metadata");
      assert(Array.isArray(meta.d.workerIds), "cache: has workerIds");

      // Warm run
      const a2 = await parseTrace(dir);
      assert(a2.eventCount > 0, "cache hit: has events");
      assert(a2.taskSpawnLocs instanceof Map, "cache hit: Maps reconstructed");
    } finally {
      cleanup(dir);
    }
  }

  // ── Cache invalidation ──
  console.log("\nCache invalidation:");
  {
    const dir = setupDir(1);
    try {
      await parseTrace(dir);
      const cacheDir = path.join(dir, ".d9-cache");
      const cacheFiles = fs.readdirSync(cacheDir);
      const cp = path.join(cacheDir, cacheFiles[0]);
      const mtimeBefore = fs.statSync(cp).mtimeMs;

      await new Promise(r => setTimeout(r, 50));
      const src = path.join(dir, fs.readdirSync(dir).filter(f => f.endsWith(".bin"))[0]);
      fs.utimesSync(src, new Date(), new Date());

      await parseTrace(dir);
      assert(fs.statSync(cp).mtimeMs > mtimeBefore, "invalidation: cache updated");
    } finally {
      cleanup(dir);
    }
  }

  // ── Force ──
  console.log("\nForce:");
  {
    const dir = setupDir(1);
    try {
      await parseTrace(dir);
      const cacheDir = path.join(dir, ".d9-cache");
      const cp = path.join(cacheDir, fs.readdirSync(cacheDir)[0]);
      const mtimeBefore = fs.statSync(cp).mtimeMs;

      await new Promise(r => setTimeout(r, 50));
      await parseTrace(dir, { force: true });
      assert(fs.statSync(cp).mtimeMs > mtimeBefore, "force: cache rewritten");
    } finally {
      cleanup(dir);
    }
  }

  // ── Sample ──
  console.log("\nSample:");
  {
    const dir = setupDir(10);
    try {
      const a = await parseTrace(dir, { sample: 3 });
      assert(a.files.length === 3, `sample: 3 files (got ${a.files.length})`);
      assert(a.eventCount > 0, "sample: has events");
    } finally {
      cleanup(dir);
    }
  }

  // ── Sample validation ──
  console.log("\nSample validation:");
  {
    const dir = setupDir(3);
    try {
      let threw = false;
      try { await parseTrace(dir, { sample: 0 }); }
      catch (e) { threw = true; assert(e.message.includes("sample"), `sample=0: ${e.message}`); }
      assert(threw, "sample=0: throws");
    } finally {
      cleanup(dir);
    }
  }

  // ── Cache disabled ──
  console.log("\nCache disabled:");
  {
    const dir = setupDir(2);
    try {
      const a = await parseTrace(dir, { cache: false });
      assert(a.eventCount > 0, "no-cache: has events");
      assert(!fs.existsSync(path.join(dir, ".d9-cache")), "no-cache: no .d9-cache");
    } finally {
      cleanup(dir);
    }
  }

  // ── Empty directory ──
  console.log("\nEmpty directory:");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d9-test-empty-"));
    try {
      let threw = false;
      try { await parseTrace(dir); }
      catch (e) { threw = true; assert(e.message.includes("No .bin"), `empty: ${e.message}`); }
      assert(threw, "empty: throws");
    } finally {
      cleanup(dir);
    }
  }

  // ── Progress ──
  console.log("\nProgress:");
  {
    const dir = setupDir(3);
    try {
      const progress = [];
      await parseTrace(dir, { onProgress: p => progress.push(p) });
      assert(progress.length === 3, `progress: 3 calls (got ${progress.length})`);
      assert(progress[0].done === 1, "progress: first done=1");
      assert(progress[2].done === 3, "progress: last done=3");
    } finally {
      cleanup(dir);
    }
  }

  // ── Parallel=false ──
  console.log("\nParallel=false:");
  {
    const dir = setupDir(3);
    try {
      const a = await parseTrace(dir, { parallel: false });
      assert(a.eventCount > 0, "sequential: has events");
    } finally {
      cleanup(dir);
    }
  }

  // ── Atomic writes ──
  console.log("\nAtomic writes:");
  {
    const dir = setupDir(1);
    try {
      await parseTrace(dir);
      const cacheDir = path.join(dir, ".d9-cache");
      const tmps = fs.readdirSync(cacheDir).filter(f => f.endsWith(".tmp"));
      assert(tmps.length === 0, "atomic: no .tmp files");
    } finally {
      cleanup(dir);
    }
  }

  // ── Merged analysis is complete and usable ──
  console.log("\nMerged analysis completeness:");
  {
    const dir = setupDir(2);
    try {
      // Cold
      const a1 = await parseTrace(dir);
      assert(a1.workerSpans[a1.workerIds[0]].polls.length > 0, "cold: polls");
      assert(a1.workerSpans[a1.workerIds[0]].parks.length > 0, "cold: parks");
      assert(a1.workerSpans[a1.workerIds[0]].actives.length > 0, "cold: actives");
      assert(a1.schedDelays.length > 0, "cold: schedDelays");
      assert(a1.taskTimeline.activeTaskSamples.length > 0, "cold: taskTimeline");
      assert(a1.cpuGroups.length > 0, "cold: cpuGroups");
      assert(a1.schedGroups.length > 0, "cold: schedGroups");
      assert(a1.durationMs > 0, "cold: durationMs");

      // Warm (from cache)
      const a2 = await parseTrace(dir);
      assert(a2.eventCount === a1.eventCount, "warm: same eventCount");
      assert(a2.schedDelays.length === a1.schedDelays.length, "warm: same schedDelays count");
    } finally {
      cleanup(dir);
    }
  }

  // ── Polls sorted by time across segments ──
  console.log("\nMerged sort order:");
  {
    const dir = setupDir(3);
    try {
      const a = await parseTrace(dir);
      for (const w of a.workerIds) {
        const polls = a.workerSpans[w].polls;
        for (let i = 1; i < polls.length; i++) {
          if (polls[i].start < polls[i - 1].start) {
            fail(`sort: worker ${w} polls not sorted at index ${i}`);
            break;
          }
        }
      }
      pass("sort: polls sorted by start time across segments");
    } finally {
      cleanup(dir);
    }
  }

  console.log(`\n${failures === 0 ? "✓ All" : "✗ " + failures + " failed,"} directory parsing tests ${failures === 0 ? "passed" : ""}!`);
  if (failures > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
