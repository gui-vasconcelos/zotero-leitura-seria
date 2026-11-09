# Leitura Séria

An open-source plugin for Zotero 7 and later that gives on-demand help inside the PDF reader, for people who read scientific papers and want to leave the reading with better notes. Everything is passive. Nothing appears or runs without a click, and there is never more than one question at a time.

The idea comes from two sources. From Mortimer Adler, the rule of understanding before criticizing. From Andy Matuschak, the idea that the goal is not to take notes better but to think better, by writing in your own words and in the form of claims.

> **Disclaimer**
>
> - **Experimental.** This is a v0.x prototype. Expect rough edges and breaking changes.
> - **Written with AI assistance.** The code, tests and this README were written together with Claude (Anthropic) and reviewed only lightly by a human.
> - **Barely tested in real life.** It has been installed and tried by hand on one machine only (Zotero 10.0.7, Windows 11). Everything else is tested only against a simulated Zotero (see Tests), which does not replace the real thing. The side panel layout in particular has not been verified across Zotero versions.
> - **Your text can leave your computer.** The Explain button sends the selected passage (and, if enabled, the paper's title, authors, date and abstract) to the API endpoint you configure. With a cloud service such as DeepSeek that means a third party receives it. Use a local model for unpublished or embargoed material.
> - **Your API key is stored in plain text** in Zotero's preferences, like most Zotero plugins do.
> - **Model output can be wrong.** Explanations are read-only, are never saved on their own, and are marked `M:` when you do save them, so that they are not mistaken for your own thinking.
> - **Not affiliated** with Zotero, Corporation for Digital Scholarship, DeepSeek, Anthropic, Mortimer Adler or Andy Matuschak.
> - **No warranty.** Provided as is under the MIT license. Back up your library before trying it, as the plugin creates and edits annotations.
> - **Portuguese interface for now.** All buttons, messages and the question bank are in Brazilian Portuguese. Translating them is planned, see Roadmap.
> - **Placeholder update URL.** The manifest points `update_url` at `example.com` only because Zotero 10 refuses to install plugins without one. There are no automatic updates.

## What it does

Select text in a PDF and the popup gets a small row with three buttons. When a highlight or underline tool is active, Zotero creates the annotation straight away and shows no selection popup, so the plugin opens the side panel (with no question yet) as soon as such an annotation is created. This can be turned off in the plugin's settings. They only launch a side panel that opens next to the PDF, so you can keep seeing what you are reading. The panel pushes the page to the left instead of covering it, and its width is configurable.

**Explicar com IA (Explain with AI)** asks the model for a short explanation of the passage. The answer is read-only and is not saved. The prompt tells the model to point to the term that carries the argument, not to summarize the text, not to evaluate the author, and to say which context is missing when there is some. If you want to keep it, Save puts the explanation in the annotation comment, starting with the marker `M:` (configurable) so its origin stays clear. After an explanation, the button "Com as minhas palavras" (In my own words) opens a comprehension question so you can try to say the passage your own way.

**Síntese (Synthesis)** shows a question asking for a one-sentence claim of your own, like the title of an atomic note. The answer goes into the highlight's comment with the prefix `N:`.

**Reflexão (Reflection)** asks what the passage confirms, changes or complicates in what you already think. The answer goes in with the prefix `→`.

Questions come from a rotating bank and never repeat the one that just appeared. "Outra pergunta" swaps the current one. Ctrl+Enter saves. The first save turns the selection into a highlight, and later answers for the same passage are appended to that highlight's comment, one entry per line.

For highlights that already exist, the same three actions are in the right-click menu of the annotation in the sidebar: *Leitura séria - Explicar este trecho*, *Leitura séria - Síntese* and *Leitura séria - Reflexão*. They open the same side panel, and answers are appended to the existing comment.

Only Explain with AI uses an AI model. Synthesis and Tension work offline and without a key.

## Installation

1. Download `leitura-seria-0.2.4.xpi` (from the Releases page, or build it yourself, see below).
2. In Zotero, open Tools, then Plugins.
3. Click the gear, choose Install Plugin From File and select the `.xpi`.

On first use of Explain the plugin asks for the API key if none is set. It can also be entered in the Leitura Séria tab of Zotero's settings.

## Configuration

The default points to DeepSeek with the model `deepseek-v4-flash` and thinking mode turned off. The legacy names `deepseek-chat` and `deepseek-reasoner` were retired by DeepSeek in July 2026, and on V4 models thinking is on by default, which is why the plugin turns it off explicitly. If your endpoint rejects the `thinking` parameter, turn that option off in the settings.

Any endpoint compatible with the OpenAI chat completions API works, including local models. `localhost` endpoints need no key.

You can also change the explanation language, the three prefixes (leave blank for none), the panel width, and whether the paper's title, authors, date and abstract are sent along with the passage.

## Privacy

When Explain is used with a cloud service, the selected passage leaves your computer, together with the paper's title, authors, date and abstract if that option is on. For unpublished or embargoed texts, point the endpoint at a local model. The API key sits in Zotero's preferences in plain text.

## About update_url

Zotero 10 refuses to install plugins whose `manifest.json` does not declare `applications.zotero.update_url`, so the manifest carries a placeholder on `example.com`. The update check fails silently, which does not get in the way of using the plugin. If the plugin is ever distributed properly, replace it with a real `updates.json` as described in Zotero's developer documentation.

## Known limitations

- Only tried by hand on Zotero 10.0.7 (Windows 11). The side panel makes room by adding padding to the reader's document, which may not reflow the PDF view in every version. If the panel overlaps the page instead, that is the cause; the panel can still be closed with the × button.
- Questions do not change with the section of the paper or with your reading history. The Zotero reader does not expose a page-change event or the current section, so this waits for a reliable way to do it.
- PDFs with selectable text only. In EPUB and snapshots the popup may not provide the position needed, and the plugin then says so and suggests the right-click path.
- The capture question bank exists but is not exposed yet; only the comprehension questions are, after Explain.
- Interface and questions are in Brazilian Portuguese.

## Roadmap ideas

Nothing here is promised. It is a list to argue with.

- English (and other) interface strings and question banks, chosen by a language setting.
- A capture question for quick fleeting notes while reading ("what is this passage doing for the argument?").
- Questions that depend on the section of the paper, if the reader ever exposes it.
- A helper that exports `N:`, `→` and `M:` comments in a clean format for Obsidian or other note tools, keeping the Zotero-side plugin free of any note-linking features.
- A short "before you leave this page" prompt, only on click, to rehearse the page in your own words.
- Per-collection or per-paper question presets (methods paper versus theory paper).
- Hiding or showing `M:` comments in the sidebar, so model text never mixes with your own.
- An optional local-only mode that disables Explain entirely.

## Tests

```
npm install
npm test
```

The tests run the logic and the interface against a simulated Zotero, using jsdom. They cover the popup, the side panel, the menu, saving comments, error handling, preferences, and loading `bootstrap.js` the way Zotero does. They do not replace using the plugin in a real Zotero.

## Building the installable

```
bash build.sh
```

## Structure

```
manifest.json     plugin metadata
bootstrap.js      lifecycle and registration of the reader hooks
prefs.js          default preference values
prefs.xhtml       preferences pane
lib/core.js       pure logic, question bank, prompt and model call
lib/ui.js         popup launcher, side panel, context menu and saving
test/run.js       tests
```

## License

MIT. See the LICENSE file.
