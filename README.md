# EquiMocha (Revenge port)

This is a port of EquiMocha from Equicord/Vencord (desktop, Electron) to
[Revenge](https://github.com/revenge-mod) (mobile, React Native). It uploads files to
Mocha and shares the resulting link in chat.

The two codebases are structurally different enough that this isn't a line-for-line
translation — it's a re-implementation that reaches the same outcome through different
triggers, because several of the original's triggers don't exist on this platform at all.
This README is mostly about *why* things look different, not just *what* changed.

## Why this isn't a 1:1 port

### There's no native helper process

Vencord's `native.ts` ran in Electron's main process, with a full Node.js runtime: `fs`
for chunked disk reads, a long-lived process that could hold file handles open, and a
`fetch` that supports streaming request bodies straight from disk.

Revenge has none of that. There is no Electron, no Node runtime, no separate "native"
process a plugin can delegate work to — everything runs in one JS thread inside Discord's
own React Native app. The only way to get a file's bytes from JS is:

```ts
RNFileModule.readFile(uri, "base64")
```

which returns the **entire file** as one base64 string, loaded fully into memory. There's
no chunked or streaming read available. `src/stuff/api.ts` still does the same S3
multipart upload (init → presign per part → PUT each part → complete) as the original, so
large files are still fine server-side — but the whole file now has to fit in memory on
the client first, as a base64 string and then again as decoded bytes. A few-hundred-MB
file that the desktop version could stream through 10MB at a time will be noticeably more
memory-hungry here.

`RNFileModule` itself isn't a normal package import — it's a native turbo-module/legacy
module accessed through `window.nativeModuleProxy` or `globalThis.__turboModuleProxy`.
`src/stuff/files.ts` implements this exactly the way revenge-bundle's own (unexported)
`native/modules` source does, re-derived from its public GitHub source since the bundle
doesn't expose it as an importable module.

### There's no DOM, so the original's main triggers don't exist

The original plugin hooked three things to start an upload:

1. A `FluxDispatcher` interceptor on `UPLOAD_ATTACHMENT_ADD_FILES` — Discord's own
   internal event for "a file was just added to the attachment pipeline," fired by the
   desktop client's own upload code before the request goes out.
2. Paste/drag listeners — actual `ClipboardEvent` / `DragEvent` DOM events.
3. A file `<input>` element's `change` event.

None of these exist in a React Native app. There's no DOM, no browser-style clipboard/drag
events, and — as far as could be confirmed — no public hook into the mobile attachment
picker/sender pipeline equivalent to the desktop dispatcher event. So this port doesn't
intercept anything; it gives you a new, explicit entry point instead:

```
/mocha-upload [copy-only]
```

A slash command opens the native document picker, uploads what you picked, and either
sends the link or copies it to your clipboard — `copy-only` mirrors what the original did
automatically for context-menu-triggered uploads. This is implemented in
`src/stuff/commands.ts` / `src/stuff/upload.ts`.

The original's "bypass Discord's nitro-upsell upload size modal" patch is also gone. That
targeted a specific desktop-only code path; mobile's size-limit handling is different code
that hasn't been reverse-engineered here, so it isn't patched at all — if a file is too big
for Discord's own size limit *and* you try to send rather than copy, that's between you and
Discord's own UI, same as if this plugin weren't installed.

### The "upload to Mocha" right-click menu became a best-effort long-press action

The desktop version added right-click context menu items on messages and images. The
mobile equivalent is the long-press action sheet, reached by patching
`LazyActionSheet.openLazy` and checking for the `MessageLongPressActionSheet` key — see
`src/stuff/messageActionSheet.tsx`. This works, and was checked against real plugins (`local-pins`)
and the `@nexpid/vdp-shared` package's `RedesignRow` component for the exact row primitive
(`ActionSheetRow`, with `FormRow` as an older-client fallback) — but it's matching against
Discord's internal React tree shape, which **will** change without warning across Discord
updates. If it silently stops adding the row, the slash command still works regardless —
that's intentional; don't treat the long-press option as the primary way to trigger an
upload, treat it as a bonus that occasionally needs a one-line fix.

### Settings are a component you build, not a schema

Vencord plugins declare settings with `definePluginSettings()` and the desktop client
renders a form for you. Revenge/Vendetta-style plugins have no such schema system —
instead you export a `settings` field that's just a React component
(`src/components/Settings.tsx`), built from `Forms.*` primitives from
`@vendetta/ui/components`, the same way the community plugins this was checked against
(`clean-urls`, `customrpc`) do it.

### Progress UI is a standalone component you choose whether to use

The original mounted its progress bar by patching a chat-input-adjacent component with a
regex-based webpack find (`find: ".CREATE_FORUM_POST||"`). That target is desktop-bundle-specific
code; finding (and keeping working, across versions) the equivalent mobile chat-input
mount point wasn't something this port could verify, so rather than guess at an
undocumented patch target, `src/components/UploadBanner.tsx` ships as a small standalone
component with its own `cancelCurrentUpload()` hookup. A single upload usually finishes in
a few seconds and toasts already cover success/failure/cancellation, so this is offered as
optional UI you can mount wherever it makes sense for your fork, rather than wired in by
default.

## What was checked against real source, vs. inferred

Everything in this port that touches Revenge/Vendetta-internal APIs was checked against
one of:

- `revenge-mod/revenge-bundle` (the actual runtime source, including its Vendetta-compat
  shim — `window.vendetta.*` — which is what `@vendetta/*` imports resolve to)
- `nexpid/RevengePlugins` (a real, maintained collection of third-party plugins, including
  its actual build pipeline)
- `@nexpid/vdp-shared` (a small shared-component package some of those plugins depend on)
- `vendetta-types` (the official published type declarations for Vendetta/Revenge plugins)
- the published `react-native-document-picker` and `@react-native-documents/picker`
  npm packages' own type definitions

`commands.ts`'s use of `ApplicationCommandOptionType.BOOLEAN` was specifically checked this
way: `vendetta-types`' `defs.d.ts` declares it as a global ambient `const enum`, never
exported from any `@vendetta/*` module — so it's used here as a bare global (resolved at
compile time via the `vendetta-types/defs.d.ts` entry in `tsconfig.json`'s `include`),
not imported.

One thing remains genuinely unimplemented rather than guessed at: the exact mobile
chat-input mount point for a progress bar (see "Progress UI" above) — the original's
mount target was a desktop-bundle-specific webpack find that doesn't translate, and no
real mobile equivalent could be confirmed.

## Building

```sh
npm install
npm run build      # outputs dist/index.js
npm run watch       # rebuilds on change, for use with Revenge's "load from custom URL" dev mode
npm run check       # typecheck only, no output
```

`build.ts` is a small, standalone esbuild script — not the multi-plugin pipeline
`nexpid/RevengePlugins` uses internally (that one also handles i18n, doc generation, and
parallel builds across many plugins, none of which apply here). The two things it
specifically reproduces, confirmed from that pipeline's real source, are:

1. Resolving `@vendetta/*` imports to property access on the `vendetta` global the loader
   injects at runtime (e.g. `@vendetta/metro/common` → `vendetta.metro.common`) — there's
   no real npm package backing these at runtime; `vendetta-types` (a devDependency here)
   only provides type declarations for the compiler.
2. Wrapping the bundle so it evaluates to the plugin's exports object (`onLoad`,
   `onUnload`, `settings`), the shape the loader expects.

