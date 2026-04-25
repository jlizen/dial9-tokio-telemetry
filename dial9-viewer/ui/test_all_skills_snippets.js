#!/usr/bin/env node
"use strict";
// Extracts code blocks from skills files and runs each one against the demo trace.
// Catches regressions where a recipe references a stale API.

const fs = require("fs");
const path = require("path");

const skillsDir = path.resolve(__dirname, "..", "skills");
const demoPath = path.join(__dirname, "demo-trace.bin");

// Parse markdown: extract ```javascript blocks with their heading
function extractRecipes(md, filename) {
  const recipes = [];
  let currentHeading = "(preamble)";
  let inBlock = false;
  let block = "";

  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      currentHeading = line.slice(3).trim();
    } else if (line.startsWith("```javascript")) {
      inBlock = true;
      block = "";
    } else if (line.startsWith("```") && inBlock) {
      inBlock = false;
      recipes.push({ heading: `${filename}: ${currentHeading}`, code: block });
    } else if (inBlock) {
      block += line + "\n";
    }
  }
  return recipes;
}

// Skip blocks that aren't runnable
function shouldSkip(recipe) {
  const code = recipe.code.trim();
  if (code.includes("{ ... }") || code === "..." || code === "") return true;
  if (recipe.heading.includes("Setup boilerplate")) return true;
  if (recipe.heading.includes("Working with large directories")) return true;
  // Skip pure structure/type definitions
  if (/^\{\s*\n\s*(events|workerSpans|eventType|timestamp):/.test(code)) return true;
  // Skip S3 examples (need a running server)
  if (code.includes("localhost:3000")) return true;
  return false;
}

// Replace placeholder values with real ones so examples are runnable
function fixPlaceholders(code, tracePath) {
  return code
    .replace(/['"]\/path\/to\/traces?\/['"]/g, JSON.stringify(tracePath))
    .replace(/['"]\/path\/to\/trace\.bin['"]/g, JSON.stringify(tracePath))
    .replace(/['"]trace\.bin['"]/g, JSON.stringify(tracePath));
}

async function main() {
  // Collect recipes from all skills markdown files
  const mdFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith(".md"));
  let allRecipes = [];
  for (const f of mdFiles) {
    const md = fs.readFileSync(path.join(skillsDir, f), "utf8");
    allRecipes.push(...extractRecipes(md, f));
  }

  console.log(`Found ${allRecipes.length} code blocks across ${mdFiles.length} skills files\n`);

  const { parseTrace, EVENT_TYPES, formatFrame, symbolizeChain, deduplicateSamples } = require("./trace_parser.js");
  const { buildWorkerSpans, attachCpuSamples, buildActiveTaskTimeline,
          computeSchedulingDelays, filterPointsOfInterest, buildFgData,
          buildSpanData } = require("./trace_analysis.js");

  // Create a temp directory for directory-mode testing
  const os = require("os");
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "d9-recipe-test-"));
  fs.copyFileSync(demoPath, path.join(testDir, "t1.bin"));
  fs.copyFileSync(demoPath, path.join(testDir, "t2.bin"));

  const inputs = [
    { label: "file", path: demoPath },
    { label: "dir", path: testDir },
  ];

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const input of inputs) {
    console.log(`── ${input.label}: ${input.path} ──\n`);

    // Run the prelude to get the variables every recipe expects
    let trace, workerIds, minTs, maxTs, spans, schedDelays, taskTimeline;
    for await (const t of parseTrace(input.path)) {
      trace = t;
      workerIds = [...new Set(
        trace.events.filter(e => e.eventType !== EVENT_TYPES.QueueSample && e.eventType !== EVENT_TYPES.WakeEvent)
          .map(e => e.workerId)
      )].sort((a, b) => a - b);
      maxTs = trace.events.reduce((m, e) => Math.max(m, e.timestamp), -Infinity);
      minTs = trace.events.reduce((m, e) => Math.min(m, e.timestamp), Infinity);
      spans = buildWorkerSpans(trace.events, workerIds, maxTs);
      attachCpuSamples(trace.cpuSamples, spans.workerSpans);
      taskTimeline = buildActiveTaskTimeline(trace.taskSpawnTimes, trace.taskTerminateTimes);
      schedDelays = computeSchedulingDelays(spans.workerSpans, workerIds, spans.wakesByTask);
      break; // use first trace for prelude variables
    }

    // Context: all variables available to code blocks
    const { analyzeTraces } = require(path.resolve(__dirname, '..', 'skills', 'analyze.js'));
    const ctx = {
      trace, workerIds, minTs, maxTs, spans, schedDelays, taskTimeline,
      EVENT_TYPES, formatFrame, symbolizeChain, deduplicateSamples,
      buildWorkerSpans, attachCpuSamples, buildActiveTaskTimeline,
      computeSchedulingDelays, filterPointsOfInterest, buildFgData, buildSpanData,
      require, console, parseTrace, fs, path,
      event: trace.events[0],
      sample: trace.cpuSamples[0] || {},
      tracePath: input.path,
      analyzeTraces,
    };
    const ctxNames = Object.keys(ctx);
    const ctxValues = Object.values(ctx);

  for (const recipe of allRecipes) {
    if (shouldSkip(recipe)) {
      if (input === inputs[0]) skipped++;
      continue;
    }

    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));

    try {
      // Strip require() lines (already provided via context) and
      // convert const redeclarations of context vars to assignments
      const cleanCode = recipe.code
        .split("\n")
        .filter(line => !line.match(/^\s*const\s*\{.*\}\s*=\s*require\(/))
        .map(line => {
          for (const v of ctxNames) {
            if (new RegExp(`^(\\s*)const\\s+${v}\\s*=`).test(line))
              return line.replace(/const\s+/, '');
          }
          return line;
        })
        .join("\n");

      const body = `return (async () => { ${fixPlaceholders(cleanCode, input.path)} })();`;
      const fn = new Function(...ctxNames, body);
      await fn(...ctxValues);
      console.log = origLog;
      passed++;
    } catch (err) {
      console.log = origLog;
      origLog(`✗ [${input.label}] ${recipe.heading}: ${err.message}`);
      failed++;
    }
  }
  } // end inputs loop

  fs.rmSync(testDir, { recursive: true, force: true });

  // ── Schema sync: analysis.md documents every analyzeTraces key and vice versa ──
  const { analyzeTraces: at } = require(path.resolve(__dirname, '..', 'skills', 'analyze.js'));
  const result = await at(demoPath);
  const actualKeys = new Set(Object.keys(result));

  const analysisMd = fs.readFileSync(path.join(skillsDir, "analysis.md"), "utf8");
  const schemaMatch = analysisMd.match(/## analyzeTraces return schema[\s\S]*?```\n\{([\s\S]*?)\n\}[\s\S]*?```/);
  if (!schemaMatch) {
    console.log("✗ schema sync: could not find analyzeTraces return schema block in analysis.md");
    failed++;
  } else {
    // Top-level keys are at exactly 2-space indent (not deeper)
    const docKeys = new Set(schemaMatch[1].match(/^ {2}(\w+):/gm).map(m => m.trim().replace(/:$/, '')));
    const undocumented = [...actualKeys].filter(k => !docKeys.has(k));
    const stale = [...docKeys].filter(k => !actualKeys.has(k));
    if (undocumented.length > 0 || stale.length > 0) {
      if (undocumented.length) console.log(`✗ schema sync: keys in analyzeTraces but not in analysis.md: ${undocumented.join(', ')}`);
      if (stale.length) console.log(`✗ schema sync: keys in analysis.md but not in analyzeTraces: ${stale.join(', ')}`);
      failed++;
    } else {
      console.log(`✓ schema sync: analysis.md matches analyzeTraces (${docKeys.size} keys)`);
      passed++;
    }
  }

  const unique = allRecipes.filter(r => !shouldSkip(r)).length;
  console.log(`\n${failed === 0 ? "✓" : "✗"} ${unique} snippets × ${inputs.length} modes: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
