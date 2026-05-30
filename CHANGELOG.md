# Change Log

Public release notes for Build by Grok.

## [4.20.160]

- Made requested generated-image failures sticky across the full agent turn so a later successful build cannot erase an earlier `generate_image` failure.
- Prevented `/astro` and other build rails from reporting completion when requested image generation failed or never produced a successful `Generated image:` result.

## [4.20.159]

- Simplified the `/astro` rail back to the core gather/action/verify/repair loop and removed the over-constrained generated-asset checklist language.
- Added explicit metadata to agent `generate_image` failures so xAI image failures report the actual model, fixed sizing, prompt length, and target filename used by the tool.

## [4.20.158]

- Locked the agent `generate_image` tool to the known-working `/bf` image sizing path: always `16:9` and `1k`.
- Removed aspect ratio and resolution arguments from the model-facing image tool schema to prevent malformed image calls.

## [4.20.157]

- Fixed the agent `generate_image` tool wrapper to format image requests like the working `/bf` path by always sending a concrete aspect ratio and `1k` resolution by default.
- Removed the loose `auto` aspect-ratio option from the agent image tool schema so model-emitted tool calls cannot send unsupported image sizing values.

## [4.20.156]

- Restored the shared Grok Imagine client to the direct single-call behavior used by the working `/bf` image path.
- Removed image model/response-format fallbacks so `/astro` and `generate_image` report the actual xAI image error instead of masking it with alternate requests.

## [4.20.155]

- Hardened the shared Grok Imagine client used by `/astro`, `/bf`, and the agent `generate_image` tool with server-error fallbacks.
- Image generation now retries URL responses and the base `grok-imagine-image` model when the configured image model returns retryable xAI failures.

## [4.20.154]

- Changed voice capture so accepting browser microphone permission only primes the mic; recording starts on the next explicit mic click.
- Applied the same permission-first behavior to both the secure browser voice capture window and the VS Code voice capture panel.

## [4.20.153]

- Clarified the `/astro` image rule so explicit requests for images or Grok Imagine assets must still call the `generate_image` worker.
- Tightened AstroMax guidance so it does not satisfy explicit raster image requests by writing its own SVG/vector placeholders.

## [4.20.152]

- Added an AstroMax guardrail so `/astro` does not invent custom SVG/inline artwork or faux image files unless the user explicitly asks for project images.
- Clarified that explicit raster image requests should use Grok Imagine-generated assets, while SVG/vector art should only be created when specifically requested.

## [4.20.151]

- Tightened `/astro` generated-image handling so failed Grok Imagine calls remain unresolved and cannot be cleared by a later successful build.
- Added AstroMax retry/blocker guidance for explicit image requests: retry simpler prompts or one asset at a time, and report blocked/partial if generation still fails.
- Fixed the asset completion check so failed `generate_image` attempts no longer count as successfully generated project assets.

## [4.20.150]

- Strengthened the agent continuation loop so unresolved self-check failures trigger up to three automatic repair passes instead of being ignored.
- Added AstroMax hard requirements for requested generated images/assets: generate files, place them in browser-served Astro paths, reference them from pages/components, and verify the asset checklist.
- Added AstroMax completion guidance so the rail cannot stop at "run build to verify" without actually running and inspecting the build.

## [4.20.149]

- Added AstroMax rail guidance to disable the Astro dev toolbar in generated projects.
- Added AstroMax styling checks so global CSS/Tailwind imports and CSS routes are verified before completion.

## [4.20.148]

- Added a dedicated `/astro <prompt>` AstroMax rail with an isolated Astro specialist prompt stored in `src/prompts/astroMaxPrompt.ts`.
- AstroMax keeps Astro builds on an Astro-first path with non-interactive scaffolding, islands-first interactivity, write verification, and build repair guidance.

## [4.20.147]

- Tightened write-tool verification so file writes report disk read-back, content hash confirmation, unchanged-content warnings, and git diff numstat.
- Fixed secret redaction so normal source code assignments like `const token = ...` are not rewritten into invalid `[REDACTED]` placeholders.
- Preserved fuller agent thinking/status text in the chat trace and deduplicated repeated trace lines.
- Removed the browser voice-capture session timeout; the mic session now stays open until ended, with larger audio/transcription limits for longer dictation.

## [4.20.146]

- Added Enter-to-send in the chat prompt while preserving Shift+Enter for multiline prompts.
- Updated voice/send helper copy to mention both Enter and the rocket button.

## [4.20.145]

- Enforced a 500,000-character minimum read-file window and expanded key-file workspace context previews to 500,000 characters.
- Added agent guidance to read full relevant source, page, and config files before editing instead of prematurely treating normal project files as too long.

## [4.20.144]

- Added `/search` as an alias for the read-only find rail alongside `/find` and `/locate`.

## [4.20.143]

- Improved `/find` search behavior with case-insensitive natural-language keyword extraction, ranked partial matches, and path/name matches.
- Added a find-specific fallback response so incomplete find turns report candidate files or searched context instead of a generic inspected-steps summary.

## [4.20.142]

- Added `/find` and `/locate` read-only search rails for locating files, copy, routes, handlers, and repo sections without editing or running commands.
- The find rail checks README-style files first for repo context, then searches exact terms and useful variants before returning file paths and line numbers.

## [4.20.141]

- Removed the experimental `/imageadjust` and `/imgadjust` flags.
- Restored image handling to the Grok-driven behavior from before the local optimizer experiment.

## [4.20.140]

- Added a default-agent instruction for empty-workspace Astro builds so the agent scaffolds immediately and continues editing.
- Keeps Astro site generation on the fast direct rail without adding another retry loop.
