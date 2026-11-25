# AI Instructions & Log

**This is the first file every AI (Grok, Gemini, Claude, GPT, etc.) must read when working on this project.**

## Hard Rules
- Do not edit files without explicit user permission in that conversation.
- Log every change you make in the Log section below.
- Prefer small, targeted, reversible changes.
- Everything stays touch/pencil-first for iPad.
- Models are math recipes stored as JSON. Never treat them as final exported meshes.

## Current Goal
Build a practical low-poly bag-mesh modeler inside babalonJS:
- Smart context selection (pencil near a vertex/edge/face automatically targets it)
- Insert edge loop
- Extrude faces
- Easy spawn of primitives at origin
- Boolean add/subtract
- Keep geometry low and editable as math/JSON

## Process
1. Read this file.
2. Check the Log for the latest changes.
3. Confirm the specific task with the user before editing.
4. After any edit, append a log entry.

## Log
- 2026-11-25: Created this AI.md as the shared first-read file. AI Notebook module exists at src/ui/aiNotebook.ts but is not yet hooked into the menu.
- 2026-11-25: User needs modeler tools (edge loop, extrude, smart selection, booleans, JSON math recipes). Next step after this file is to plan and implement the first modeling tools.
