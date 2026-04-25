#!/usr/bin/env node
// accumulate_worker.js — reads a cached ParsedTrace, runs analysis, outputs partial accumulator as JSON.
// Usage: node accumulate_worker.js <cache-file>
// Outputs a single JSON line to stdout with the partial accumulator.

const fs = require('fs');
const path = require('path');

function resolve(name) {
  const sibling = path.resolve(__dirname, name);
  if (fs.existsSync(sibling)) return sibling;
  return path.resolve(__dirname, '..', 'ui', name);
}

const { EVENT_TYPES, deduplicateSamples } = require(resolve('trace_parser.js'));
const { buildWorkerSpans, attachCpuSamples, buildActiveTaskTimeline,
        computeSchedulingDelays, buildSpanData } = require(resolve('trace_analysis.js'));

// Read NDJSON cache file into ParsedTrace
function loadCache(cachePath) {
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
  let raw = null;
  const events = [], cpuSamples = [], customEvents = [];
  let line;
  while ((line = nextLine()) !== null) {
    if (!line) continue;
    const rec = JSON.parse(line);
    switch (rec.t) {
      case 'm':
        raw = rec.d;
        // Reconstruct Maps
        for (const k of ['spawnLocations','taskSpawnLocs','taskSpawnTimes','taskTerminateTimes','callframeSymbols','threadNames','runtimeWorkers']) {
          if (raw[k]) raw[k] = new Map(raw[k]);
        }
        break;
      case 'e': events.push(rec.d); break;
      case 'c': cpuSamples.push(rec.d); break;
      case 'x': customEvents.push(rec.d); break;
    }
  }
  raw.events = events;
  raw.cpuSamples = cpuSamples;
  raw.customEvents = customEvents;
  return raw;
}

function mapToEntries(m) { return m instanceof Map ? [...m.entries()] : m; }

const cachePath = process.argv[2];
if (!cachePath) { process.stderr.write('Usage: node accumulate_worker.js <cache-file>\n'); process.exit(1); }

const trace = loadCache(cachePath);

// Run analysis
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

// Build partial accumulator (no histograms, just raw values)
const partial = {
  workerIds,
  minTs, maxTs,
  eventCount: trace.events.length,
  cpuSampleCount: trace.cpuSamples.length,
  onCpuSampleCount: onCpu.length,
  offCpuSampleCount: offCpu.length,
  taskSpawnCount: trace.taskSpawnTimes.size,
  taskAliveAtEnd: trace.taskSpawnTimes.size - trace.taskTerminateTimes.size,
  maxLocalQueue: spans.maxLocalQueue,

  // Per-worker stats
  workerStats: {},

  // Top 100 long polls
  longPolls: [],

  // Queue depth
  queueMax: 0, queueSum: 0, queueCount: 0,

  // Sched delays: count + top worst + all delay values for histogram
  schedDelayTotal: schedDelays.length,
  schedDelayHighCount: 0,
  schedDelayWorst: [],
  schedDelayValues: schedDelays.map(sd => Math.max(1, Math.round(sd.delay))),

  // Task timeline
  taskTimelineSamples: taskTimeline.activeTaskSamples,

  // Maps as entries
  taskSpawnLocs: mapToEntries(trace.taskSpawnLocs),
  taskSpawnTimes: mapToEntries(trace.taskSpawnTimes),
  taskTerminateTimes: mapToEntries(trace.taskTerminateTimes),
  callframeSymbols: mapToEntries(trace.callframeSymbols),

  // Sample groups
  cpuGroups: deduplicateSamples(onCpu, trace.callframeSymbols),
  schedGroups: deduplicateSamples(offCpu, trace.callframeSymbols),

  // Poll durations by location: {loc: [dur, dur, ...]}
  pollDurationsByLoc: {},

  // Span durations: {name: [dur, dur, ...]}
  spanDurations: {},
};

// Per-worker stats
for (const w of workerIds) {
  const s = spans.workerSpans[w];
  const ws = { activeNs: 0, parkNs: 0, ratioSum: 0, activeCount: 0, pollCount: s.polls.length, parkCount: s.parks.length, schedWaits: [] };
  for (const a of s.actives) { ws.activeNs += a.end - a.start; ws.ratioSum += a.ratio; ws.activeCount++; }
  for (const p of s.parks) { ws.parkNs += p.end - p.start; if (p.schedWait > 0) ws.schedWaits.push(p.schedWait); }
  partial.workerStats[w] = ws;

  for (const p of s.polls) {
    const dur = p.end - p.start;
    const loc = p.spawnLoc || '(unknown)';
    (partial.pollDurationsByLoc[loc] || (partial.pollDurationsByLoc[loc] = [])).push(Math.max(1, Math.round(dur)));
    if (dur > 1e6) partial.longPolls.push({ dur, poll: p, worker: w });
  }
}
partial.longPolls.sort((a, b) => b.dur - a.dur);
partial.longPolls.length = Math.min(partial.longPolls.length, 100);

// Queue depth
for (const q of spans.queueSamples) {
  if (q.global > partial.queueMax) partial.queueMax = q.global;
  partial.queueSum += q.global;
  partial.queueCount++;
}

// Sched delay worst
for (const sd of schedDelays) {
  if (sd.delay > 1e6) {
    partial.schedDelayHighCount++;
    partial.schedDelayWorst.push(sd);
  }
}
partial.schedDelayWorst.sort((a, b) => b.delay - a.delay);
partial.schedDelayWorst.length = Math.min(partial.schedDelayWorst.length, 100);

// Span durations
if (trace.customEvents && trace.customEvents.length > 0) {
  const { spansByWorker } = buildSpanData(trace.customEvents);
  for (const ss of Object.values(spansByWorker)) {
    for (const s of ss) {
      (partial.spanDurations[s.spanName] || (partial.spanDurations[s.spanName] = [])).push(Math.max(1, Math.round(s.end - s.start)));
    }
  }
}

// Write to stdout as a single line
process.stdout.write(JSON.stringify(partial) + '\n');
