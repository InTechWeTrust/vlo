# Project Style Guide

## Overview

This style guide outlines the conventions for file structure, naming, component architecture, state management, and styling. It is designed to support the **Feature-based** architecture (`frontend/src/features/`).

## 1. Directory Structure

The project follows a **Feature-based** architecture. Each major feature is self-contained. Use **Barrel Files** (`index.ts`) to expose only the public API of the feature to the rest of the app. A publicApi.ts file can also optionally be included to create helpers and improve tidy-up feature functions for consumption by the barrel file.

### Standard Feature Layout

```text
features/timeline/
├── components/                   # React components specific to this feature
├── hooks/                        # Custom hooks (logic, data fetching)
├── utils/                        # Helper functions and business logic
├── __tests__/                    # Tests (colocated or in subfolders)
├── constants.ts                  # Feature-specific constants
├── index.ts                      # Public API (Barrel file)
├── TimelineContainer.tsx         # Main Entry point
└── useTimelineStore.ts           # Zustand store for feature state

```

Ideally the top level of each feature should include a primary component, hook, or store (possibly all three), which gives an easy entry point for developers trying to understand the most significant structures of the feature (in terms of UI, functionality and data management, respectively).

### Encapsulation (Barrel Files)

The `index.ts` file should only export what is necessary for other features to consume. Internal components and helpers should remain private to the feature.

```typescript
// features/timeline/index.ts
export { Timeline } from "./Timeline";
export { useTimelineStore } from "./useTimelineStore";
// Do NOT export internal sub-components (e.g., TimelineClip)
```

## 2. Naming Conventions

- **Exports:** **Named Exports** only. Avoid `export default` to ensure consistent naming in imports and better refactoring support.
- **Files:**
- React Components: `PascalCase` (e.g., `TimelineTrack.tsx`).
- Hooks: `camelCase`, prefixed with `use` (e.g., `useTimelineZoom.ts`).
- Utilities: `camelCase` (e.g., `collisionDetection.ts`).

- **Components:** `PascalCase`. The root component should match the feature name (e.g., `Timeline.tsx` inside `timeline/`).
- **Types & Interfaces:** `PascalCase` (e.g., `TimelineState`, `ClipData`).
- **Constants:** `UPPER_SNAKE_CASE` (e.g., `DEFAULT_TRACK_HEIGHT`).

## 3. React Components

- **Declaration:** Use standard **Function Declarations**.
- ❌ **Avoid:** `React.FC` types.
- ✅ **Prefer:** `export function ComponentName(...)`.

- **Props Interface:** Define a specific interface, typically named `<ComponentName>Props`.
- **Logic Separation:** Keep components focused on UI. Extract complex logic (drag-and-drop, collision calculations) to **custom hooks**.
- **Optimization:**
- Use `React.memo` for list items or components that render frequently (e.g., Clips, Tracks).
- Use `useShallow` when selecting values from Zustand to prevent re-renders.

```typescript
// Example
import { memo } from "react";
import { Box } from "@mui/material";

interface TimelineClipProps {
  id: string;
  isSelected: boolean;
}

export function TimelineClip({ id, isSelected }: TimelineClipProps) {
  // ... implementation
  return <Box>...</Box>;
}

export const MemoizedTimelineClip = memo(TimelineClip);
```

## 4. State Management

- **Library:** **Zustand**.
- **Structure:**
- Create separate stores for distinct domains (e.g., `useTimelineStore`, `usePlaybackStore`).
- Stores handle actions and logic updates (e.g., `addClip`, `updatePlayhead`).

- **Selectors:** **Always** use granular selectors or `useShallow`. Never export the entire state object into a component.

```typescript
// Example Store Usage
import { create } from "zustand";

interface TimelineState {
  zoomLevel: number;
  setZoom: (level: number) => void;
}

export const useTimelineStore = create<TimelineState>((set) => ({
  zoomLevel: 1,
  setZoom: (level) => set({ zoomLevel: level }),
}));
```

## 5. Styling

- **Library:** **Material UI (MUI)**.
- **General Layout:** Use the `Box` component with the `sx` prop for structural layout (flexbox, grids, padding).
- **High-Frequency Components:**
- ⚠️ **Performance Warning:** For components rendered in loops (e.g., 100+ timeline clips), the `sx` prop incurs a runtime performance penalty.
- **Solution:** Use `styled()` (MUI system) to hoist styles outside the render cycle for these specific elements.

**A. General Layout (Use `sx`)**

```typescript
// Good for containers and unique elements
<Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>{children}</Box>
```

**B. High Performance (Use `styled`)**

```typescript
// Good for Timeline Clips, Ticks, or repeated list items
import { styled } from '@mui/material/styles';

const StyledClip = styled('div')(({ theme }) => ({
  position: 'absolute',
  height: '100%',
  backgroundColor: theme.palette.primary.main,
  // dynamic styles via props can also be handled here
}));

export function Clip({ ... }) {
  return <StyledClip />;
}

```

## 6. TypeScript

- **Strict Typing:** **NEVER** use `any` without a very explicit comment justifying why it is absolutely necessary (e.g., external library with broken types). Prefer `unknown` or specific types.
- **Type Imports:** Use `import type { ... }` when importing interfaces/types. This aids clarity and compilation tree-shaking.

## 7. Logic, Services & Utilities

