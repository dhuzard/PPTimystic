# Shared browser session

A session lets collaborators review and edit one local project through a browser. Install dependencies, create a project, and start the server from the repository root:

```sh
npm install
npm run session -- --project research-talk --port 0
```

The server chooses an available port by default; `--port 0` explicitly requests the same behavior. Use `--port 4317` or another number if you need a fixed port. The command prints separate owner, editor, and reviewer invitation links. Open the owner link and enter a name. Keep the owner link private; share each other link only with people who should have that role. Stop the server with Ctrl+C. Invitations and signed-in sessions are specific to the running server; restarting it creates new invitations.

## Editable human review

When using the human-review skill to review slides, open this studio's native owner or editor invitation directly. It provides the same text and image editing as a multi-person session for a single creator as well: double-click text, select an image to replace it, use **+ Image** to upload an image with its alt description, and drag or use the position and size controls. Changes save to the project, and comments, protection checks and revision history remain available.

Use the generic human-review tool for the Markdown storyline or other prose. Its overlay can intercept editor controls, and its proxy does not forward authenticated app cookies. A rendered slide gallery is useful for visual comments, but direct object editing belongs in the native studio. Keep the studio process running while the creator edits, and use its session API for agent changes while the project lease is active.

By default, the server binds to `127.0.0.1`, so it is accessible only on that computer. On a **trusted private network**, `--host 0.0.0.0` listens on network interfaces. Replace `localhost` in the printed invitation with the server computer's private network address, preserving its port and token. The server uses HTTP, so network traffic and invitation links are not encrypted. Do not expose it to the public internet or an untrusted network. Anyone with an invitation has the permissions of its role.

## Working together

- The owner can edit, change review status, and explicitly authorize changes to protected slides or accepted images. Check the authorization control for the specific slide when an authorized change is intended.
- Editors can edit unprotected material, add text, shapes and images, comment, and apply eligible agent proposals. Reviewers can inspect and comment but cannot edit slides. Reviewers' agent requests do not automatically apply changes.
- Select a slide and object to edit its text, geometry or supported appearance. Drag or use the position controls; add text, shapes or a retained image from the toolbar. Existing source objects cannot be deleted through the editor. Chart data is shown for review; edit its authoritative source when values need to change. Speaker notes, language selection, threaded feedback, presence, activity and undo are also available.
- Text edits are shared live using Yjs while the server is running. Other object changes use revision checks and short-lived movement locks. Conflicting changes are rejected for review. This is online collaboration, not durable offline authoring; keep a copy of unsent work if the connection is lost. Undo is available only when it will not overwrite subsequent slide changes.
- Select **Export** to build an editable PowerPoint or build with local rendered previews. Preview rendering needs the same local renderer as the CLI. Browser layout and fonts approximate PowerPoint; inspect the actual exported presentation and its rendered previews for text reflow and visual fidelity.

The browser and its bundled dependencies are served locally without a CDN. `content/slides.yaml` remains authoritative; the session records local history, feedback, and before-change backups, and build output history is retained. Stable slide IDs and localized content are preserved. A direct source edit made outside the session triggers a reload/conflict rather than silently overwriting the detected change. Missing translations, scientific evidence issues and protection rules still apply to builds. This editor does not import arbitrary HTML as slide content.

For a legacy PowerPoint trial with `content/reference-preview.json`, **Original slide** displays locally rendered slide images and, where extracted, playable embedded videos. Select a supported original text object to edit its existing text runs; edits are recorded in YAML and a temporary patched copy is rendered to refresh the slide. This live preview requires PowerPoint on Windows. A pending or failed preview is explicitly labeled and stale results are discarded. Objects with ambiguous identities or unsupported text structures are read-only. Moving original objects, changing their style or images, and editing video are not supported. **Edit draft text** exposes a separate generic draft and does not update the original layout. A `content/.block-session-export` marker disables session export where the generic renderer cannot preserve the original custom layouts and media; native text overrides independently block the generic exporter. The reference manifest verifies the retained PowerPoint and extracted media hashes. The original file is not changed, and this trial does not yet export its edited PowerPoint.

## Optional agent adapter

