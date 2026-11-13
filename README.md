# PPTimistic

**Creator-led, editable PowerPoint presentations — with sources, decisions and revisions kept together.**

PPTimistic is a local-first Node.js toolkit for building reproducible presentations with a coding agent or from the terminal. Text, shapes, diagrams, notes, and supported charts remain editable in PowerPoint. No account, paid provider or API key is required.

[Français](README.fr.md) · [Creator onboarding](docs/onboarding.md) · [Full workflows](docs/workflows.md) · [Limitations](docs/limitations.md)

![PPTimistic collaborative studio](docs/studio-preview.png)

*The local studio edits slide objects and enables collaborative review.*

## Start here — a real presentation

**Requirement:** Node.js 22.13+ and npm. You may [create a repository from this GitHub template](https://github.com/new?template_name=PPTimystic&template_owner=dhuzard), or clone the [PPTimystic source](https://github.com/dhuzard/PPTimystic).

```sh
git clone https://github.com/dhuzard/PPTimystic.git
cd PPTimystic
npm install
npm run new -- --project my-talk --inputs "path/to/sources" --no-render
```

The **interactive** setup first asks for the title, languages and visual theme, then runs a **mandatory creator interview**. It collects the creator's profile and working preferences, the desired audience outcome, prior knowledge, key message, format/duration, content scope, evidence, caveats, tone, visuals and constraints. The creator reviews the summary and must explicitly approve it.

The new project is then ready for slide authoring. **It does not turn imported documents into an AI-written presentation or silently export a fictional deck.** A person or coding agent must author `projects/my-talk/content/slides.yaml` based on the approved brief and sources.

```sh
npm run brief -- --project my-talk --check    # Confirm the onboarding gate is open
npm run build -- --project my-talk            # Generate editable PowerPoint
npm run validate -- --project my-talk         # Check source, slides and outputs
npm run render -- --project my-talk           # Optional; needs a local renderer
npm run bundle -- --project my-talk           # Verified delivery package
```

PowerPoint files are written to `projects/my-talk/output/presentation.<locale>.pptx`. Source documents stay local, with hashes and extraction records. The output requires substantive scientific and visual review; automated checks do not prove that the evidence supports a claim.

### Running without an interactive terminal

`--yes` **never approves a real presentation**. It creates a draft that cannot be built or exported until a creator completes and approves the brief in an interactive terminal:

```sh
npm run new -- --project my-talk --yes --inputs "path/to/sources" --no-render
npm run brief -- --project my-talk            # Creator interview and approval
npm run brief -- --project my-talk --check
```

To review a manually edited `presentation-brief.yaml`, use `npm run brief -- --project my-talk --approve`. Editing any approved answer invalidates its content fingerprint and reopens the gate until approval is renewed. The separate `presentation-brief.md` is for supplemental notes, **not** validated consent.

For question-by-question guidance, commands and troubleshooting, see [Creator onboarding](docs/onboarding.md). Existing legacy projects remain usable; the enforced gate is enabled for newly created real projects.

## Try the fictional demo

Want to see the toolkit before creating a real presentation?

```sh
npm run demo -- --project demo --no-render
npm run session -- --project demo --port 0
```

This creates a five-slide English/French example with **fictional chart data**, not a real research presentation. Unattended `npm run setup -- --yes` with no source documents is also a demo-only path. Use `npm run new` for real work.

![Five fictional demo slides](docs/demo-contact-sheet.png)

## Presentations and source material

Create a project with `--inputs "path/to/folder"` to retain local source documents. Supported extraction includes text-based PDFs, DOCX paragraphs, Markdown/TXT and CSV; images are retained as assets. Extraction is **not** scientific interpretation. Your agent must use the approved brief, inspect the evidence and clearly mark missing support.

To import a literal Markdown slide plan (one file with `##` headings), use:

```sh
npm run new -- --project planned-talk --inputs "path/to/plan-folder" --from-plan --source en-US --locales en-US --yes
npm run brief -- --project planned-talk
npm run build -- --project planned-talk
```

`--from-plan` preserves heading order and copies text, but does not synthesize results or improve poor slide density. Long text may fail validation. Use `npm run claims -- --project my-talk` for optional source-to-claim provenance checks; they verify links/hashes, not scientific truth.

## Review and collaborate

```sh
npm run session -- --project my-talk --port 0
```

The shared local studio prints distinct owner, editor and reviewer invitation URLs. Participants can edit native slide objects, comment and propose revisions. **An unapproved real project cannot be exported**, including through the studio. The optional local agent adapter needs explicit configuration and is off by default. See [sessions](docs/session.md).

A reviewed presentation should communicate one central message per slide without losing evidence qualifications. Titles must not overstate causal claims, and more than one coordinated visual may be useful. Sources on slide design include [Naegle (2021)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8638955/), [Mayer (2020)](https://doi.org/10.1017/9781316941355), [Sweller et al. (2019)](https://doi.org/10.1007/s10648-019-09465-5) and [Garner & Alley (2013)](https://www.ijee.ie/articles/Vol29-6/23_ijee2791ns.pdf). They inform editorial practice but do **not** establish that PPTimistic itself improves learning.

## Illustrations, translations and revisions

Put visual references in `projects/<name>/assets/reference/`. Ask your agent to inspect them and update `illustration-style.md`; no automated style analysis is claimed. `npm run images -- --project research-talk` writes detailed prompts and asset metadata. Native diagrams work without an image service. Attach a local illustration with `--slide S002 --asset "path/to/figure.png"`; replacing accepted assets also needs `--authorize S002`.

French and English demo content is included. Other translations can be supplied manually:

```sh
npm run translate -- --project research-talk --to it-IT
# Fill every translation object in the reported YAML file, then:
npm run translate -- --project research-talk --to it-IT --file "path/to/completed-request.yaml"
npm run build -- --project research-talk
```

Missing translations block that language's export. Numbers, units, DOIs and protected glossary terms are checked. Translation still needs scientific review.
For a fictional chart in a language beyond English or French, fill its `fictionalNotice` field with a reviewed, visible disclosure in that language; the build will otherwise stop.

```sh
npm run revise -- --project research-talk --slide S002 --message "Less text; preserve the scientific meaning."
```

Feedback is logged for your coding agent; the CLI does not pretend to interpret natural language. Say, “Apply the feedback on S002 and rebuild; keep approved slides unchanged.” Structured revisions are supported too; see [the workflow guide](docs/workflows.md). Approved or locked content requires explicit authorization for changes. Each successful rebuild keeps earlier output versions. Manually modified PPTX files are detected and never overwritten.

For local delivery, run `npm run bundle -- --project research-talk`. It verifies current PPTX files and creates `output/deliveries/<id>/` with the decks, validation results and a hash manifest. Add `--previews latest` to include current rendered previews. Original inputs are excluded unless you name each file with `--input inputs/filename`; inspect the bundle before sharing it.

## Continuous integration previews

GitHub Actions checks Node 22.13 and 24 on Linux, macOS and Windows. The Linux Node 22.13 job renders the public typography fixture and uploads only its preview images and `qa-manifest.json` for seven days. The manifest records renderer, locale, theme, slide IDs and images still needing human inspection; CI does not claim visual or screen-reader inspection.

## Help and troubleshooting

```sh
npm run doctor
npm run build -- --help
npm run demo
npm run check
```

If previews are unavailable, install LibreOffice plus `pdftoppm` (Poppler); Windows can also use installed PowerPoint. Set `SOFFICE_PATH` or `PDFTOPPM_PATH` if detection fails. The render command reports the missing local tools and the PPTX remains available. For “Input folder not found,” check the full path and pass the directory containing the files; use `--from-plan` only with exactly one Markdown file containing `##` slide headings. Setup checks Node, dependencies and writable storage before creating a project; `npm run doctor` reports which prerequisite needs repair. Set `font` in project YAML to an installed font; Arial is the portable default, and Inter is preferred when available. Do not redistribute proprietary fonts.

For “externally modified PPTX,” keep a separate copy and reconcile its changes into YAML before rebuilding. Direct PowerPoint edits do **not** update source files. Never delete the output or history until edits have been reconciled. For “missing translation” or “text overflow,” complete the translation or shorten the relevant slide; validation identifies its stable ID.

By default, the CLI processes presentation files locally and makes no AI network calls. An explicitly configured session agent adapter can invoke an external service. A coding agent is a separate service with its own data handling: if you use one, the agent and its connected tools may transmit source documents, extracted text or prompts outside your computer. Review that agent's configuration and policies, and do not expose confidential material unless you have explicitly approved the destination and scope. No network AI provider or agent is enabled by default.

Project folders are ignored by Git by default, except the public fictional demo source. Do not add confidential inputs or generated materials to a public repository.

See [architecture and content schema](docs/architecture.md), [workflows and manual edit reconciliation](docs/workflows.md), [privacy and providers](docs/providers.md), and [release limitations](docs/limitations.md). PPTimistic is a standalone GitHub template. The CLI keeps project files local unless you deliberately publish them; review an agent's separate data handling before using one.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for development and testing, and [SECURITY.md](SECURITY.md) for reporting security issues. The project is available under the [MIT license](LICENSE).