- **Pure Functions:** Extract complex calculations (collision, time formatting, pixel math) into pure functions in `utils/`.
- **Services vs. Utilities:**
  - **Utilities (`utils/`)**: Pure, stateless helper functions. They should not hold state or side effects. Examples: formatting time, collision detection algorithms, math helpers.
  - **Services (`services/`)**: Stateful singletons or long-lived objects that manage complex external systems or business logic that doesn't fit neatly into a Store. Examples: `AudioSystem` (wraps AudioContext), `PlaybackClock`.
- **Comments:**
- Explain _why_, not _what_.
- **Algorithmic Steps:** Use numbered comments for complex logical flows to improve readability.

```typescript
// Example: utils/collision.ts
export function detectOverlap(a: Clip, b: Clip): boolean {
  // 1. Check if A ends before B starts
  if (a.end <= b.start) return false;
  // 2. Check if A starts after B ends
  if (a.start >= b.end) return false;
  // 3. Otherwise, they overlap
  return true;
}
```

## 8. Extension Surface Reuse

Treat the supported extension surface as a host-development contract, not a
parallel implementation reserved for third parties. Before adding a reusable
service, registry, command path, long-running job, renderer contribution, or
host option list, read
[`extensions/extension-development/references/host-contracts.md`](extensions/extension-development/references/host-contracts.md)
and classify the capability as one of:

- **Exact API consumer:** an optional, independently disposable first-party
  feature uses the real `ExtensionHost`, `ExtensionContext`, and
  `VloExtensionApi` without privileged members.
- **Shared host seam:** native code and the extension adapter use one
  owner-neutral service, registry, controller, transaction engine, or
  normalized runtime owned by the relevant core/feature domain.
- **Conformance-only:** approval, package lifecycle, namespaced storage, owner
  identity, or another intrinsically extension-specific concern is exercised
  through fixtures and lifecycle tests, with the exemption documented.

Keep owner binding, activation cancellation/disposal, detached SDK shapes,
finite-JSON checks, extension limits, and public error translation in the
adapter. Keep reusable mechanics in the owning host domain. Core code must not
import an owner-bound extension adapter merely to claim dogfooding.

Host and extension contribution shapes may differ at registration, but they
should converge on one normalized runtime before rendering, scheduling, or UI
presentation. When a native analogue exists, add paired behavioural coverage
showing that native and SDK entry points preserve the same validation,
arbitration, and lifecycle rules. Retain an out-of-tree fixture for packaging,
approval, ownership, rollback, and missing-provider behaviour.

Use `core/shell` registries, the `vlo.core` animation providers, and
`AudioAnalysisService` as reference patterns. State the surface's
classification in the pull request description, and classify new adapter call
sites in `.gitattributes`.

## 9. Testing

- **Location:** Colocate tests in `__tests__` directories inside `components`, `hooks`, or `utils`.
- **Naming:** Test files must end in `.test.ts` or `.test.tsx`.
- **Globals:** **ALWAYS** use `globalThis` instead of `global` when mocking or accessing global objects (like `fetch` or `crypto`). `global` is Node.js specific and does not exist in browser/JSDOM environments.

### Backend Testing

- Backend tests live under `backend/tests/`.
- From the repository root: `npm run test:backend` (or `backend/.venv/bin/python -m pytest backend`).
- From `backend/`: `.venv/bin/python -m pytest`.
- Use the venv interpreter (`backend/.venv/bin/python` from the root, `.venv/bin/python` from `backend/`) — not a bare `python3.x` path, which breaks whenever the venv's Python is upgraded.
- During iteration, prefer focused runs for the files or `-k` patterns you are touching. From the root: `backend/.venv/bin/python -m pytest backend/tests/test_foo.py -k pattern`. From `backend/`: `.venv/bin/python -m pytest tests/test_foo.py -k pattern`.
- For coverage on the area you changed, run `npm run test:backend:coverage`. It requires `pytest-cov`; install it into the venv with `backend/.venv/bin/python -m pip install -e "backend[dev]"`.
- Some managed sandboxes deny the Unix-socket write that `asyncio` uses to
  wake an event loop from another thread. In that environment, Starlette
  `TestClient`, synchronous FastAPI routes, `asyncio.to_thread()`, or event-loop
  shutdown can appear to hang even though the code is healthy. If a backend
  test stalls in `selectors.select`, `TestClient.handle_request`, or
  `shutdown_default_executor`, rerun the same focused test with normal socket
  permissions before diagnosing or changing application/test code. A sandbox
  `PermissionError` from the loop's internal `_write_to_self()` socket confirms
  this environmental failure mode.

### Extension Contract Impact

- After making repository changes and before handoff or commit, run `npm run check:extension-surface` from the repository root.
- Review every reported category. A `public` result requires an SDK compatibility review; `host` and `adapter` results require the relevant behavioural contract tests; `authoring` and `fixture` results require package/conformance review.
- If a new file begins dispatching, persisting, or presenting extension-owned behaviour, add it to the appropriate category in `.gitattributes`.
- Treat a clean impact report as a catalogue result, not proof of compatibility. It does not replace relevant tests.

### Test before commit

Use the relevant test runner before committing:

- Frontend changes: `npm run test`
- Backend changes: `npm run test:backend` from the repository root (or `.venv/bin/python -m pytest` from `backend/`)

If any test fails, fix the issue before committing. Ideally, it is even better to be tracking tests live as you change files.