No AI provider is configured by default. In Comments, **Ask the agent** creates a request; without an adapter it remains visible as awaiting an agent. An operator can configure a local executable that implements the protocol below. For example, save a JSON file outside the project containing an absolute path to **your own** adapter:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/my-pptimistic-adapter.mjs"],
  "timeoutMs": 120000,
  "autoApply": false,
  "usesExternalServices": false,
  "usesPaidServices": false
}
```

Replace the path with the actual absolute path on your system, then start with `npm run session -- --project research-talk --port 0 --agent-config /absolute/path/to/agent-config.json`. This is an interface for your adapter, not a ready-built AI provider. The executable runs with the project directory as its working directory and receives the slide, notes, feedback and scene; treat the adapter as trusted software. If it transmits content externally or uses paid services, set the corresponding `usesExternalServices` or `usesPaidServices` flag and explicitly approve it with `approvedForExternalTransmission` or `approvedForPaidCalls` respectively. These declarations do not restrict what the executable itself can do.

For each job, the server starts the executable without a shell and writes one JSON object to stdin, followed by a newline. The object has `protocol: "pptimistic-agent-v1"`, `instructions`, `job`, `slide`, `scene`, `sourceLocale` and `revision`. The executable must write a single JSON object to stdout and exit successfully; diagnostic messages belong on stderr. A response has `summary` and an `operations` array. For example, given a job for `S001`, locale `en-US`, and revision `3`:

```json
{
  "summary": "Propose a shorter title for review.",
  "operations": [{
    "slideId": "S001",
    "locale": "en-US",
    "objectId": "S001:title",
    "expectedRevision": 3,
    "kind": "text",
    "value": "A concise title",
    "authorize": []
  }]
}
```

Use the IDs, locale and revision supplied with the actual job. Operations must target the requested slide and language and cannot grant authorization. The application validates and checks proposals for conflicts; protected changes require explicit owner authorization. With `autoApply: false`, inspect and apply proposals in Activity. If explicitly enabled, auto-apply remains subject to permissions and protection; reviewer requests stay proposals. Check the proposed scientific meaning and evidence before applying changes.

Stopping the session or timing out an adapter terminates its owned subprocess tree. Normal adapter completion removes its temporary files. Forced termination or a process crash can leave a `pptimistic-codex-*` directory in the operating system's temporary folder; it can contain a response or schema and should be reviewed before removal.

### Included Codex CLI adapter

The repository includes `scripts/session-codex-agent.mjs`, an optional proposal adapter for an installed, authenticated Codex CLI. It is not enabled automatically. To opt in, create a local JSON configuration with the absolute path to that script:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/PPTimistic/scripts/session-codex-agent.mjs"],
  "timeoutMs": 120000,
  "autoApply": false,
  "usesExternalServices": true,
  "approvedForExternalTransmission": true,
  "usesPaidServices": true,
  "approvedForPaidCalls": true
}
```

Set those approval fields to `true` only when you authorize sending the session request to the configured Codex service and any applicable paid usage. Review the information in the slide, notes and comments before enabling it. This adapter requires both approvals and does not run without them. Start the session using `--agent-config` as above. A usable Codex installation and authentication are required; account access and costs depend on the operator's setup. Consult the [official Codex CLI documentation](https://learn.chatgpt.com/docs/developer-commands#codex-exec).

The adapter runs `codex exec` in a temporary directory with a read-only command sandbox and a structured response schema. It disables shell and unified execution, image viewing, browser/computer use, apps, plugins, hooks, multi-agent execution and web search using CLI settings. These settings reduce exposed tools; they do not provide a comprehensive OS-level read restriction. It sends the requested slide context through stdin, requests text, geometry, style or existing-slide-image changes, validates the response, and removes its temporary directory afterward. Read-only sandboxing and a temporary working directory are not a confidential-data isolation boundary; only use the adapter with data and a Codex environment approved for transmission. Image proposals can only reuse an asset already present on that slide; the adapter cannot generate or fetch images. It returns a proposal for human review by default. Failed or unsafe proposals appear as failed jobs, without changing slide content.

`PPTIMISTIC_CODEX_COMMAND` may point to a native Codex executable when it is not on `PATH`; on Windows use `codex.exe`, not a `.cmd` or `.bat` wrapper. Set `PPTIMISTIC_CODEX_MODEL` in the server environment only if you intend to select a specific model. The adapter otherwise uses the CLI's default model. It ignores user Codex configuration for this invocation and uses an ephemeral session; authentication remains the operator's responsibility.
