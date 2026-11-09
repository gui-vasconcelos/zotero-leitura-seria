/*
 * Leitura Séria — interface.
 *
 * O popup do destaque é só um lançador com três botões. A pergunta, a caixa de
 * resposta e a explicação do modelo ficam num painel ao lado do texto, que empurra
 * o PDF para a esquerda em vez de cobri-lo.
 *
 * Tudo é passivo. Nada aparece nem roda sem um clique, e nunca há mais de uma
 * pergunta por vez. A explicação do modelo é só leitura e descartável, e só vira
 * comentário se o leitor pedir, sempre com o marcador de origem.
 */
(function () {
  "use strict";

  const DEFAULT_PANEL_WIDTH = 380;

  function create(env) {
    const { Zotero, Services, Core } = env;
    const TITLE = "Leitura séria";
    const lastIndex = {};
    const panels = new WeakMap();

    // ---------------------------------------------------------------- preferências

    function pref(name) {
      return Zotero.Prefs.get("leitura-seria." + name);
    }

    function setPref(name, value) {
      Zotero.Prefs.set("leitura-seria." + name, value);
    }

    function prefixFor(kind) {
      if (kind === "modelo") {
        const m = pref("prefix.modelo");
        return m === undefined || m === null ? "M:" : String(m);
      }
      const spec = Core.KINDS[kind];
      if (!spec || !spec.prefixKey) return "";
      const v = pref("prefix." + spec.prefixKey);
      return v === undefined || v === null ? spec.fallbackPrefix : String(v);
    }

    function config() {
      return {
        endpoint: pref("endpoint") || "",
        model: pref("model") || "",
        apiKey: pref("apiKey") || "",
        disableThinking: pref("disableThinking") !== false,
      };
    }

    function panelWidth() {
      const n = parseInt(pref("panelWidth"), 10);
      return Math.min(Math.max(isNaN(n) ? DEFAULT_PANEL_WIDTH : n, 280), 720);
    }

    // ---------------------------------------------------------------- utilidades

    function mainWindow() {
      try {
        return Zotero.getMainWindow();
      } catch (e) {
        return null;
      }
    }

    function shorten(text, max) {
      const flat = String(text || "").replace(/\s+/g, " ").trim();
      return flat.length > max ? flat.slice(0, max).trim() + "…" : flat;
    }

    function fail(e) {
      try {
        Zotero.logError(e);
      } catch (err) {}
      try {
        Services.prompt.alert(mainWindow(), TITLE, (e && e.message) || String(e));
      } catch (err) {}
    }

    function http(url, opts) {
      return Zotero.HTTP.request("POST", url, {
        headers: opts.headers,
        body: opts.body,
        responseType: "text",
        timeout: opts.timeout,
        successCodes: false,
      }).then(function (xhr) {
        return { status: xhr.status, text: xhr.responseText };
      });
    }

    async function ensureKey(cfg) {
      if (!Core.needsKey(cfg)) return cfg;
      const val = { value: "" };
      const ok = Services.prompt.prompt(
        mainWindow(),
        TITLE,
        "Cole a chave da API do modelo. Ela fica guardada nas preferências do Zotero neste computador.",
        val,
        null,
        { value: false }
      );
      if (!ok || !String(val.value).trim()) return null;
      setPref("apiKey", String(val.value).trim());
      return config();
    }

    function metaForAttachment(att) {
      if (pref("sendMetadata") === false) return null;
      try {
        const parent = att && att.parentItemID ? Zotero.Items.get(att.parentItemID) : null;
        if (!parent) return null;
        const creators = parent
          .getCreators()
          .slice(0, 4)
          .map(function (c) {
            return c.lastName || c.name || "";
          })
          .filter(Boolean)
          .join(", ");
        return {
          title: parent.getField("title"),
          creators: creators,
          date: parent.getField("date"),
          abstract: parent.getField("abstractNote"),
        };
      } catch (e) {
        return null;
      }
    }

    async function runExplain(passage, meta) {
      const cfg = await ensureKey(config());
      if (!cfg) {
        return {
          ok: false,
          error: "Sem chave da API. Informe a chave na aba Leitura Séria das configurações do Zotero.",
        };
      }
      return Core.explain(
        { cfg: cfg, passage: passage, meta: meta, language: pref("language") || "português do Brasil" },
        http
      );
    }

    // ---------------------------------------------------------------- gravação

    // Cria um destaque novo a partir da seleção atual, já com o comentário.
    async function saveNewHighlight(reader, ann, comment) {
      if (!ann || !ann.text || !ann.position || ann.sortIndex === undefined || ann.sortIndex === null) {
        throw new Error(
          "A seleção não trouxe posição suficiente para criar o destaque. Faça o destaque do jeito de sempre e use o clique direito nele."
        );
      }
      const attachment = Zotero.Items.get(reader.itemID);
      if (!attachment) throw new Error("Não encontrei o PDF deste leitor.");
      const key = Zotero.DataObjectUtilities.generateKey();
      await Zotero.Annotations.saveFromJSON(attachment, {
        key: key,
        type: "highlight",
        text: ann.text,
        comment: comment,
        color: ann.color || "#ffd400",
        pageLabel: ann.pageLabel || "",
        sortIndex: ann.sortIndex,
        position: ann.position,
      });
      try {
        reader._internalReader.setSelectedAnnotationIDs([key]);
      } catch (e) {}
      return key;
    }

    function getAnnotationItem(reader, key) {
      const att = Zotero.Items.get(reader.itemID);
      if (!att) return null;
      return { att: att, item: Zotero.Items.getByLibraryAndKey(att.libraryID, key) };
    }

    async function appendToComment(item, prefix, text) {
      item.annotationComment = Core.composeComment(item.annotationComment, prefix, text);
      await item.saveTx();
    }

    // ---------------------------------------------------------------- painel lateral

    const MODES = [
      { id: "explicar", label: "Explicar com IA", ai: true, title: "Pede ao modelo uma explicação do trecho. Nada é salvo sem você pedir." },
      { id: "sintese", label: "Síntese", title: "Uma afirmação sua, em uma frase, que viraria uma nota" },
      { id: "tensao", label: "Reflexão", title: "O que o trecho confirma, muda ou complica no que você pensa" },
    ];

    function styled(doc, tag, styles, text) {
      const node = doc.createElement(tag);
      if (styles) Object.assign(node.style, styles);
      if (text !== undefined && text !== null) node.textContent = text;
      return node;
    }

    const SVG_NS = "http://www.w3.org/2000/svg";
    const ACCENT = "99, 102, 241"; // indigo, legível em tema claro e escuro

    // Ícone de "brilhos", o símbolo usual de IA.
    function sparklesIcon(doc) {
      const svg = doc.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "14");
      svg.setAttribute("height", "14");
      svg.setAttribute("aria-hidden", "true");
      svg.style.flex = "none";
      const paths = [
        "M10 3l1.9 5.1L17 10l-5.1 1.9L10 17l-1.9-5.1L3 10l5.1-1.9z",
        "M18.5 14l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z",
      ];
      paths.forEach(function (d) {
        const path = doc.createElementNS(SVG_NS, "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", "currentColor");
        svg.append(path);
      });
      return svg;
    }

    // Os estilos usam !important porque o popup do leitor tem regras próprias para button
    // (por exemplo, largura total), que empilhavam os botões uns sobre os outros.
    function applyStyle(node, rules) {
      Object.keys(rules).forEach(function (k) {
        node.style.setProperty(k, rules[k], "important");
      });
    }

    // variant: "quiet" (padrão), "ai" (destaque) ou "primary" (ação principal do painel).
    function makeButton(doc, label, onClick, title, variant, icon) {
      const b = doc.createElement("button");
      const look = {
        quiet: { bg: "rgba(128,128,128,0.10)", hover: "rgba(128,128,128,0.22)", border: "rgba(128,128,128,0.40)" },
        ai: { bg: "rgba(" + ACCENT + ",0.16)", hover: "rgba(" + ACCENT + ",0.30)", border: "rgba(" + ACCENT + ",0.65)" },
        primary: { bg: "rgba(" + ACCENT + ",0.28)", hover: "rgba(" + ACCENT + ",0.42)", border: "rgba(" + ACCENT + ",0.80)" },
      }[variant || "quiet"];
      applyStyle(b, {
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        gap: "6px",
        width: "auto",
        "min-width": "0",
        margin: "0",
        padding: "5px 12px",
        "box-sizing": "border-box",
        "font-size": "12px",
        "font-weight": variant === "primary" || variant === "ai" ? "600" : "500",
        "line-height": "1.2",
        "white-space": "nowrap",
        border: "1px solid " + look.border,
        "border-radius": "999px",
        background: look.bg,
        color: "inherit",
        cursor: "pointer",
        "box-shadow": "none",
        transition: "background 120ms ease",
      });
      b.type = "button";
      if (icon) b.append(icon);
      b.append(doc.createTextNode(label));
      if (title) b.title = title;
      b.addEventListener("mouseenter", function () {
        b.style.setProperty("background", look.hover, "important");
      });
      b.addEventListener("mouseleave", function () {
        b.style.setProperty("background", look.bg, "important");
      });
      // Não deixa o clique roubar o foco, para a seleção de texto continuar viva.
      b.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
      b.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    }

    function modeButton(doc, m, onClick) {
      return makeButton(doc, m.label, onClick, m.title, m.ai ? "ai" : "quiet", m.ai ? sparklesIcon(doc) : null);
    }

    function buttonRow(doc, buttons) {
      const row = styled(doc, "div", { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" });
      buttons.forEach(function (b) {
        row.append(b);
      });
      return row;
    }

    function buildPanel(reader, readerDoc) {
      const win = readerDoc.defaultView;
      const body = readerDoc.body || readerDoc.documentElement;
      const width = panelWidth();
      const previousPadding = body.style.paddingRight;
      const previousBoxSizing = body.style.boxSizing;

      let open = true;
      let token = 0; // descarta respostas do modelo que chegam depois de o leitor mudar de ideia
      let target = null;
      let mode = null;
      const modeButtons = {};

      // Avisa o leitor de que o espaço mudou, para ele reposicionar as páginas.
      function nudge() {
        try {
          win.dispatchEvent(new win.Event("resize"));
        } catch (e) {}
      }

      // A moldura fica no documento do leitor, mas todo o conteúdo mora num iframe próprio.
      // O leitor escuta o teclado na janela dele (setas, Delete, atalhos) e cancelava as setas
      // dentro da caixa de texto. Eventos de teclado dentro de um iframe não chegam lá.
      const outer = styled(readerDoc, "div", {
        position: "fixed",
        top: "40px",
        right: "0",
        bottom: "0",
        width: width + "px",
        maxWidth: "90vw",
        boxSizing: "border-box",
        background: "var(--material-background, Canvas)",
        color: "var(--fill-primary, CanvasText)",
        borderLeft: "1px solid rgba(128,128,128,0.45)",
        boxShadow: "-3px 0 10px rgba(0,0,0,0.12)",
        zIndex: "2147483000",
      });
      outer.id = "leitura-seria-panel";
      const frame = styled(readerDoc, "iframe", {
        display: "block",
        width: "100%",
        height: "100%",
        border: "0",
        background: "transparent",
      });
      frame.title = TITLE;
      let doc = null;
      // Se o navegador trocar o documento do iframe depois de criado, o conteúdo some. Nesse caso
      // refazemos o painel do zero com o mesmo alvo e o mesmo modo.
      frame.addEventListener("load", function () {
        if (!open || !doc || frame.contentDocument === doc) return;
        const t = target;
        const m = mode;
        close();
        try {
          openPanel(reader, readerDoc, t, m);
        } catch (e) {
          fail(e);
        }
      });
      outer.append(frame);
      body.append(outer);

      doc = frame.contentDocument;
      if (!doc || !doc.body) {
        outer.remove();
        throw new Error("Não consegui criar o painel dentro do leitor.");
      }

      // O iframe não herda o tema do leitor, então copiamos as cores já resolvidas.
      let resolved = {};
      try {
        resolved = win.getComputedStyle(outer);
      } catch (e) {}
      if (resolved.colorScheme) doc.documentElement.style.colorScheme = resolved.colorScheme;
      if (resolved.backgroundColor) doc.documentElement.style.background = resolved.backgroundColor;
      Object.assign(doc.body.style, {
        margin: "0",
        padding: "10px 14px 14px",
        boxSizing: "border-box",
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        fontSize: "13px",
        lineHeight: "1.45",
        fontFamily: resolved.fontFamily || "system-ui, sans-serif",
        color: resolved.color || "CanvasText",
        background: "transparent",
      });

      const el = function (tag, styles, text) {
        return styled(doc, tag, styles, text);
      };
      const button = function (label, onClick, title) {
        return makeButton(doc, label, onClick, title);
      };

      function close() {
        if (!open) return;
        open = false;
        token++;
        outer.remove();
        body.style.paddingRight = previousPadding;
        body.style.boxSizing = previousBoxSizing;
        nudge();
      }

      const header = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between" });
      header.append(el("strong", { fontSize: "13px" }, TITLE));
      header.append(button("×", close, "Fechar o painel"));

      const modeBar = el("div", { display: "flex", flexWrap: "wrap", gap: "6px" });
      MODES.forEach(function (m) {
        const b = modeButton(doc, m, function () {
          setMode(m.id);
        });
        modeButtons[m.id] = b;
        modeBar.append(b);
      });

      const quote = el("div", {
        fontStyle: "italic",
        opacity: "0.85",
        borderLeft: "3px solid rgba(128,128,128,0.5)",
        paddingLeft: "8px",
        maxHeight: "120px",
        overflowY: "auto",
      });

      const content = el("div", { display: "flex", flexDirection: "column", gap: "8px" });

      doc.body.append(header, modeBar, quote, content);
      body.style.boxSizing = "border-box";
      body.style.paddingRight = width + "px";
      nudge();

      function markActive(id) {
        MODES.forEach(function (m) {
          const on = m.id === id;
          modeButtons[m.id].style.setProperty("box-shadow", on ? "0 0 0 2px rgba(" + ACCENT + ",0.75)" : "none", "important");
        });
      }

      function setMode(id) {
        token++;
        mode = id;
        markActive(id);
        if (id === "explicar") explainView();
        else formView(id);
      }

      function idleView() {
        token++;
        markActive(null);
        content.replaceChildren(el("div", { opacity: "0.75" }, "Escolha Explicar com IA, Síntese ou Reflexão."));
      }

      // Grava a resposta. Depois do primeiro salvamento a seleção virou um destaque,
      // e as próximas respostas se somam ao comentário dele em vez de criar outro.
      async function commit(prefix, text) {
        if (target.key) {
          const found = getAnnotationItem(reader, target.key);
          if (!found || !found.item) throw new Error("Não encontrei a anotação no Zotero.");
          await appendToComment(found.item, prefix, text);
          return;
        }
        const key = await saveNewHighlight(reader, target.ann, Core.composeComment("", prefix, text));
        target = { passage: target.passage, key: key };
      }

      function formView(kind) {
        token++;
        content.replaceChildren();
        const prefix = prefixFor(kind);
        const q = Core.nextQuestion(kind, lastIndex[kind]);
        lastIndex[kind] = q.index;

        content.append(el("div", { fontWeight: "600" }, q.text));

        const ta = el("textarea", {
          width: "100%",
          boxSizing: "border-box",
          minHeight: "150px",
          fontSize: "13px",
          fontFamily: "inherit",
          lineHeight: "1.45",
          color: "inherit",
          background: "transparent",
          border: "1px solid rgba(128,128,128,0.5)",
          borderRadius: "4px",
          padding: "6px 8px",
          resize: "vertical",
        });
        ta.rows = 7;
        // O leitor tem atalhos de teclado. Sem isto, digitar aqui poderia acionar um deles.
        ["keydown", "keyup", "keypress"].forEach(function (type) {
          ta.addEventListener(type, function (e) {
            e.stopPropagation();
            if (type === "keydown" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              save();
            }
          });
        });
        content.append(ta);

        const status = el("div", { opacity: "0.85" });
        let saving = false;
        async function save() {
          if (saving) return;
          const text = ta.value.trim();
          if (!text) {
            status.textContent = "Escreva algo antes de salvar.";
            return;
          }
          saving = true;
          status.textContent = "Salvando…";
          try {
            await commit(prefix, text);
            ta.value = "";
            status.textContent = "Salvo no comentário do destaque.";
          } catch (e) {
            status.textContent = (e && e.message) || String(e);
          }
          saving = false;
        }

        content.append(
          buttonRow(doc, [
            makeButton(
              doc,
              prefix ? "Salvar (" + prefix + ")" : "Salvar",
              save,
              "Grava a resposta no comentário do destaque. Ctrl+Enter também salva.",
              "primary"
            ),
            button("Outra pergunta", function () {
              formView(kind);
            }),
          ]),
          status
        );
        try {
          ta.focus();
        } catch (e) {}
      }

      async function explainView() {
        const mine = ++token;
        content.replaceChildren();
        if (!target.passage || !String(target.passage).trim()) {
          content.append(el("div", null, "Este destaque não tem texto para explicar."));
          return;
        }
        content.append(el("div", { opacity: "0.8" }, "Consultando o modelo…"));
        content.append(buttonRow(doc, [button("Cancelar", idleView)]));

        let result;
        try {
          result = await runExplain(target.passage, metaForAttachment(Zotero.Items.get(reader.itemID)));
        } catch (e) {
          result = { ok: false, error: (e && e.message) || String(e) };
        }
        if (mine !== token) return;

        content.replaceChildren();
        if (!result.ok) {
          content.append(el("div", { whiteSpace: "pre-wrap" }, result.error));
          content.append(buttonRow(doc, [button("Tentar de novo", explainView)]));
          return;
        }

        content.append(
          el(
            "div",
            { fontStyle: "italic", opacity: "0.75" },
            "Explicação do modelo. Não foi salva e pode conter erros."
          )
        );
        content.append(el("div", { whiteSpace: "pre-wrap", maxHeight: "300px", overflowY: "auto" }, result.content));

        const marker = prefixFor("modelo");
        const status = el("div", { opacity: "0.85" });
        let saving = false;
        async function saveExplanation() {
          if (saving) return;
          saving = true;
          status.textContent = "Salvando…";
          try {
            await commit(marker, result.content);
            status.textContent = "Salvo no comentário do destaque" + (marker ? " com a marcação " + marker : "") + ".";
          } catch (e) {
            status.textContent = (e && e.message) || String(e);
          }
          saving = false;
        }
        content.append(
          buttonRow(doc, [
            makeButton(
              doc,
              marker ? "Salvar (" + marker + ")" : "Salvar",
              saveExplanation,
              "Grava esta explicação no comentário, marcada como vinda do modelo",
              "primary"
            ),
            button("Com as minhas palavras", function () {
              mode = "compreensao";
              markActive(null);
              formView("compreensao");
            }, "Tente dizer o trecho do seu jeito agora"),
          ]),
          status
        );
      }

      return {
        root: outer,
        isOpen: function () {
          return open && outer.isConnected;
        },
        close: close,
        show: function (t, m) {
          target = t;
          const passage = t.passage ? shorten(t.passage, 700) : "";
          quote.textContent = passage || "(anotação sem texto)";
          quote.title = t.passage || "";
          setMode(m || "sintese");
        },
        get mode() {
          return mode;
        },
      };
    }

    function openPanel(reader, hintDoc, target, mode) {
      const doc = hintDoc || (reader._iframeWindow && reader._iframeWindow.document);
      if (!doc) throw new Error("Não encontrei a janela do leitor.");
      let panel = panels.get(doc);
      if (!panel || !panel.isOpen()) {
        panel = buildPanel(reader, doc);
        panels.set(doc, panel);
      }
      panel.show(target, mode);
      return panel;
    }

    // ---------------------------------------------------------------- popup do destaque

    function renderPopup(event) {
      const reader = event.reader;
      const doc = event.doc;
      const ann = event.params && event.params.annotation;
      if (!ann || !ann.text || !String(ann.text).trim()) return;

      // Primeira linha: Explicar com IA, em destaque e na largura toda.
      // Segunda linha: as duas ações que não usam modelo, lado a lado.
      const row = styled(doc, "div", {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "6px",
        marginTop: "8px",
        paddingTop: "10px",
        borderTop: "1px solid rgba(128,128,128,0.35)",
        fontSize: "12px",
        color: "inherit",
      });
      MODES.forEach(function (m) {
        const b = modeButton(doc, m, function () {
          try {
            openPanel(reader, doc, { passage: ann.text, ann: ann }, m.id);
          } catch (e) {
            fail(e);
          }
        });
        b.style.setProperty("width", "100%", "important");
        if (m.ai) b.style.gridColumn = "1 / -1";
        row.append(b);
      });
      event.append(row);
    }

    // ---------------------------------------------------------------- menu de clique direito

    function registerMenu(event) {
      const reader = event.reader;
      const ids = (event.params && event.params.ids) || [];
      const single = ids.length === 1;

      function launcher(mode) {
        return function () {
          if (!single) return;
          Promise.resolve()
            .then(function () {
              const found = getAnnotationItem(reader, ids[0]);
              if (!found || !found.item) throw new Error("Não encontrei a anotação no Zotero.");
              openPanel(reader, null, { passage: found.item.annotationText || "", key: ids[0] }, mode);
            })
            .catch(fail);
        };
      }

      event.append({ label: "Leitura séria - Explicar este trecho", disabled: !single, onCommand: launcher("explicar") });
      event.append({ label: "Leitura séria - Síntese", disabled: !single, onCommand: launcher("sintese") });
      event.append({ label: "Leitura séria - Reflexão", disabled: !single, onCommand: launcher("tensao") });
    }

    return { renderPopup, registerMenu, openPanel, saveNewHighlight, runExplain, prefixFor, config, panelWidth };
  }

  const UI = { create };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = UI;
  } else if (typeof _globalThis !== "undefined") {
    _globalThis.LeituraUI = UI;
  }
})();
