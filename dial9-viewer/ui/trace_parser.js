// trace_parser.js - Binary trace parser using dial9-trace-format decoder
// Can be used in browser or Node.js

(function (exports) {
  "use strict";

  const MAX_EVENTS = Infinity; // no cap — use time range filtering for large traces

  function getTraceDecoder() {
    if (typeof require !== "undefined") {
      const path = require("path");
      return require(path.resolve(__dirname, "decode.js")).TraceDecoder;
    }
    // Browser: decode.js must be loaded before this script
    if (typeof TraceDecoder !== "undefined") return TraceDecoder;
    throw new Error(
      "TraceDecoder not found. Load decode.js before trace_parser.js"
    );
  }

  /** Parse a string/bigint/number to a JS number */
  function num(v) {
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "string" && v !== "")
      if (!isNaN(Number(v))) return Number(v);

    throw new Error(`Invalid number: ${v}`);
  }

  /** Decompress gzip data if detected, otherwise return as-is. */
  async function maybeGunzip(buf) {
    const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    if (b.length < 2 || b[0] !== 0x1f || b[1] !== 0x8b) {
      return buf;
    }
    if (typeof DecompressionStream !== "undefined") {
      return await new Response(
        new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))
      ).arrayBuffer();
    }
    // Fallback for older Node.js without DecompressionStream
    const zlib = require("zlib");
    const decompressed = zlib.gunzipSync(Buffer.from(b));
    return decompressed.buffer.slice(
      decompressed.byteOffset,
      decompressed.byteOffset + decompressed.byteLength
    );
  }

  /**
   * @typedef {{
   *   eventType: number,
   *   timestamp: number,
   *   workerId: number,
   *   localQueue: number,
   *   globalQueue: number,
   *   cpuTime: number,
   *   schedWait: number,
   *   taskId: number,
   *   spawnLocId: string|null,
   *   spawnLoc: string|null,
   *   wakerTaskId?: number,
   *   wokenTaskId?: number,
   *   targetWorker?: number,
   * }} TraceEvent
   */

  /**
   * @typedef {{
   *   timestamp: number,
   *   workerId: number,
   *   tid: number,
   *   source: number,
   *   callchain: string[],
   * }} CpuSample
   */

  /**
   * @typedef {{ symbol: string, location: string|null }} SymbolFrame
   */

  /**
   * @typedef {{
   *   magic: "D9TF",
   *   version: number,
   *   events: TraceEvent[],
   *   truncated: boolean,
   *   hasCpuTime: boolean,
   *   hasSchedWait: boolean,
   *   hasTaskTracking: boolean,
   *   spawnLocations: Map<string, string>,
   *   taskSpawnLocs: Map<number, string|null>,
   *   taskSpawnTimes: Map<number, number>,
   *   taskTerminateTimes: Map<number, number>,
   *   cpuSamples: CpuSample[],
   *   callframeSymbols: Map<string, SymbolFrame|SymbolFrame[]>,
   *   threadNames: Map<number, string>,
   *   runtimeWorkers: Map<string, number[]>,
   * }} ParsedTrace
   */

  const EVENT_TYPES = {
    PollStart: 0,
    PollEnd: 1,
    WorkerPark: 2,
    WorkerUnpark: 3,
    QueueSample: 4,
    WakeEvent: 9,
  };

  /**
   * Parse dial9 trace data from a buffer, file path, or directory.
   *
   * - Buffer/ArrayBuffer/Uint8Array: parses the binary trace data directly.
   * - String (file path): reads the file and parses it (Node.js only).
   * - String (directory path): parses all .bin/.bin.gz files in the directory
   *   with automatic caching and parallelism. Returns an async iterable of
   *   {file, trace} objects (Node.js only).
   *
   * File and directory paths are Node-only. In the browser, fetch trace data
   * via the viewer API (e.g. /api/trace) and pass the ArrayBuffer directly.
   *
   * @param {ArrayBuffer|Uint8Array|string} input - Binary data, file path, or directory path
   * @param {Object} [options] - Optional parsing options
   * @param {number} [options.maxEvents] - Maximum number of events to parse (default: Infinity)
   * @param {number} [options.startTime] - Start of time range filter (absolute ns, inclusive)
   * @param {number} [options.endTime] - End of time range filter (absolute ns, inclusive)
   * @param {function} [options.onProgress] - Called with {bytesRead, totalBytes, eventCount} periodically
   * @param {boolean} [options.cache] - Enable disk caching for directories (default: true)
   * @param {boolean} [options.parallel] - Enable parallel parsing for directories (default: auto based on file count)
   * @param {boolean} [options.force] - Ignore cached results and re-parse (default: false)
   * @param {number} [options.sample] - Only parse N evenly-spaced files from a directory
   * @returns {Promise<ParsedTrace>|AsyncIterable<{file: string, trace: ParsedTrace}>}
   */
  async function parseTrace(input, options) {
    if (typeof input === 'string') {
      if (typeof require === 'undefined') {
        throw new Error(
          'File/directory paths require Node.js. In the browser, fetch trace ' +
          'data via the viewer API (e.g. /api/trace) and pass the ArrayBuffer ' +
          'to parseTrace().'
        );
      }
      const fs = require('fs');
      const stat = fs.statSync(input);
      if (stat.isDirectory()) {
        return parseTraceDir(input, options);
      }
      return parseTraceBuffer(fs.readFileSync(input), options);
    }
    return parseTraceBuffer(input, options);
  }

  /** @private Parse a binary trace buffer. */
  async function parseTraceBuffer(buffer, options) {
    buffer = await maybeGunzip(buffer);
    const maxEvents = (options && options.maxEvents != null) ? options.maxEvents : MAX_EVENTS;
    const startTime = (options && options.startTime != null) ? options.startTime : 0;
    const endTime = (options && options.endTime != null) ? options.endTime : Infinity;
    const onProgress = (options && options.onProgress) || null;
    const YIELD_BYTES = 100 * 1024; // yield to browser every 100KB
    const TD = getTraceDecoder();
    const dec = new TD(
      buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
    );
    if (!dec.decodeHeader()) throw new Error("Invalid trace header");
    const totalBytes = dec.byteLength;

    const events = [];
    const spawnLocations = new Map();
    const taskSpawnLocs = new Map();
    const taskSpawnTimes = new Map();
    const taskTerminateTimes = new Map();
    const callframeSymbols = new Map();
    const cpuSamples = [];
    const threadNames = new Map();
    const runtimeWorkers = new Map(); // runtime name → [workerId, ...]
    const customEvents = []; // unrecognized event types: {name, timestamp, fields}
    // { monotonicNs, realtimeNs } anchors used to recover wall clock.
    const clockSyncAnchors = [];
    // Legacy classifier: epoch ns are ~1e18, monotonic ns are much smaller.
    // 2020 is a practical floor that separates those ranges.
    const LEGACY_EPOCH_FLOOR_MS = 1_577_836_800_000; // 2020-01-01
    let legacySegmentMetaWallNs = null;
    // Smallest monotonic ts seen across all event frames.
    // Used as the monotonic timestamp for the legacy synthesized anchor.
    let minMonoTs = null;

    const capped = () => events.length >= maxEvents;
    const UNCAPPED_FRAMES = new Set([
      "TaskSpawnEvent",
      "TaskTerminateEvent",
      "CpuSampleEvent",
      "SymbolTableEntry",
      "SegmentMetadataEvent",
      "ClockSyncEvent",
    ]);

    let lastYieldPos = 0;
    let frame;
    while ((frame = dec.nextFrame()) !== null) {
      // Yield to browser periodically so spinner can update
      if (onProgress && dec.position - lastYieldPos >= YIELD_BYTES) {
        lastYieldPos = dec.position;
        onProgress({ bytesRead: dec.position, totalBytes, eventCount: events.length });
        await new Promise((r) => setTimeout(r, 0));
      }

      if (frame.type !== "event") continue;
      const v = frame.values;
      const ts = num(frame.timestamp_ns);
      // Track smallest monotonic ts for legacy anchor synthesis.
      // Skip SegmentMetadata (legacy wall clock) and SymbolTableEntry.
      if (
        ts != null &&
        frame.name !== "SegmentMetadataEvent" &&
        frame.name !== "SymbolTableEntry" &&
        (minMonoTs == null || ts < minMonoTs)
      ) {
        minMonoTs = ts;
      }

      if (capped() && !UNCAPPED_FRAMES.has(frame.name)) continue;

      // Time range filtering: skip events outside the requested range
      // (uncapped frames like symbols/metadata are always processed)
      const inTimeRange = ts >= startTime && ts <= endTime;
      if (!inTimeRange && !UNCAPPED_FRAMES.has(frame.name)) continue;

      switch (frame.name) {
        case "PollStartEvent": {
          const spawnLoc = v.spawn_loc || null;
          if (spawnLoc) spawnLocations.set(spawnLoc, spawnLoc);
          const taskId = num(v.task_id);
          if (taskId && spawnLoc && !taskSpawnLocs.has(taskId)) {
            taskSpawnLocs.set(taskId, spawnLoc);
          }
          events.push({
            eventType: 0,
            timestamp: ts,
            workerId: num(v.worker_id),
            localQueue: num(v.local_queue),
            globalQueue: 0,
            cpuTime: 0,
            schedWait: 0,
            taskId,
            spawnLocId: spawnLoc,
            spawnLoc,
          });
          break;
        }
        case "PollEndEvent":
          events.push({
            eventType: 1,
            timestamp: ts,
            workerId: num(v.worker_id),
            globalQueue: 0,
            localQueue: 0,
            cpuTime: 0,
            schedWait: 0,
            taskId: 0,
            spawnLocId: null,
            spawnLoc: null,
          });
          break;
        case "WorkerParkEvent":
          events.push({
            eventType: 2,
            timestamp: ts,
            workerId: num(v.worker_id),
            localQueue: num(v.local_queue),
            cpuTime: num(v.cpu_time_ns),
            globalQueue: 0,
            schedWait: 0,
            taskId: 0,
            spawnLocId: null,
            spawnLoc: null,
          });
          break;
        case "WorkerUnparkEvent":
          events.push({
            eventType: 3,
            timestamp: ts,
            workerId: num(v.worker_id),
            localQueue: num(v.local_queue),
            cpuTime: num(v.cpu_time_ns),
            schedWait: num(v.sched_wait_ns),
            globalQueue: 0,
            taskId: 0,
            spawnLocId: null,
            spawnLoc: null,
          });
          break;
        case "QueueSampleEvent":
          events.push({
            eventType: 4,
            timestamp: ts,
            globalQueue: num(v.global_queue),
            workerId: 0,
            localQueue: 0,
            cpuTime: 0,
            schedWait: 0,
            taskId: 0,
            spawnLocId: null,
            spawnLoc: null,
          });
          break;
        case "TaskSpawnEvent": {
          const taskId = num(v.task_id);
          const spawnLoc = v.spawn_loc || null;
          if (spawnLoc) spawnLocations.set(spawnLoc, spawnLoc);
          taskSpawnLocs.set(taskId, spawnLoc);
          taskSpawnTimes.set(taskId, ts);
          break;
        }
        case "TaskTerminateEvent":
          taskTerminateTimes.set(num(v.task_id), ts);
          break;
        case "WakeEventEvent":
          events.push({
            eventType: 9,
            timestamp: ts,
            workerId: num(v.target_worker),
            wakerTaskId: num(v.waker_task_id),
            wokenTaskId: num(v.woken_task_id),
            targetWorker: num(v.target_worker),
            globalQueue: 0,
            localQueue: 0,
            cpuTime: 0,
            schedWait: 0,
            taskId: 0,
            spawnLocId: null,
            spawnLoc: null,
          });
          break;
        case "CpuSampleEvent": {
          const chain = (v.callchain || []).map(
            (addr) => "0x" + BigInt(addr).toString(16)
          );
          cpuSamples.push({
            timestamp: ts,
            workerId: num(v.worker_id),
            tid: num(v.tid),
            source: num(v.source),
            callchain: chain,
          });
          const tn = v.thread_name;
          if (tn) {
            threadNames.set(num(v.tid), tn);
          }
          break;
        }
        case "ClockSyncEvent": {
          const real = num(v.realtime_ns);
          if (real > 0) {
            clockSyncAnchors.push({ monotonicNs: ts, realtimeNs: real });
          }
          break;
        }
        case "SegmentMetadataEvent": {
          // If this looks epoch-scale, treat it as legacy wall clock.
          if (
            legacySegmentMetaWallNs == null &&
            ts != null &&
            ts / 1e6 >= LEGACY_EPOCH_FLOOR_MS
          ) {
            legacySegmentMetaWallNs = ts;
          }
          const entries = v.entries || {};
          for (const [key, val] of Object.entries(entries)) {
            if (key.startsWith("runtime.")) {
              const name = key.slice("runtime.".length);
              const ids = val
                .split(",")
                .map(Number)
                .filter((n) => !isNaN(n));
              if (ids.length > 0) runtimeWorkers.set(name, ids);
            }
          }
          break;
        }
        case "SymbolTableEntry": {
          const addrKey = "0x" + BigInt(v.addr).toString(16);
          const depth = Number(v.inline_depth || 0);
          const sf = v.source_file || "";
          const sl = Number(v.source_line || 0);
          const location = sf ? (sl ? `${sf}:${sl}` : sf) : null;
          const entry = { symbol: v.symbol_name, location };
          if (depth === 0) {
            // Outermost frame: store directly (or as first element of array)
            const existing = callframeSymbols.get(addrKey);
            if (Array.isArray(existing)) {
              existing[0] = entry;
            } else {
              callframeSymbols.set(addrKey, entry);
            }
          } else {
            // Inlined frame: promote to array
            let arr = callframeSymbols.get(addrKey);
            if (!Array.isArray(arr)) {
              arr = [arr || { symbol: addrKey, location: null }];
              callframeSymbols.set(addrKey, arr);
            }
            arr[depth] = entry;
          }
          break;
        }
        default: {
          // Unrecognized event type: capture as a custom event
          if (ts != null) {
            customEvents.push({
              name: frame.name,
              timestamp: ts,
              fields: v,
            });
          }
          break;
        }
      }
    }

    // Legacy fallback: synthesize an anchor from legacy SegmentMetadata wall
    // time + earliest monotonic event timestamp. This is best-effort only.
    if (
      clockSyncAnchors.length === 0 &&
      legacySegmentMetaWallNs != null &&
      minMonoTs != null
    ) {
      clockSyncAnchors.push({
        monotonicNs: minMonoTs,
        realtimeNs: legacySegmentMetaWallNs,
      });
    }

    clockSyncAnchors.sort((a, b) => {
      if (a.monotonicNs < b.monotonicNs) return -1;
      if (a.monotonicNs > b.monotonicNs) return 1;
      return 0;
    });

    let clockOffsetNs = null;
    if (clockSyncAnchors.length > 0) {
      const a0 = clockSyncAnchors[0];
      clockOffsetNs = a0.realtimeNs - a0.monotonicNs;
    }
    const hasTimeFilter = startTime > 0 || endTime < Infinity;

    return {
      magic: "D9TF",
      version: dec.version,
      events,
      truncated: events.length >= maxEvents,
      timeFiltered: hasTimeFilter,
      filterStartTime: hasTimeFilter ? startTime : null,
      filterEndTime: hasTimeFilter ? endTime : null,
      hasCpuTime: true,
      hasSchedWait: true,
      hasTaskTracking: true,
      spawnLocations,
      taskSpawnLocs,
      taskSpawnTimes,
      cpuSamples,
      callframeSymbols,
      threadNames,
      taskTerminateTimes,
      runtimeWorkers,
      customEvents,
      clockSyncAnchors,
      clockOffsetNs,
    };
  }

  // ── Directory parsing (Node-only) ──

  /** Reconstruct Maps from [key, value] arrays produced by analyze_worker.js. */
  function entriesToMap(arr) {
    return new Map(arr);
  }

  /** Load cached analysis results from NDJSON, reconstructing Maps. */
  function loadCachedAnalysis(cachePath) {
    const fs = require('fs');
    const buf = fs.readFileSync(cachePath);
    let pos = 0;
    function nextLine() {
      const nl = buf.indexOf(10, pos);
      if (nl === -1) {
        if (pos < buf.length) { const s = buf.toString('utf8', pos, buf.length); pos = buf.length; return s; }
        return null;
      }
      const s = buf.toString('utf8', pos, nl);
      pos = nl + 1;
      return s;
    }

    const result = {
      workerSpans: {},
      schedDelays: [],
      cpuGroups: [],
      schedGroups: [],
    };

    let line;
    while ((line = nextLine()) !== null) {
      if (!line) continue;
      const rec = JSON.parse(line);
      switch (rec.t) {
        case 'm': {
          const d = rec.d;
          if (d.taskSpawnLocs) d.taskSpawnLocs = entriesToMap(d.taskSpawnLocs);
          if (d.taskSpawnTimes) d.taskSpawnTimes = entriesToMap(d.taskSpawnTimes);
          if (d.taskTerminateTimes) d.taskTerminateTimes = entriesToMap(d.taskTerminateTimes);
          if (d.callframeSymbols) d.callframeSymbols = entriesToMap(d.callframeSymbols);
          Object.assign(result, d);
          break;
        }
        case 'w':
          result.workerSpans[rec.k] = rec.d;
          break;
        case 'q':
          result.queueSamples = rec.d;
          break;
        case 'wt':
          result.wakesByTask = rec.d;
          break;
        case 'ww':
          result.wakesByWorker = rec.d;
          break;
        case 'tt':
          result.taskTimeline = rec.d;
          break;
        case 'sd':
          result.schedDelays.push(rec.d);
          break;
        case 'cg':
          result.cpuGroups.push(rec.d);
          break;
        case 'sg':
          result.schedGroups.push(rec.d);
          break;
        case 'sp':
          result.spanData = rec.d;
          break;
      }
    }
    return result;
  }

  /**
   * Parse all trace files in a directory with caching and parallelism.
   * Workers do parse + analysis. Cache holds pre-computed analysis results.
   * Returns {files, [Symbol.asyncIterator]} where each item is {file, analysis}.
   * @private
   */
  function parseTraceDir(dirPath, options) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { execFile } = require('child_process');

    const opts = options || {};
    const useCache = opts.cache !== false;
    const force = opts.force === true;
    const sampleN = opts.sample != null ? opts.sample : null;
    const onProgress = opts.onProgress || null;

    const TRACE_EXT = /\.(bin|bin\.gz)$/;
    let files = fs.readdirSync(dirPath)
      .filter(f => TRACE_EXT.test(f))
      .sort();

    if (files.length === 0) {
      throw new Error(`No .bin or .bin.gz files found in ${dirPath}`);
    }

    if (sampleN != null) {
      if (sampleN < 1) throw new Error('sample must be >= 1');
      if (sampleN < files.length) {
        const step = files.length / sampleN;
        const sampled = [];
        for (let i = 0; i < sampleN; i++) {
          sampled.push(files[Math.floor(i * step)]);
        }
        files = sampled;
      }
    }

    const cacheDir = path.join(dirPath, '.d9-cache');
    if (useCache) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const concurrency = (opts.parallel === false) ? 1 : os.cpus().length;
    const workerCandidate = path.resolve(__dirname, 'analyze_worker.js');
    const workerFallback = path.resolve(__dirname, '..', 'skills', 'analyze_worker.js');
    const workerScript = fs.existsSync(workerCandidate) ? workerCandidate : workerFallback;

    function cachePathFor(file) {
      return path.join(cacheDir, file.replace(TRACE_EXT, '') + '.json');
    }

    function isCacheValid(file) {
      if (!useCache || force) return false;
      const cp = cachePathFor(file);
      try {
        const cacheStat = fs.statSync(cp);
        const srcStat = fs.statSync(path.join(dirPath, file));
        return cacheStat.mtimeMs > srcStat.mtimeMs;
      } catch { return false; }
    }

    // Process one file. Cold: subprocess does parse+analyze+cache. Warm: read cache in-process.
    function processFile(file) {
      if (isCacheValid(file)) {
        // Warm: read pre-computed NDJSON analysis results line-by-line
        return Promise.resolve({ file, analysis: loadCachedAnalysis(cachePathFor(file)) });
      }
      // Cold: subprocess does parse + full analysis + writes cache
      return new Promise((resolve, reject) => {
        const tracePath = path.join(dirPath, file);
        const cp = useCache ? cachePathFor(file) : path.join(os.tmpdir(), 'd9-' + process.pid + '-' + file + '.json');
        const args = [workerScript, tracePath, cp];
        execFile(process.execPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`Failed to process ${file}: ${stderr || err.message}`));
            return;
          }
          try {
            const analysis = loadCachedAnalysis(cp);
            if (!useCache) try { fs.unlinkSync(cp); } catch {}
            resolve({ file, analysis });
          } catch (e) {
            reject(new Error(`Failed to load results for ${file}: ${e.message}`));
          }
        });
      });
    }

    // Run all files through a concurrency-limited pool
    if (onProgress) onProgress({ done: 0, total: files.length, file: null });
    const resultsPromise = new Promise((resolve, reject) => {
      const results = new Array(files.length);
      let nextIdx = 0;
      let completed = 0;
      let active = 0;
      let failed = false;

      function dispatch() {
        while (active < concurrency && nextIdx < files.length) {
          const i = nextIdx++;
          active++;
          processFile(files[i]).then(result => {
            if (failed) return;
            results[i] = result;
            completed++;
            active--;
            if (onProgress) onProgress({ done: completed, total: files.length, file: files[i] });
            if (completed === files.length) {
              resolve(results);
            } else {
              dispatch();
            }
          }, err => {
            if (failed) return;
            failed = true;
            reject(err);
          });
        }
      }
      dispatch();
    });

    // Merge all per-file analysis results into a single combined object.
    // Process one file at a time so each file's analysis can be GC'd after merging.
    return resultsPromise.then(results => {
      const merged = {
        files: files,
        workerIds: [],
        minTs: Infinity,
        maxTs: -Infinity,
        durationMs: 0,
        eventCount: 0,
        cpuSampleCount: 0,
        onCpuSampleCount: 0,
        offCpuSampleCount: 0,
        taskSpawnCount: 0,
        taskAliveAtEnd: 0,
        maxLocalQueue: 0,
        workerSpans: {},
        queueSamples: [],
        wakesByTask: {},
        wakesByWorker: {},
        schedDelays: [],
        taskTimeline: { activeTaskSamples: [], taskFirstPoll: new Map() },
        taskSpawnLocs: new Map(),
        taskSpawnTimes: new Map(),
        taskTerminateTimes: new Map(),
        callframeSymbols: new Map(),
        cpuGroups: new Map(), // leaf -> group, finalized to array at end
        schedGroups: new Map(),
        spanData: null,
      };

      const seenWorkers = new Set();

      for (let i = 0; i < results.length; i++) {
        const a = results[i].analysis;
        results[i] = null; // allow GC

        // Scalars
        for (const w of a.workerIds) seenWorkers.add(w);
        if (a.minTs < merged.minTs) merged.minTs = a.minTs;
        if (a.maxTs > merged.maxTs) merged.maxTs = a.maxTs;
        merged.eventCount += a.eventCount;
        merged.cpuSampleCount += a.cpuSampleCount;
        merged.onCpuSampleCount += a.onCpuSampleCount;
        merged.offCpuSampleCount += a.offCpuSampleCount;
        merged.taskSpawnCount += a.taskSpawnCount;
        merged.taskAliveAtEnd += a.taskAliveAtEnd;
        if (a.maxLocalQueue > merged.maxLocalQueue) merged.maxLocalQueue = a.maxLocalQueue;

        // WorkerSpans: push into accumulator
        for (const w of Object.keys(a.workerSpans)) {
          const dst = merged.workerSpans[w] || (merged.workerSpans[w] = { polls: [], parks: [], actives: [], cpuSampleTimes: [] });
          const src = a.workerSpans[w];
          if (src.polls) for (const p of src.polls) dst.polls.push(p);
          if (src.parks) for (const p of src.parks) dst.parks.push(p);
          if (src.actives) for (const p of src.actives) dst.actives.push(p);
          if (src.cpuSampleTimes) for (const t of src.cpuSampleTimes) dst.cpuSampleTimes.push(t);
        }

        // Simple arrays
        if (a.queueSamples) for (const q of a.queueSamples) merged.queueSamples.push(q);
        if (a.schedDelays) for (const sd of a.schedDelays) merged.schedDelays.push(sd);
        if (a.taskTimeline && a.taskTimeline.activeTaskSamples) {
          for (const s of a.taskTimeline.activeTaskSamples) merged.taskTimeline.activeTaskSamples.push(s);
        }

        // Wakes
        for (const [k, v] of Object.entries(a.wakesByTask || {})) {
          const dst = merged.wakesByTask[k] || (merged.wakesByTask[k] = []);
          for (const w of v) dst.push(w);
        }
        for (const [k, v] of Object.entries(a.wakesByWorker || {})) {
          const dst = merged.wakesByWorker[k] || (merged.wakesByWorker[k] = []);
          for (const w of v) dst.push(w);
        }

        // Maps
        if (a.taskSpawnLocs) for (const [k, v] of a.taskSpawnLocs) merged.taskSpawnLocs.set(k, v);
        if (a.taskSpawnTimes) for (const [k, v] of a.taskSpawnTimes) merged.taskSpawnTimes.set(k, v);
        if (a.taskTerminateTimes) for (const [k, v] of a.taskTerminateTimes) merged.taskTerminateTimes.set(k, v);
        if (a.callframeSymbols) for (const [k, v] of a.callframeSymbols) merged.callframeSymbols.set(k, v);

        // Sample groups: merge by leaf
        for (const g of (a.cpuGroups || [])) {
          const existing = merged.cpuGroups.get(g.leaf);
          if (existing) existing.count += g.count;
          else merged.cpuGroups.set(g.leaf, { ...g });
        }
        for (const g of (a.schedGroups || [])) {
          const existing = merged.schedGroups.get(g.leaf);
          if (existing) existing.count += g.count;
          else merged.schedGroups.set(g.leaf, { ...g });
        }
      }

      // Finalize
      merged.workerIds = [...seenWorkers].sort((a, b) => a - b);
      merged.durationMs = (merged.maxTs - merged.minTs) / 1e6;

      // Sort merged arrays
      for (const w of Object.keys(merged.workerSpans)) {
        merged.workerSpans[w].polls.sort((a, b) => a.start - b.start);
        merged.workerSpans[w].parks.sort((a, b) => a.start - b.start);
        merged.workerSpans[w].actives.sort((a, b) => a.start - b.start);
        merged.workerSpans[w].cpuSampleTimes.sort((a, b) => a - b);
      }
      merged.queueSamples.sort((a, b) => a.t - b.t);
      merged.schedDelays.sort((a, b) => a.wakeTime - b.wakeTime);
      merged.taskTimeline.activeTaskSamples.sort((a, b) => a.t - b.t);

      // Finalize groups to sorted arrays
      merged.cpuGroups = [...merged.cpuGroups.values()].sort((a, b) => b.count - a.count);
      merged.schedGroups = [...merged.schedGroups.values()].sort((a, b) => b.count - a.count);

      return merged;
    });
  }

  // ── Symbol formatting utilities ──

  function _stripBoringGenerics(s) {
    const boring = /^[A-Z]$|^(Fut|Req|Res|Bs|InnerFuture)$/;
    return s.replace(/<([^<>]*)>/g, (match, inner) => {
      const params = inner.split(",").map((p) => p.trim());
      if (params.every((p) => boring.test(p))) return "";
      const kept = params.filter((p) => !boring.test(p));
      return kept.length ? `<${kept.join(",")}>` : "";
    });
  }

  function _lastSeg(s) {
    return s.split("::").pop();
  }

  function _shortenPath(s) {
    const parts = s.split("::");
    let closures = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] === "{{closure}}") closures++;
      else break;
    }
    const meaningful = parts.length - closures;
    if (meaningful <= 3) return s;
    return parts.slice(meaningful - 3).join("::");
  }

  /**
   * Try to build a docs.rs source link from a location path containing a crate-version segment.
   * Matches any path like: .../hyper-0.14.28/src/client/connect/http.rs:474
   * Returns URL string or null.
   */
  function _docsRsUrl(location) {
    if (!location) return null;
    const m = location.match(
      /\/([a-z][a-z0-9_-]*)-(\d+\.\d+[^/]*)\/(.+?)(?::(\d+))?$/
    );
    if (!m) return null;
    const [, crate_, version, rawPath, line] = m;
    const crateSrc = crate_.replace(/-/g, "_");
    const path = rawPath.replace(/^src\//, "");
    let url = `https://docs.rs/${crate_}/${version}/src/${crateSrc}/${path}.html`;
    if (line) url += `#${line}`;
    return url;
  }

  /**
   * Extract just the filename from a location string.
   * e.g. "/home/user/.cargo/registry/src/.../hyper-0.14.28/src/client/connect/http.rs:474" → "http.rs"
   */
  function _fileName(location) {
    if (!location) return null;
    const m = location.match(/([^/]+\.rs)(?::\d+)?$/);
    return m ? m[1] : null;
  }

  /**
   * Format a stack frame for human-readable display.
   * Accepts either a resolved frame object or a raw address + callframeSymbols map.
   * @param {{symbol: string, location: string|null}|string} frame - Resolved frame or address string
   * @param {Map<string, {symbol: string, location: string|null}>} [callframeSymbols] - Required when frame is an address string
   * @returns {{text: string, docsUrl: string|null}}
   */
  function formatFrame(frame, callframeSymbols) {
    if (typeof frame === "string") {
      if (!callframeSymbols)
        throw new Error(
          "formatFrame requires callframeSymbols when given an address string"
        );
      const entry = callframeSymbols.get(frame);
      if (!entry) return { text: frame || "(unknown)", docsUrl: null };
      frame = Array.isArray(entry) ? entry[0] : entry;
    }
    const { symbol: sym, location } = frame;
    if (!sym || sym.startsWith("0x"))
      return { text: sym || "(unknown)", docsUrl: null };

    let result = sym;
    const traitImplMatch = result.match(/^<(.+?) as (.+?)>::(.+)$/);
    if (traitImplMatch) {
      let [, implType, trait_, method] = traitImplMatch;
      const shortType = _lastSeg(_stripBoringGenerics(implType));
      result =
        shortType.length <= 2
          ? `${_lastSeg(_stripBoringGenerics(trait_))}::${method}`
          : `${shortType}::${method}`;
    } else if (result.includes("::")) {
      result = _shortenPath(_stripBoringGenerics(result));
    }

    const fileName = _fileName(location);
    if (location) {
      const m = location.match(/:(\d+)$/);
      if (m) result += ` ${fileName || ""}:${m[1]}`;
    }
    return { text: result, docsUrl: _docsRsUrl(location) };
  }

  /**
   * Resolve a callchain (array of address strings) to frame objects.
   * When an address has inlined frames (stored as an array in callframeSymbols),
   * they are expanded in place (outermost first, then inlined callees).
   * @param {string[]} callchain - Address strings like "0x55cc6d053893"
   * @param {Map<string, {symbol: string, location: string|null}|Array>} callframeSymbols
   * @returns {{symbol: string, location: string|null}[]}
   */
  function symbolizeChain(callchain, callframeSymbols) {
    const result = [];
    for (const addr of callchain) {
      const entry = callframeSymbols.get(addr);
      if (!entry) {
        result.push({ symbol: addr, location: null });
        continue;
      }
      if (Array.isArray(entry)) {
        for (const e of entry) result.push(e);
        continue;
      }
      if (typeof entry === "string") {
        result.push({ symbol: entry, location: null });
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  /**
   * Deduplicate CPU/sched samples by symbolized stack trace.
   * @param {Object[]} samples - Array of {callchain, ...} sample objects
   * @param {Map} callframeSymbols
   * @returns {{count: number, frames: Object[], leaf: string, leafRaw: string}[]}
   */
  function deduplicateSamples(samples, callframeSymbols) {
    const groups = new Map();
    for (const sample of samples) {
      const frames = symbolizeChain(sample.callchain, callframeSymbols);
      const key = frames.map((f) => f.symbol).join("\0");
      if (!groups.has(key)) {
        groups.set(key, {
          count: 0,
          frames,
          leaf: frames[0] ? formatFrame(frames[0]).text : "(unknown)",
          leafRaw: frames[0] ? frames[0].symbol : "",
        });
      }
      groups.get(key).count++;
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
  }

  // Export for both browser and Node.js
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      EVENT_TYPES,
      parseTrace,
      formatFrame,
      symbolizeChain,
      deduplicateSamples,
    };
  } else {
    exports.TraceParser = {
      EVENT_TYPES,
      parseTrace,
      formatFrame,
      symbolizeChain,
      deduplicateSamples,
    };
  }
})(typeof exports === "undefined" ? this : exports);
