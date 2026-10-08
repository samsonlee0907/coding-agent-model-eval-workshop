#!/usr/bin/env node
import { resolve } from "node:path";
import { loadBenchmarkRuns } from "./portfolio.js";
import { loadLatestEvaluation, writeHtmlComparisonReport, renderLegacyComparisonDetails } from "./html-report.js";
import { readFileSync } from "node:fs";
import type { LlmEvaluationResult } from "./types.js";
import { loadPricingSnapshot, parsePricingSnapshot } from "./pricing.js";
import { evidenceFromRuns, parseReportEvidence } from "./evidence.js";
import { writeReportBundle } from "./publication.js";
import { renderEvidenceReport } from "./report-ui.js";
import { atomicWrite } from "./durable.js";
import { assertCliArguments } from "./cli-arguments.js";

if (process.argv.includes("--help")) {
  console.log("Usage: npm run report:html -- [--runs <run-directory> | --evidence <evidence.json>] [--output <report.html> | --bundle <new-folder>] [--zip] [--publication <manifest.json>] [--evaluation <llm-evaluation.json>] [--pricing <pricing-snapshot.json>]");
} else {
  try {
    assertCliArguments(process.argv.slice(2), {
      "--runs": "value", "--evidence": "value", "--output": "value", "--bundle": "value", "--zip": "switch",
      "--publication": "value", "--evaluation": "value", "--pricing": "value",
    });
    const runsDirectory = resolve(argumentValue("--runs") ?? ".benchmark-runs");
    const singleOutput = argumentValue("--output");
    const evidencePath = argumentValue("--evidence");
    if (evidencePath && (argumentValue("--runs") || argumentValue("--evaluation") || argumentValue("--pricing"))) throw new TypeError("--evidence is already normalized; legacy runs/evaluation/pricing options cannot be combined with it.");
    const outputPath = resolve(singleOutput ?? argumentValue("--bundle") ?? resolve(runsDirectory, "benchmark-report"));
    if (singleOutput && argumentValue("--bundle")) throw new TypeError("Choose single --output or portable --bundle, not both.");
    if (singleOutput && (process.argv.includes("--zip") || argumentValue("--publication"))) throw new TypeError("ZIP and approved previews require the portable --bundle path.");
    const runs = evidencePath ? [] : loadBenchmarkRuns(runsDirectory, { relocateArtifacts: true });
    if (!evidencePath && runs.length === 0) {
      throw new RangeError(`No completed run.json artifacts found under ${runsDirectory}.`);
    }
    const evaluationPath = argumentValue("--evaluation");
    const evaluation: LlmEvaluationResult | null = evaluationPath
      ? (JSON.parse(readFileSync(resolve(evaluationPath), "utf8")) as LlmEvaluationResult)
      : evidencePath ? null : loadLatestEvaluation(runsDirectory);
    const pricingPath = argumentValue("--pricing");
    const pricing = pricingPath ? parsePricingSnapshot(readFileSync(resolve(pricingPath), "utf8")) : evidencePath ? null : loadPricingSnapshot(runsDirectory);
    const evidence = evidencePath ? parseReportEvidence(JSON.parse(readFileSync(resolve(evidencePath), "utf8"))) : evidenceFromRuns(runs);
    const publication = argumentValue("--publication");
    let report: string;
    if (singleOutput) {
      if (evidencePath) atomicWrite(outputPath, renderEvidenceReport(evidence));
      else writeHtmlComparisonReport(runs, outputPath, evaluation, pricing);
      report = outputPath;
    } else {
      report = writeReportBundle(evidence, outputPath, {
        zip: process.argv.includes("--zip"), publication: publication ? JSON.parse(readFileSync(resolve(publication), "utf8")) : undefined,
        details: runs.length ? renderLegacyComparisonDetails(runs, evaluation, pricing) : undefined,
      });
    }
    console.log(JSON.stringify({
      runs: runs.length,
      evaluation: evaluation ? `${evaluation.judge.model} (${evaluation.scores.length} scored)` : "none",
      pricing: pricing ? pricing.refreshedAt : "none",
      report,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value.`);
  }
  return value;
}
