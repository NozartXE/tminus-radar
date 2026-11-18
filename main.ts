// T-Minus entrypoint. Reads the sealed snapshot, builds the radar (value curve
// plus launch clock), and assembles board.json, the dashboard data, the page,
// the screenshots and the canonical dossier in the output directory. Runs on
// Node 22 with the standard library only, no network, and writes the same
// bytes on every run. Outside the grader:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repositoryDir = fileURLToPath(new URL('.', import.meta.url));
const imageNamePattern = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read --name value or --name=value, then use the fallback. */
function argument(name: string, fallback: string): string {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]!;
  const equalsForm = process.argv.find((value) => value.startsWith(`${flag}=`));
  return equalsForm === undefined ? fallback : equalsForm.slice(flag.length + 1);
}

/** Resolve a JSON filename or a directory containing snapshot.json. */
function snapshotPath(value: string): string {
  return value.endsWith('.json') ? value : join(value, 'snapshot.json');
}

const requestedInput = argument('input', process.env.MAKEFUN_INPUT_DIR ?? '/input');
const inputFile = snapshotPath(requestedInput);
if (!existsSync(inputFile)) {
  process.stderr.write(`t-minus: no snapshot at ${inputFile}\n`);
  process.exit(2);
}

const outputDir = argument('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (typeof issue === 'string') {
  process.stderr.write(`${issue}\n`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

/** Copy visible regular files directly inside a repository asset directory. */
function copyRegularFiles(sourceDir: string, destinationDir: string): string[] {
  if (!existsSync(sourceDir)) return [];
  mkdirSync(destinationDir, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(sourceDir)) {
    if (name.startsWith('.')) continue;
    const source = join(sourceDir, name);
    if (!lstatSync(source).isFile()) continue;
    copyFileSync(source, join(destinationDir, name));
    copied.push(name);
  }
  return copied;
}

copyRegularFiles(join(repositoryDir, 'dashboard'), join(outputDir, 'dashboard'));
const screenshots = copyRegularFiles(join(repositoryDir, 'screenshots'), join(outputDir, 'screenshots'));
if (screenshots.length < 3) {
  process.stderr.write(`t-minus: copied ${screenshots.length} screenshots; at least 3 are required\n`);
  process.exit(1);
}
for (const name of screenshots) {
  if (!imageNamePattern.test(name)) {
    process.stderr.write(`t-minus: invalid screenshot filename: ${name}\n`);
    process.exit(1);
  }
}

// Written last: the scorer rebuilds the dossier from the finished output.
writeFileSync(
  join(outputDir, 'dossier.json'),
  buildDossier(outputDir, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  }),
);

process.stdout.write(
  `t-minus: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} board rows (${radar.early_size} early, ${radar.live_size} above the floor)\n` +
    `t-minus: value model ${radar.model.kind} (LOO median miss ${Number(radar.validation.looMedianMiss).toFixed(2)}x), launch clock on ${radar.clock.population} protocols (CV AUC ${Number(radar.clock.cv_auc).toFixed(2)})\n` +
    `t-minus: wrote board.json, data.js, dashboard/, screenshots/ (${screenshots.length} files) and dossier.json\n`,
);
