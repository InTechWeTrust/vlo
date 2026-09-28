# Evolving host extension contracts

Use this reference when a change to vlo itself adds or widens something
extensions can reach: a service, registry, command path, long-running job,
renderer contribution, reusable option list, or SDK member. It is for host
contributors, not for authoring an extension against the current SDK.

## Ask these questions first

1. Does an existing scoped SDK surface already express the capability?
2. If both host code and extensions need it, what owner-neutral seam will they
   share?
3. Is the extension adapter limited to policy and shape translation?
4. Which classification below applies, and which tests cover it?
5. Is every new file that dispatches, persists, or presents extension-owned
   behaviour classified in `.gitattributes`?

## Classify the surface

Every supported surface is exercised in exactly one of three ways:

- **Exact API consumer.** An optional first-party feature activates through the
  real `ExtensionHost` lifecycle and uses `VloExtensionApi` exactly as a package
  would. Use this only for features that are independently disposable, not needed
  to open or edit a project, and naturally built from public commands and
  contributions, such as navigation helpers, reports, analysis tools, or
  look/filter packs. Give it a reserved `vlo.builtin.*` identity and the same
  activation rollback and disposal tests as a package. It must not receive API
  members an ordinary approved extension does not get.
- **Shared host seam.** Native code and the extension adapter both consume one
  owner-neutral service, registry, controller, transaction engine, or normalized
  runtime owned by the relevant core or feature domain.
- **Conformance-only.** The concern is intrinsically about extensions and has no
  honest native consumer: digest approval and package compatibility,
  extension-scoped storage, extension-owned payload/provider identity,
  `api.trusted.host` and the injected singleton runtimes, and activation
  diagnostics attributed to a package. Cover these through fixtures and
  lifecycle tests, and state why the surface is conformance-only. Do not create a
  synthetic host owner just to call them.

Never put project loading, the base timeline, the renderer, or other editor
foundations behind extension activation. Those systems provide the seams that
extensions consume.

State the classification in the pull request description.

## Split mechanics from policy

Put policy-free mechanics in the owning core or feature domain, where native
code calls them directly. The extension adapter projects that seam into SDK
types and keeps only:

- extension identity and owner checks;
- activation cancellation and automatic disposal;
- cloned or frozen snapshots and finite-JSON boundaries;
- extension-specific allocation or rate limits;
- public failure codes and diagnostics.

Core code must not import an owner-bound extension adapter. Use `core/shell`
registries, the `vlo.core` animation providers, and `AudioAnalysisService` as
reference patterns.

Host and extension definitions may differ at registration, but they must
converge on one normalized runtime before rendering, scheduling, or UI
presentation. Do not add an extension-only dispatch branch where an
owner-neutral definition can represent both. Use the common registry kernel for
owner binding, duplicate rejection, rollback, diagnostics, and disposal.

## Grow the contract deliberately

- Generalise from the capability being enabled, not from the first example.
- Promote a repeated raw `api.trusted.host` seam into a narrow domain contract,
  but keep the trusted fallback available.
- Keep declarative descriptors and JSON envelopes compatible with a future
  restricted mode where practical. Don't weaken trusted APIs for a sandbox that
  doesn't exist yet: restricted callbacks, UI, and backend code will need real
  process or origin boundaries, not a narrower TypeScript facade.
- Don't migrate a mature native feature into an extension, or an extension into
  core, without a concrete reduction in duplicated runtime code.
- A new public SDK member is a minor version bump. A breaking change is a new
  major version.

## Test both entry points

- When a native analogue exists, add paired behavioural coverage showing that
  the native and SDK entry points apply the same validation, arbitration, and
  lifecycle rules.
- When a generic rendering capability is added for an extension, exercise the
  resulting normalized runtime with at least one native or core-owned definition
  as well as the extension fixture.
- Keep an out-of-tree fixture under `extension-fixtures/` for packaging,
  approval, ownership, rollback, and missing-provider behaviour. Host use
  complements these fixtures; it never replaces them.
- Source imports and unit mocks do not count as exercising a surface.

## Run the checks

From the repository root:

1. `npm run check:extension-surface`, then review every reported category. A
   `public` result needs an SDK compatibility review; `host` and `adapter`
   results need the relevant behavioural contract tests; `authoring` and
   `fixture` results need package or conformance review.
2. The focused tests for the surface, then `npm run test` for frontend changes
   and `npm run test:backend` for backend changes.
3. `npm run build --prefix frontend` when types or public exports change.

A clean impact report is a catalogue result, not proof of compatibility.
