# Draft issues for morluto/rea (not posted)

Found while analyzing a large production Electron app (41 MB `app.asar`, 595 JavaScript files) and its Linux cloud image with rea-agents 6.3.0 on macOS 26.5.1 (arm64), Node 24.16.0, Ghidra 12.1.4. No target code is attached; each issue names the file by size and SHA-256 so it can be reproduced against the public build.

## 1. `analyze_javascript_application` fails with `RangeError: Set maximum size exceeded` on one minified vendor bundle

- **What happens.** Analysis returns `execution_failure` with `error_name: "RangeError"`, `error_message: "Set maximum size exceeded"`. The same file analyzed alone in a directory with only `package.json` reproduces it (453 s, 6.2 GB RSS). The rest of the app (518 files) analyzes in 45 s without it.
- **File.** `dist/renderer/assets/index.eager-vendor-DwFd2u6y.js`, 527,008 bytes (a Vite vendor chunk: React and friends).
- **Expected.** A bounded limitation and partial coverage, as for other budgets, not a failed analysis.
- **Note.** 6.2.0 completed the full app including this file.

## 2. `analyze_javascript_application` exhausts the default Node heap on large apps and takes the MCP server down

- **What happens.** With the default heap (about 4 GB) the server dies with `FATAL ERROR: Ineffective mark-compacts near heap limit` on file 591 of 595; MCP clients see `Connection closed`. With `NODE_OPTIONS=--max-old-space-size=16384` peak RSS was about 9.3 GB.
- **Ask.** Document the memory needed for large applications, or have `rea setup` offer a heap setting; ideally fail with a typed `resource_constraint` instead of a process crash.

## 3. `capture_electron_scenario` crashes the server when the app disables Node inspector fuses

- **What happens.** For a packaged app with `EnableNodeCliInspectArguments` disabled, Playwright's Electron launch waits 60 s and throws `TimeoutError: Timeout 59765ms exceeded` from `playwright-core/lib/server/progress.js`. The error is not caught: the CLI exits 1 with a raw stack and the MCP server process exits (`Connection closed`).
- **Expected.** A typed failure that names the likely cause (inspector fuse disabled), owned-process cleanup, and a live server. A preflight that reads the Electron fuse wire would let rea explain this before launching.

## 4. Electron and runtime observation skip pages loaded from inside an ASAR

- **What happens.** With the app started with `--remote-debugging-port`, the main window's URL is `file:///Applications/<App>.app/Contents/Resources/app.asar/dist/renderer/index.html`. `list_electron_targets` reports `excluded.unsupported_url: 1` and `list_javascript_runtime_targets` reports `excluded.unsupported_location: 1`, so no target is observable.
- **Expected.** Accept `file://` URLs whose path resolves to an entry inside a regular `.asar` file (most packaged Electron apps load this way), or document the limitation in `electron-observation.md`.

## 5. Semantic graph ceiling is a fixed constant

- `SEMANTIC_GRAPH_NODE_CEILING = 100_000` (`src/application/javascript/JavaScriptSemanticGraphBuilder.ts:104`) with no setting. A single 15 MB scope-hoisted server bundle leaves most functions outside the semantic graph, so `trace_javascript_semantics` returns zero seed matches for literals that exist in the file. A configurable ceiling, or per-module semantic analysis on request, would help large bundles.

## 6. `build_reconstruction_obligation_ledger` rejects its own generated candidates

- **What happens.** With an exported bundle holding one `analyze_javascript_application` record for the app's main-process half (60 files) and empty `reviewed_obligations` and manifest, the ledger fails with `invalid_request`: `A nested value failed validation at obligations.27.title: Too small: expected string to have >=1 characters` (also 63, 139, ...). The generated candidates come from endpoint nodes whose key is an empty string.
- **Also.** For the renderer half the ledger builds, but 321 of 464 candidates are `protocol/endpoint` items whose titles are PDF.js and form strings (`fillCanvas`, `StructTreeRoot`, `Linearized`), so the automatic checklist is mostly noise for minified bundles.
- **Expected.** Skip or label empty-key candidates instead of failing, and filter obvious non-endpoint strings.
- **Cause.** `src/application/ReconstructionObligationCandidates.ts:108` sets `title: node.observations[0]?.label ?? \`${node.kind} boundary\``. `??` keeps an empty-string label, so the fallback never applies. `||` would fix it.

## 7. `capture_process_scenario` keeps no Evidence when cleanup is incomplete

- **What happens.** A signed-out and a signed-in launch of the packaged app both return `cleanup_incomplete` (`platform_binary_environment_withheld`, `environment_unavailable` for 2 and 10 live candidates), even though no owned processes remain afterwards. The response has a `partial_observation` with the process tree but no evidence_id, so the capture cannot be exported, cited or used by the ledger.
- **Expected.** Retain the partial capture as Evidence with the cleanup state recorded as a limitation, or settle descendants that are macOS platform binaries.

## 8. Ledger input errors surface as `unreadable_output`

- **What happens.** `build-reconstruction-obligation-ledger` reports `unreadable_output` ("Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.") for two different input problems. In one, the bundle manifests no longer matched the records after records were removed (`TypeError: Evidence bundle manifests are not canonical` in `parseEvidenceBundle`). In the other, a 771 MB input file was over Node's maximum string length. Neither message reaches the user. I found them by calling the ledger functions directly.
- **Expected.** Report bundle validation failures as `invalid_request` with the message, and stream or reject oversized input with a typed limit.

## 9. `trace_javascript_semantics` literal seeds rarely match

- **What happens.** 16 traces seeded with string literals and property names that appear verbatim in the code all returned `total_seed_matches: 0`. On a 12-file, 3.3 MB slice the semantic graph had 65,682 nodes but only 7 `literal` nodes, so a literal seed only matches values the extractor chose to model.
- **Ask.** Document which literals become semantic nodes, or report "seed not modeled" separately from "seed absent", so a zero-match trace is not mistaken for absence.

## 10. Minor

- `inspect_analysis_view` with a `modules` item selected by `path` fails when a scope-hoisted bundle yields thousands of modules with the same path. The error lists every candidate node_id, which makes the message several hundred KB.