To actually load the built plugin for testing, point Revenge's developer settings
("Load from custom URL") at wherever you're serving `dist/index.js` from.

## Repo layout

```
MochasRevenge/
├── manifest.json
├── package.json
├── tsconfig.json
├── build.ts
└── src/
    ├── index.ts
    ├── components/
    │   ├── Settings.tsx
    │   └── UploadBanner.tsx
    └── stuff/
        ├── api.ts
        ├── commands.ts
        ├── files.ts
        ├── media.ts
        ├── messageActionSheet.tsx
        ├── upload.ts
        ├── uploadFromUrl.ts
        ├── uploadState.ts
        └── utils.ts
```



| File | Role |
|---|---|
| `manifest.json` | Plugin manifest |
| `src/index.ts` | `onLoad`/`onUnload`/`settings` exports, storage defaults |
| `src/stuff/api.ts` | Mocha HTTP client — folder/share dedup, S3 multipart upload |
| `src/stuff/files.ts` | Document picker + `RNFileModule` base64 read |
| `src/stuff/upload.ts` | Pick-and-upload orchestration (slash command path) |
| `src/stuff/uploadFromUrl.ts` | Fetch-a-URL-and-upload (action sheet path) |
| `src/stuff/media.ts` | Pulls an attachment/embed URL off a message object |
| `src/stuff/commands.ts` | `/mocha-upload` slash command |
| `src/stuff/messageActionSheet.tsx` | Best-effort "Upload to Mocha" long-press row |
| `src/stuff/uploadState.ts` | Ephemeral progress store + React hook |
| `src/stuff/utils.ts` | Byte formatting, debug logging, settings helpers |
| `src/components/Settings.tsx` | Settings screen |
| `src/components/UploadBanner.tsx` | Optional standalone progress UI |

## Settings

- **API Key** — your Mocha API key
- **Auto-send uploaded links** — off copies to clipboard instead of sending
- **Log requests to console** — debug logging
- **Share expiry** — never / 1 day / 7 days / 30 days
- **Chunk size (MB)** / **Max chunks** — multipart upload tuning, same idea as the
  desktop version's settings

## Usage

- `/mocha-upload` — pick a file, upload it, send the link
- `/mocha-upload copy-only:true` — pick a file, upload it, copy the link instead
- Long-press a message with an image/video attached → "Upload to Mocha" (best-effort,
  always copies rather than sends — see caveats above)
