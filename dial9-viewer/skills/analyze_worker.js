#!/usr/bin/env node
// analyze_worker.js — child process worker for parallel trace analysis.
// Spawned by parseTrace() when processing directories.
// Usage: node analyze_worker.js <trace-file> <cache-path>
//
// Parses trace, runs analysis pipeline, writes results as NDJSON to cache.
// Each line is a tagged JSON record. No single line exceeds a few MB,
// avoiding V8's string size limit regardless of trace size.
//
// NDJSON tags:
//   m  = metadata (scalar fields, Maps as [k,v] arrays)
//   w  = per-worker spans (polls, parks, actives, cpuSampleTimes)
//   q  = queue samples array
//   wt = wakesByTask object
//   ww = wakesByWorker object
//   tt = task timeline
//   sd = scheduling delay (one per line)
//   cg = CPU sample group (one per line)
//   sg = sched sample group (one per line)
//   sp = span data

const fs = require('fs');
const path = require('path');

function resolve(name) {
  const sibling = path.resolve(__dirname, name);
  if (fs.existsSync(sibling)) return sibling;
  return path.resolve(__dirname, '..', 'ui', name);
}

const { parseTrace, EVENT_TYPES, deduplicateSamples } = require(resolve('trace_parser.js'));
const { buildWorkerSpans, attachCpuSamples, buildActiveTaskTimeline,
        computeSchedulingDelays, buildSpanData } = require(resolve('trace_analysis.js'));

function mapToEntries(m) {
  if (!(m instanceof Map)) return m;
  return [...m.entries()];
}

async function main() {
  const traceFile = process.argv[2];
  const cachePath = process.argv[3];
  if (!traceFile || !cachePath) {
    process.stderr.write('Usage: node analyze_worker.js <trace-file> <cache-path>\n');
    process.exit(1);
  }

  const buf = fs.readFileSync(traceFile);
  const trace = await parseTrace(buf);

  // Run analysis pipeline
  const workerIds = [...new Set(
    trace.events.filter(e => e.eventType !== EVENT_TYPES.QueueSample && e.eventType !== EVENT_TYPES.WakeEvent)
      .map(e => e.workerId)
  )].sort((a, b) => a - b);

  const minTs = trace.events.reduce((m, e) => Math.min(m, e.timestamp), Infinity);
  const maxTs = trace.events.reduce((m, e) => Math.max(m, e.timestamp), -Infinity);

  const spans = buildWorkerSpans(trace.events, workerIds, maxTs);
  attachCpuSamples(trace.cpuSamples, spans.workerSpans);
  const taskTimeline = buildActiveTaskTimeline(trace.taskSpawnTimes, trace.taskTerminateTimes);
  const schedDelays = computeSchedulingDelays(spans.workerSpans, workerIds, spans.wakesByTask);

  const onCpu = trace.cpuSamples.filter(s => s.source === 0);
  const offCpu = trace.cpuSamples.filter(s => s.source === 1);
  const cpuGroups = deduplicateSamples(onCpu, trace.callframeSymbols);
  const schedGroups = deduplicateSamples(offCpu, trace.callframeSymbols);

  let spanData = null;
  if (trace.customEvents && trace.customEvents.length > 0) {
    spanData = buildSpanData(trace.customEvents);
  }

  // Write NDJSON to cache
  const tmpPath = cachePath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');

  function writeLine(obj) {
    fs.writeSync(fd, JSON.stringify(obj) + '\n');
  }

  // Metadata
  writeLine({ t: 'm', d: {
    workerIds, minTs, maxTs,
    durationMs: (maxTs - minTs) / 1e6,
    eventCount: trace.events.length,
    cpuSampleCount: trace.cpuSamples.length,
    onCpuSampleCount: onCpu.length,
    offCpuSampleCount: offCpu.length,
    taskSpawnCount: trace.taskSpawnTimes.size,
    taskAliveAtEnd: trace.taskSpawnTimes.size - trace.taskTerminateTimes.size,
    maxLocalQueue: spans.maxLocalQueue,
    taskSpawnLocs: mapToEntries(trace.taskSpawnLocs),
    taskSpawnTimes: mapToEntries(trace.taskSpawnTimes),
    taskTerminateTimes: mapToEntries(trace.taskTerminateTimes),
    callframeSymbols: mapToEntries(trace.callframeSymbols),
  }});

  // Per-worker spans (one line per worker)
  for (const w of workerIds) {
    writeLine({ t: 'w', k: w, d: spans.workerSpans[w] });
  }

  // Queue samples
  writeLine({ t: 'q', d: spans.queueSamples });

  // Wakes (one line each, may be large but per-task/per-worker chunks are bounded)
  writeLine({ t: 'wt', d: spans.wakesByTask });
  writeLine({ t: 'ww', d: spans.wakesByWorker });

  // Task timeline
  writeLine({ t: 'tt', d: taskTimeline });

  // Scheduling delays (one per line)
  for (const sd of schedDelays) {
    writeLine({ t: 'sd', d: sd });
  }

  // CPU groups (one per line)
  for (const g of cpuGroups) {
    writeLine({ t: 'cg', d: g });
  }

  // Sched groups (one per line)
  for (const g of schedGroups) {
    writeLine({ t: 'sg', d: g });
  }

  // Span data
  if (spanData) {
    writeLine({ t: 'sp', d: spanData });
  }

  fs.closeSync(fd);
  fs.renameSync(tmpPath, cachePath);
  process.stdout.write('OK\n');
}

main().catch(err => { process.stderr.write(err.stack + '\n'); process.exit(1); });
