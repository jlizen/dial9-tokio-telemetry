#!/usr/bin/env node
// parse_worker.js — child process worker for parallel trace parsing.
// Spawned by parseTrace() when processing directories.
// Usage: node parse_worker.js <trace-file> <cache-path>
//
// Parses the trace and writes the full ParsedTrace as NDJSON to cache.
// Each line is a tagged JSON record so no single line exceeds V8's string limit.
//
// NDJSON tags:
//   m  = metadata (scalar fields, Maps as [k,v] arrays)
//   e  = event (one per line)
//   c  = CPU sample (one per line)
//   x  = custom event (one per line)

const fs = require('fs');
const path = require('path');

function resolve(name) {
  const sibling = path.resolve(__dirname, name);
  if (fs.existsSync(sibling)) return sibling;
  return path.resolve(__dirname, '..', 'ui', name);
}

const { parseTrace } = require(resolve('trace_parser.js'));

function mapToEntries(m) {
  if (!(m instanceof Map)) return m;
  return [...m.entries()];
}

async function main() {
  const traceFile = process.argv[2];
  const cachePath = process.argv[3];
  if (!traceFile || !cachePath) {
    process.stderr.write('Usage: node parse_worker.js <trace-file> <cache-path>\n');
    process.exit(1);
  }

  const trace = await parseTrace(fs.readFileSync(traceFile));

  const tmpPath = cachePath + '.tmp';
  const stream = fs.createWriteStream(tmpPath);

  function writeLine(obj) {
    stream.write(JSON.stringify(obj) + '\n');
  }

  // Metadata line
  writeLine({ t: 'm', d: {
    magic: trace.magic,
    version: trace.version,
    truncated: trace.truncated,
    timeFiltered: trace.timeFiltered,
    filterStartTime: trace.filterStartTime,
    filterEndTime: trace.filterEndTime,
    hasCpuTime: trace.hasCpuTime,
    hasSchedWait: trace.hasSchedWait,
    hasTaskTracking: trace.hasTaskTracking,
    spawnLocations: mapToEntries(trace.spawnLocations),
    taskSpawnLocs: mapToEntries(trace.taskSpawnLocs),
    taskSpawnTimes: mapToEntries(trace.taskSpawnTimes),
    taskTerminateTimes: mapToEntries(trace.taskTerminateTimes),
    callframeSymbols: mapToEntries(trace.callframeSymbols),
    threadNames: mapToEntries(trace.threadNames),
    runtimeWorkers: mapToEntries(trace.runtimeWorkers),
    clockSyncAnchors: trace.clockSyncAnchors,
    clockOffsetNs: trace.clockOffsetNs,
  }});

  // Events, CPU samples, custom events (one per line)
  for (const e of trace.events) writeLine({ t: 'e', d: e });
  for (const s of trace.cpuSamples) writeLine({ t: 'c', d: s });
  if (trace.customEvents) {
    for (const x of trace.customEvents) writeLine({ t: 'x', d: x });
  }

  await new Promise((resolve, reject) => {
    stream.end(() => {
      fs.renameSync(tmpPath, cachePath);
      resolve();
    });
    stream.on('error', reject);
  });
  process.stdout.write('OK\n');
}

main().catch(err => { process.stderr.write(err.stack + '\n'); process.exit(1); });
