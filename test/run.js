/* Testes da lógica e da interface do plugin contra um Zotero simulado.
 * Não substituem um teste dentro do Zotero de verdade, mas pegam erros de lógica,
 * de fluxo e de carregamento antes de instalar. Rode com `npm test`.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const Core = require(path.join(ROOT, "lib", "core.js"));

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------ Zotero simulado

function makeEnv(opts = {}) {
  const prefs = Object.assign(
    {
      "leitura-seria.endpoint": "https://api.deepseek.com",
      "leitura-seria.model": "deepseek-v4-flash",
      "leitura-seria.apiKey": "sk-test",
      "leitura-seria.disableThinking": true,
      "leitura-seria.sendMetadata": true,
      "leitura-seria.language": "português do Brasil",
      "leitura-seria.prefix.sintese": "N:",
      "leitura-seria.prefix.tensao": "→",
      "leitura-seria.prefix.modelo": "M:",
    },
    opts.prefs || {}
  );

  const saved = [];
  const httpCalls = [];
  const errors = [];
  const annItems = {};
  const promptCalls = [];
  const alerts = [];
  const promptQueue = [];
  const confirmQueue = [];
  const selected = [];
  let keyCounter = 0;

  const parent = {
    getCreators: () => [{ lastName: "Höök" }, { lastName: "Vasconcelos" }],
    getField: (f) =>
      ({
        title: "Designing with the Body",
        date: "2018",
        abstractNote: "Um livro sobre soma design e somaestética.",
      })[f] || "",
  };
  const attachment = { id: 1, libraryID: 1, parentItemID: 2 };

  const Zotero = {
    // O Zotero real resolve "leitura-seria.x" para "extensions.zotero.leitura-seria.x".
    // Aqui o mapa já usa a chave curta.
    Prefs: {
      get: (k) => prefs[k],
      set: (k, v) => {
        prefs[k] = v;
      },
    },
    Items: {
      get: (id) => (id === 1 ? attachment : id === 2 ? parent : null),
      getByLibraryAndKey: (lib, key) => annItems[key] || null,
    },
    DataObjectUtilities: { generateKey: () => "KEY" + String(++keyCounter).padStart(5, "0") },
    Annotations: {
      saveFromJSON: async (att, json) => {
        saved.push({ att, json });
      },
    },
    HTTP: {
      request: (method, url, o) => {
        httpCalls.push({ method, url, opts: o });
        const r = typeof opts.http === "function" ? opts.http({ method, url, opts: o }) : opts.http;
        return Promise.resolve(r).then((x) => {
          if (x instanceof Error) throw x;
          return x;
        });
      },
    },
    ProgressWindow: class {
      changeHeadline() {}
      addDescription() {}
      show() {}
      close() {}
    },
    getMainWindow: () => ({}),
    logError: (e) => errors.push(e),
    debug: () => {},
  };

  const P = { BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_TITLE_IS_STRING: 127 };
  const Services = {
    prompt: Object.assign(P, {
      prompt(win, title, text, val) {
        promptCalls.push({ title, text });
        const ans = promptQueue.shift();
        if (!ans) return false;
        val.value = ans.value;
        return ans.ok;
      },
      alert(win, title, text) {
        alerts.push({ title, text });
      },
      confirmEx(win, title, text) {
        promptCalls.push({ title, text, confirm: true });
        return confirmQueue.length ? confirmQueue.shift() : 1;
      },
    }),
  };

  const reader = {
    itemID: 1,
    _internalReader: { setSelectedAnnotationIDs: (ids) => selected.push(ids) },
  };

  return {
    Zotero, Services, reader, prefs, saved, httpCalls, errors, annItems, promptCalls, alerts,
    promptQueue, confirmQueue, selected,
  };
}

function okResponse(content) {
  return { status: 200, responseText: JSON.stringify({ choices: [{ message: { content } }] }) };
}

// Carrega lib/*.js do mesmo jeito que o bootstrap faz, via escopo com _globalThis.
function loadLib(env) {
  const ctx = vm.createContext({ Zotero: env.Zotero, Services: env.Services });
  ctx._globalThis = ctx;
  for (const f of ["core.js", "ui.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "lib", f), "utf8"), ctx, { filename: f });
  }
  assert.ok(ctx.LeituraCore, "LeituraCore deveria ser exposto via _globalThis");
  assert.ok(ctx.LeituraUI, "LeituraUI deveria ser exposto via _globalThis");
  return ctx.LeituraUI.create({ Zotero: env.Zotero, Services: env.Services, Core: ctx.LeituraCore });
}

function makePopup(env, annotationOverrides) {
  const dom = new JSDOM("<!doctype html><body><div id='host'></div></body>");
  const doc = dom.window.document;
  const host = doc.getElementById("host");
  const ui = loadLib(env);
  const annotation = Object.assign(
    {
      type: "highlight",
      text: "A atmosfera emerge entre o corpo e o espaço.",
      color: "#ffd400",
      pageLabel: "3",
      sortIndex: "00002|000100|00200",
      position: { pageIndex: 2, rects: [[10, 20, 30, 40]] },
    },
    annotationOverrides || {}
  );
  ui.renderPopup({ reader: env.reader, doc, params: { annotation }, append: (n) => host.append(n) });
  const fire = (b) => b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  // Botões do lançador no popup.
  const buttons = () => [...host.querySelectorAll("button")];
  const find = (label) => buttons().find((b) => b.textContent.startsWith(label));
  const click = (label) => {
    const b = find(label);
    assert.ok(b, "botão não encontrado " + label + " entre " + buttons().map((x) => x.textContent).join(" | "));
    fire(b);
  };
  // Painel lateral.
  const panel = () => doc.getElementById("leitura-seria-panel");
  const ptext = () => (panel() ? panel().textContent : "");
  const pbuttons = () => (panel() ? [...panel().querySelectorAll("button")] : []);
  const pfind = (label) => pbuttons().find((b) => b.textContent.startsWith(label));
  const pclick = (label) => {
    const b = pfind(label);
    assert.ok(b, "botão do painel não encontrado " + label + " entre " + pbuttons().map((x) => x.textContent).join(" | "));
    fire(b);
  };
  return { dom, doc, host, ui, annotation, buttons, find, click, panel, ptext, pbuttons, pfind, pclick };
}

// ------------------------------------------------------------------ núcleo

test("nextQuestion nunca repete a última e respeita o banco", () => {
  for (const kind of Object.keys(Core.QUESTIONS)) {
    for (let last = 0; last < Core.QUESTIONS[kind].length; last++) {
      for (let i = 0; i < 50; i++) {
        const q = Core.nextQuestion(kind, last);
        assert.notEqual(q.index, last);
        assert.equal(q.text, Core.QUESTIONS[kind][q.index]);
      }
    }
  }
  assert.throws(() => Core.nextQuestion("inexistente"));
  assert.equal(Core.nextQuestion("sintese", undefined, () => 0.999999).index, Core.QUESTIONS.sintese.length - 1);
});

test("composeComment junta com prefixo, sem duplicar e sem perder o que existe", () => {
  assert.equal(Core.composeComment("", "N:", "uma ideia"), "N: uma ideia");
  assert.equal(Core.composeComment("", "", "sem prefixo"), "sem prefixo");
  assert.equal(Core.composeComment("→ antes", "N:", "depois"), "→ antes\nN: depois");
  assert.equal(Core.composeComment("", "N:", "N: já tem"), "N: já tem");
  assert.equal(Core.composeComment("existente", "N:", "   "), "existente");
  assert.equal(Core.composeComment(null, "N:", "x\n\n\n\ny"), "N: x\n\ny");
});

test("cleanPassage normaliza espaços e corta textos longos", () => {
  assert.equal(Core.cleanPassage("a  b\n c"), "a b c");
  const out = Core.cleanPassage("x".repeat(5000));
  assert.ok(out.length < 4100 && out.endsWith("[trecho cortado]"));
});

test("buildRequest monta URL, cabeçalhos e corpo para o DeepSeek", () => {
  const msgs = Core.buildExplainMessages({ passage: "trecho", meta: null, language: "português do Brasil" });
  const r = Core.buildRequest(
    { endpoint: "https://api.deepseek.com/", model: "deepseek-v4-flash", apiKey: "sk-x", disableThinking: true },
    msgs
  );
  assert.equal(r.url, "https://api.deepseek.com/chat/completions");
  assert.equal(r.headers.Authorization, "Bearer sk-x");
  const body = JSON.parse(r.body);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].role, "system");
  assert.ok(body.messages[1].content.includes("trecho"));

  const r2 = Core.buildRequest(
    { endpoint: "http://localhost:11434/v1/chat/completions", model: "m", apiKey: "", disableThinking: false },
    msgs
  );
  assert.equal(r2.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(r2.headers.Authorization, undefined);
  assert.equal(JSON.parse(r2.body).thinking, undefined);

  assert.throws(() => Core.buildRequest({ endpoint: "", model: "m" }, msgs), /Endereço/);
  assert.throws(() => Core.buildRequest({ endpoint: "https://x", model: "" }, msgs), /modelo/);
});

test("prompt do Explicar não pede resumo nem avaliação e leva os metadados", () => {
  const [sys, usr] = Core.buildExplainMessages({
    passage: "O corpo importa.",
    meta: { title: "Titulo T", creators: "Höök", date: "2018", abstract: "Resumo R" },
    language: "inglês",
  });
  assert.ok(sys.content.includes("inglês"));
  assert.match(sys.content, /Não resuma o texto inteiro/);
  assert.match(sys.content, /não proponha notas/);
  assert.ok(usr.content.includes("Titulo T") && usr.content.includes("Resumo R") && usr.content.includes("O corpo importa."));
});

test("parseResponse trata sucesso, erro HTTP, JSON quebrado e resposta vazia", () => {
  assert.deepEqual(Core.parseResponse(200, JSON.stringify({ choices: [{ message: { content: " oi " } }] })), {
    ok: true,
    content: "oi",
  });
  const e401 = Core.parseResponse(401, JSON.stringify({ error: { message: "Authentication Fails" } }));
  assert.equal(e401.ok, false);
  assert.match(e401.error, /401/);
  assert.match(e401.error, /Authentication Fails/);
  assert.equal(Core.parseResponse(500, "<html>").ok, false);
  assert.equal(Core.parseResponse(200, "não é json").ok, false);
  assert.equal(Core.parseResponse(200, JSON.stringify({ choices: [{ message: { content: "  " } }] })).ok, false);
});

test("needsKey só exige chave fora de endereços locais", () => {
  assert.equal(Core.needsKey({ endpoint: "https://api.deepseek.com", apiKey: "" }), true);
  assert.equal(Core.needsKey({ endpoint: "https://api.deepseek.com", apiKey: "k" }), false);
  assert.equal(Core.needsKey({ endpoint: "http://localhost:11434/v1", apiKey: "" }), false);
  assert.equal(Core.needsKey({ endpoint: "http://127.0.0.1:8080", apiKey: "" }), false);
});

test("explain devolve erro legível quando a rede falha", async () => {
  const r = await Core.explain(
    { cfg: { endpoint: "https://x", model: "m", apiKey: "k" }, passage: "p", meta: null },
    async () => {
      throw new Error("offline");
    }
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /offline/);
});

// ------------------------------------------------------------------ popup e painel lateral

test("popup é só um lançador com três botões, sem caixa de texto e sem painel", () => {
  const env = makeEnv();
  const p = makePopup(env);
  assert.deepEqual(p.buttons().map((b) => b.textContent), ["Explicar com IA", "Síntese", "Reflexão"]);
  assert.equal(p.doc.querySelectorAll("textarea").length, 0);
  assert.equal(p.panel(), null);
  assert.equal(env.httpCalls.length, 0);
  assert.equal(env.saved.length, 0);
});

test("popup não aparece sem texto selecionado", () => {
  const env = makeEnv();
  const p = makePopup(env, { text: "   " });
  assert.equal(p.buttons().length, 0);
});

test("o painel abre ao lado do texto, reserva espaço e a caixa tem mais que o dobro do tamanho antigo", () => {
  const env = makeEnv();
  const p = makePopup(env);
  p.click("Síntese");
  const panel = p.panel();
  assert.ok(panel, "painel deveria existir");
  assert.ok(!p.host.contains(panel), "o painel não pode ficar dentro do popup sobre o texto");
  assert.equal(panel.parentNode, p.doc.body);
  assert.equal(panel.style.position, "fixed");
  assert.equal(panel.style.right, "0px");
  assert.equal(panel.style.width, "380px");
  assert.equal(p.doc.body.style.paddingRight, "380px");
  assert.ok(panel.textContent.includes(p.annotation.text), "o painel cita o trecho");
  const ta = panel.querySelector("textarea");
  assert.ok(parseInt(ta.style.minHeight, 10) >= 112, "mais que o dobro dos 56px antigos");
  assert.ok(parseInt(ta.style.minHeight, 10) >= 150);
  assert.ok(Core.QUESTIONS.sintese.some((q) => panel.textContent.includes(q)));
  assert.equal(panel.querySelectorAll("textarea").length, 1);
});

test("largura do painel vem da preferência e fica entre 280 e 720", () => {
  const widthFor = (value) => {
    const env = makeEnv({ prefs: { "leitura-seria.panelWidth": value } });
    const p = makePopup(env);
    p.click("Síntese");
    return p.panel().style.width;
  };
  assert.equal(widthFor(500), "500px");
  assert.equal(widthFor(5000), "720px");
  assert.equal(widthFor(100), "280px");
  assert.equal(widthFor("abc"), "380px");
  assert.equal(widthFor(undefined), "380px");
});

test("fechar o painel devolve o espaço ao leitor, e abrir de novo reaproveita um painel só", () => {
  const env = makeEnv();
  const p = makePopup(env);
  p.doc.body.style.paddingRight = "7px";
  let resizes = 0;
  p.dom.window.addEventListener("resize", () => resizes++);
  p.click("Síntese");
  assert.equal(p.doc.body.style.paddingRight, "380px");
  assert.ok(resizes >= 1);
  // Clicar noutro botão do popup reaproveita o mesmo painel.
  p.click("Reflexão");
  assert.equal(p.doc.querySelectorAll("#leitura-seria-panel").length, 1);
  p.pclick("×");
  assert.equal(p.panel(), null);
  assert.equal(p.doc.body.style.paddingRight, "7px");
  // Depois de fechado, abre outro normalmente.
  p.click("Síntese");
  assert.equal(p.doc.querySelectorAll("#leitura-seria-panel").length, 1);
  assert.equal(p.doc.body.style.paddingRight, "380px");
});

test("o painel troca de modo pela barra de modos sem sair do lugar", () => {
  const env = makeEnv();
  const p = makePopup(env);
  p.click("Síntese");
  assert.ok(Core.QUESTIONS.sintese.some((q) => p.ptext().includes(q)));
  p.pclick("Reflexão");
  assert.ok(Core.QUESTIONS.tensao.some((q) => p.ptext().includes(q)));
  assert.ok(p.pfind("Salvar (→)"));
  assert.equal(p.doc.querySelectorAll("#leitura-seria-panel").length, 1);
});

test("Síntese cria o destaque com N: no comentário e seleciona a anotação", async () => {
  const env = makeEnv();
  const p = makePopup(env);
  p.click("Síntese");
  const ta = p.panel().querySelector("textarea");
  ta.value = "Atmosfera emerge entre corpo e espaço.";
  p.pclick("Salvar (N:)");
  await tick();
  assert.equal(env.saved.length, 1);
  const j = env.saved[0].json;
  assert.equal(j.comment, "N: Atmosfera emerge entre corpo e espaço.");
  assert.equal(j.type, "highlight");
  assert.equal(j.text, p.annotation.text);
  assert.equal(j.pageLabel, "3");
  assert.equal(j.sortIndex, p.annotation.sortIndex);
  assert.deepEqual(j.position, p.annotation.position);
  assert.equal(env.saved[0].att.id, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(env.selected)), [[j.key]]);
  assert.match(p.ptext(), /Salvo/);
});

test("depois do primeiro salvamento as próximas respostas se somam ao mesmo destaque", async () => {
  const env = makeEnv();
  const p = makePopup(env);
  p.click("Síntese");
  p.panel().querySelector("textarea").value = "Primeira ideia.";
  p.pclick("Salvar (N:)");
  await tick();
  assert.equal(env.saved.length, 1);
  const key = env.saved[0].json.key;
  // O Zotero real passaria a ter o item; aqui simulamos o que saveFromJSON criaria.
  let saves = 0;
  env.annItems[key] = {
    annotationText: p.annotation.text,
    annotationComment: env.saved[0].json.comment,
    saveTx: async () => {
      saves++;
    },
  };
  p.pclick("Reflexão");
  p.panel().querySelector("textarea").value = "Mas isso complica o que eu pensava.";
  p.pclick("Salvar (→)");
  await tick();
  assert.equal(env.saved.length, 1, "não pode criar um segundo destaque");
  assert.equal(saves, 1);
  assert.equal(env.annItems[key].annotationComment, "N: Primeira ideia.\n→ Mas isso complica o que eu pensava.");
});

test("Reflexão usa a seta e Ctrl+Enter salva", async () => {
  const env = makeEnv();
  const p = makePopup(env);
  p.click("Reflexão");
  const ta = p.panel().querySelector("textarea");
  ta.value = "O autor trata como propriedade do espaço, eu como algo que emerge.";
  ta.dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  await tick();
  assert.equal(env.saved.length, 1);
  assert.equal(env.saved[0].json.comment, "→ O autor trata como propriedade do espaço, eu como algo que emerge.");
});

test("teclas digitadas na caixa não chegam aos atalhos do leitor", () => {
  const env = makeEnv();
  const p = makePopup(env);
  p.click("Síntese");
  const ta = p.panel().querySelector("textarea");
  let leaked = 0;
  p.doc.addEventListener("keydown", () => leaked++);
  p.doc.addEventListener("keyup", () => leaked++);
  p.doc.addEventListener("keypress", () => leaked++);
  for (const type of ["keydown", "keyup", "keypress"]) {
    ta.dispatchEvent(new p.dom.window.KeyboardEvent(type, { key: "Delete", bubbles: true }));
  }
  assert.equal(leaked, 0);
});

test("não salva resposta vazia, e Outra pergunta troca a pergunta", async () => {
  const env = makeEnv();
  const p = makePopup(env);
  p.click("Síntese");
  p.pclick("Salvar");
  await tick();
  assert.equal(env.saved.length, 0);
  assert.match(p.ptext(), /Escreva algo/);
  const questionOf = () => p.panel().querySelector("div[style*='font-weight']").textContent;
  const before = questionOf();
  p.pclick("Outra pergunta");
  assert.notEqual(before, questionOf());
});

test("seleção sem posição mostra o erro no painel e não grava nada", async () => {
  const env = makeEnv();
  const p = makePopup(env, { sortIndex: undefined });
  p.click("Síntese");
  p.panel().querySelector("textarea").value = "algo";
  p.pclick("Salvar");
  await tick();
  assert.equal(env.saved.length, 0);
  assert.match(p.ptext(), /posição suficiente/);
});

test("Explicar chama o DeepSeek, mostra a resposta e NÃO salva nada sozinho", async () => {
  const env = makeEnv({ http: okResponse("O termo central é atmosfera, entendida como relação.") });
  const p = makePopup(env);
  p.click("Explicar");
  assert.match(p.ptext(), /Consultando/);
  await tick();
  await tick();
  assert.match(p.ptext(), /O termo central é atmosfera/);
  assert.match(p.ptext(), /Não foi salva/);
  assert.equal(env.saved.length, 0);

  assert.equal(env.httpCalls.length, 1);
  const call = env.httpCalls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://api.deepseek.com/chat/completions");
  assert.equal(call.opts.headers.Authorization, "Bearer sk-test");
  assert.equal(call.opts.successCodes, false);
  const body = JSON.parse(call.opts.body);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  const user = body.messages[1].content;
  assert.ok(user.includes("A atmosfera emerge entre o corpo e o espaço."));
  assert.ok(user.includes("Designing with the Body"));
  assert.ok(user.includes("Höök, Vasconcelos"));
  assert.ok(user.includes("soma design e somaestética"));
});

test("Salvar a explicação grava com o marcador M: e Com as minhas palavras abre a compreensão", async () => {
  const env = makeEnv({ http: okResponse("Explicação do modelo.") });
  const p = makePopup(env);
  p.click("Explicar");
  await tick();
  await tick();
  p.pclick("Com as minhas palavras");
  assert.ok(Core.QUESTIONS.compreensao.some((q) => p.ptext().includes(q)));
  p.panel().querySelector("textarea").value = "O trecho diz que atmosfera é relacional.";
  p.pclick("Salvar");
  await tick();
  assert.equal(env.saved.length, 1);
  assert.equal(env.saved[0].json.comment, "O trecho diz que atmosfera é relacional.");

  const env2 = makeEnv({ http: okResponse("Explicação do modelo.") });
  const p2 = makePopup(env2);
  p2.click("Explicar");
  await tick();
  await tick();
  p2.pclick("Salvar (M:)");
  await tick();
  assert.equal(env2.saved.length, 1);
  assert.equal(env2.saved[0].json.comment, "M: Explicação do modelo.");
});

test("erro do servidor aparece no painel com Tentar de novo", async () => {
  const env = makeEnv({
    http: { status: 401, responseText: JSON.stringify({ error: { message: "Authentication Fails" } }) },
  });
  const p = makePopup(env);
  p.click("Explicar");
  await tick();
  await tick();
  assert.match(p.ptext(), /401/);
  assert.ok(p.pfind("Tentar de novo"));
  assert.equal(env.saved.length, 0);
});

test("falha de rede também vira mensagem, sem exceção solta", async () => {
  const env = makeEnv({ http: new Error("timeout") });
  const p = makePopup(env);
  p.click("Explicar");
  await tick();
  await tick();
  assert.match(p.ptext(), /timeout/);
  assert.equal(env.errors.length, 0);
});

test("Cancelar durante a espera descarta a resposta que chegar depois", async () => {
  let release;
  const env = makeEnv({
    http: () =>
      new Promise((res) => {
        release = () => res(okResponse("Chegou tarde."));
      }),
  });
  const p = makePopup(env);
  p.click("Explicar");
  await tick();
  assert.match(p.ptext(), /Consultando/);
  p.pclick("Cancelar");
  release();
  await tick();
  await tick();
  assert.ok(!p.ptext().includes("Chegou tarde."));
  assert.ok(!p.pfind("Salvar (M:)"));

  // Mudar de modo no meio da espera também descarta a resposta.
  const env2 = makeEnv({
    http: () =>
      new Promise((res) => {
        release = () => res(okResponse("Chegou tarde de novo."));
      }),
  });
  const p2 = makePopup(env2);
  p2.click("Explicar");
  await tick();
  p2.pclick("Síntese");
  release();
  await tick();
  await tick();
  assert.ok(!p2.ptext().includes("Chegou tarde de novo."));
  assert.ok(p2.panel().querySelector("textarea"));
});

test("fechar o painel durante a espera descarta a resposta", async () => {
  let release;
  const env = makeEnv({
    http: () =>
      new Promise((res) => {
        release = () => res(okResponse("Chegou depois de fechar."));
      }),
  });
  const p = makePopup(env);
  p.click("Explicar");
  await tick();
  p.pclick("×");
  release();
  await tick();
  await tick();
  assert.equal(p.panel(), null);
  assert.equal(env.saved.length, 0);
});

test("sem chave pede uma, guarda na preferência e segue", async () => {
  const env = makeEnv({ prefs: { "leitura-seria.apiKey": "" }, http: okResponse("ok") });
  env.promptQueue.push({ ok: true, value: "  sk-nova  " });
  const p = makePopup(env);
  p.click("Explicar");
  await tick();
  await tick();
  assert.equal(env.prefs["leitura-seria.apiKey"], "sk-nova");
  assert.equal(env.httpCalls[0].opts.headers.Authorization, "Bearer sk-nova");
});

test("sem chave e prompt cancelado não faz requisição", async () => {
  const env = makeEnv({ prefs: { "leitura-seria.apiKey": "" }, http: okResponse("ok") });
  env.promptQueue.push({ ok: false, value: "" });
  const p = makePopup(env);
  p.click("Explicar");
  await tick();
  await tick();
  assert.equal(env.httpCalls.length, 0);
  assert.match(p.ptext(), /Sem chave/);
});

test("endereço local dispensa chave e não manda Authorization", async () => {
  const env = makeEnv({
    prefs: { "leitura-seria.apiKey": "", "leitura-seria.endpoint": "http://localhost:11434/v1", "leitura-seria.model": "qwen" },
    http: okResponse("ok"),
  });
  const p = makePopup(env);
  p.click("Explicar");
  await tick();
  await tick();
  assert.equal(env.promptCalls.length, 0);
  assert.equal(env.httpCalls[0].url, "http://localhost:11434/v1/chat/completions");
  assert.equal(env.httpCalls[0].opts.headers.Authorization, undefined);
});

test("com envio de metadados desligado, título e resumo não saem do computador", async () => {
  const env = makeEnv({ prefs: { "leitura-seria.sendMetadata": false }, http: okResponse("ok") });
  const p = makePopup(env);
  p.click("Explicar");
  await tick();
  await tick();
  const user = JSON.parse(env.httpCalls[0].opts.body).messages[1].content;
  assert.ok(!user.includes("Designing with the Body"));
  assert.ok(!user.includes("soma design"));
  assert.ok(user.includes("A atmosfera emerge"));
});

test("prefixos configurados nas preferências são respeitados, inclusive em branco", async () => {
  const env = makeEnv({ prefs: { "leitura-seria.prefix.sintese": "NOTA", "leitura-seria.prefix.tensao": "" } });
  const p = makePopup(env);
  p.click("Síntese");
  p.panel().querySelector("textarea").value = "x";
  p.pclick("Salvar (NOTA)");
  await tick();
  assert.equal(env.saved[0].json.comment, "NOTA x");

  const env2 = makeEnv({ prefs: { "leitura-seria.prefix.tensao": "" } });
  const p2 = makePopup(env2);
  p2.click("Reflexão");
  p2.panel().querySelector("textarea").value = "y";
  p2.pclick("Salvar");
  await tick();
  assert.equal(env2.saved[0].json.comment, "y");
});

// ------------------------------------------------------------------ menu de clique direito

function makeMenu(env, ids) {
  const dom = new JSDOM("<!doctype html><body></body>");
  env.reader._iframeWindow = dom.window;
  const ui = loadLib(env);
  const items = [];
  ui.registerMenu({ reader: env.reader, params: { ids }, append: (i) => items.push(i) });
  const doc = dom.window.document;
  const panel = () => doc.getElementById("leitura-seria-panel");
  const pclick = (label) => {
    const b = [...panel().querySelectorAll("button")].find((x) => x.textContent.startsWith(label));
    assert.ok(b, "botão não encontrado " + label);
    b.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  return { items, doc, panel, pclick, dom };
}

function fakeAnnotation(env, key, text, comment) {
  const item = {
    annotationText: text,
    annotationComment: comment,
    saves: 0,
    saveTx: async () => {
      item.saves++;
    },
  };
  env.annItems[key] = item;
  return item;
}

test("menu de clique direito oferece três itens e desabilita com várias anotações", async () => {
  const env = makeEnv();
  const one = makeMenu(env, ["K1"]);
  assert.deepEqual(
    one.items.map((i) => i.label),
    ["Leitura séria - Explicar este trecho", "Leitura séria - Síntese", "Leitura séria - Reflexão"]
  );
  assert.ok(one.items.every((i) => i.disabled === false));
  const many = makeMenu(env, ["K1", "K2"]);
  assert.ok(many.items.every((i) => i.disabled === true));
  many.items[1].onCommand();
  await tick();
  assert.equal(many.panel(), null);
  assert.equal(env.promptCalls.length, 0);
});

test("o menu abre o mesmo painel lateral, sem caixas de diálogo", async () => {
  const env = makeEnv();
  fakeAnnotation(env, "K1", "Um trecho já destacado.", "");
  const m = makeMenu(env, ["K1"]);
  m.items[1].onCommand();
  await tick();
  await tick();
  assert.ok(m.panel());
  assert.ok(m.panel().textContent.includes("Um trecho já destacado."));
  assert.equal(m.doc.body.style.paddingRight, "380px");
  assert.ok(m.panel().querySelector("textarea"));
  assert.equal(env.promptCalls.length, 0);
});

test("Síntese e Reflexão numa anotação existente acrescentam ao comentário", async () => {
  const env = makeEnv();
  const item = fakeAnnotation(env, "K1", "Um trecho já destacado.", "→ conexão antiga");
  const m = makeMenu(env, ["K1"]);
  m.items[1].onCommand();
  await tick();
  await tick();
  m.panel().querySelector("textarea").value = "minha afirmação";
  m.pclick("Salvar (N:)");
  await tick();
  assert.equal(item.annotationComment, "→ conexão antiga\nN: minha afirmação");
  assert.equal(item.saves, 1);

  m.pclick("Reflexão");
  m.panel().querySelector("textarea").value = "discordo";
  m.pclick("Salvar (→)");
  await tick();
  assert.equal(item.annotationComment, "→ conexão antiga\nN: minha afirmação\n→ discordo");
  assert.equal(item.saves, 2);
  assert.equal(env.saved.length, 0, "não cria destaque novo para anotação existente");

  // Resposta vazia não grava.
  m.pclick("Síntese");
  m.pclick("Salvar");
  await tick();
  assert.equal(item.saves, 2);
});

test("Explicar numa anotação existente só salva se o leitor escolher Salvar", async () => {
  const env = makeEnv({ http: okResponse("Explicação longa do modelo.") });
  const item = fakeAnnotation(env, "K1", "Trecho.", "");
  const m = makeMenu(env, ["K1"]);
  m.items[0].onCommand();
  await tick();
  await tick();
  await tick();
  assert.match(m.panel().textContent, /Explicação longa do modelo\./);
  assert.equal(item.saves, 0);
  assert.equal(item.annotationComment, "");

  m.pclick("Salvar (M:)");
  await tick();
  assert.equal(item.saves, 1);
  assert.equal(item.annotationComment, "M: Explicação longa do modelo.");
});

test("Explicar numa anotação sem texto avisa e não chama o modelo", async () => {
  const env = makeEnv({ http: okResponse("x") });
  fakeAnnotation(env, "K1", "", "");
  const m = makeMenu(env, ["K1"]);
  m.items[0].onCommand();
  await tick();
  await tick();
  assert.equal(env.httpCalls.length, 0);
  assert.match(m.panel().textContent, /não tem texto/);
});

test("anotação que não existe mais mostra um aviso em vez de quebrar", async () => {
  const env = makeEnv();
  const m = makeMenu(env, ["SUMIU"]);
  m.items[1].onCommand();
  await tick();
  await tick();
  assert.equal(m.panel(), null);
  assert.match(env.alerts[0].text, /Não encontrei a anotação/);
});


// ------------------------------------------------------------------ bootstrap e arquivos

test("bootstrap.js carrega os scripts, registra os ganchos e desfaz tudo no shutdown", async () => {
  const registered = [];
  const unregistered = [];
  const panes = [];
  const env = makeEnv();
  const Zotero = Object.assign({}, env.Zotero, {
    initializationPromise: Promise.resolve(),
    Reader: {
      registerEventListener: (type, fn, id) => registered.push({ type, fn, id }),
      unregisterEventListener: (type, fn) => unregistered.push({ type, fn }),
    },
    PreferencePanes: {
      register: async (o) => {
        panes.push(o);
        return "pane-1";
      },
      unregister: (id) => panes.push({ unregistered: id }),
    },
  });
  const rootURI = "file://" + ROOT + "/";
  const ctxTarget = vm.createContext({});
  const Services = {
    scriptloader: {
      loadSubScript(url, target) {
        assert.ok(url.startsWith(rootURI), "URL fora do plugin " + url);
        const file = path.join(ROOT, url.slice(rootURI.length));
        vm.runInContext(fs.readFileSync(file, "utf8"), vm.createContext(target), { filename: file });
      },
    },
    prompt: env.Services.prompt,
  };
  Object.assign(ctxTarget, { Zotero, Services });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), ctxTarget, { filename: "bootstrap.js" });

  await ctxTarget.startup({ id: "leitura-seria@zotero.local", version: "0.1.0", rootURI }, 0);
  assert.deepEqual(registered.map((r) => r.type), ["renderTextSelectionPopup", "createAnnotationContextMenu"]);
  assert.ok(registered.every((r) => r.id === "leitura-seria@zotero.local"));
  assert.equal(panes[0].src, rootURI + "prefs.xhtml");
  assert.equal(panes[0].pluginID, "leitura-seria@zotero.local");

  // O gancho do popup de fato desenha os botões.
  const dom = new JSDOM("<!doctype html><body><div id='host'></div></body>");
  const host = dom.window.document.getElementById("host");
  registered[0].fn({
    reader: env.reader,
    doc: dom.window.document,
    params: { annotation: { text: "texto", sortIndex: "1", position: {}, pageLabel: "1" } },
    append: (n) => host.append(n),
  });
  assert.deepEqual([...host.querySelectorAll("button")].map((b) => b.textContent), ["Explicar com IA", "Síntese", "Reflexão"]);

  // O gancho do menu desenha os itens.
  const items = [];
  registered[1].fn({ reader: env.reader, params: { ids: ["K1"] }, append: (i) => items.push(i) });
  assert.equal(items.length, 3);

  ctxTarget.shutdown();
  assert.deepEqual(unregistered.map((u) => u.type), ["renderTextSelectionPopup", "createAnnotationContextMenu"]);
  assert.ok(panes.some((p) => p.unregistered === "pane-1"));
});

test("manifest.json e prefs.js são coerentes com o código", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 2);
  assert.match(manifest.applications.zotero.id, /^[^@\s]+@[^@\s]+$/);
  assert.equal(manifest.applications.zotero.strict_min_version, "6.999");
  // O Zotero 10 recusa a instalação sem update_url ("applications.zotero.update_url not provided").
  assert.match(manifest.applications.zotero.update_url, /^https:\/\/\S+$/);

  const defaults = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "prefs.js"), "utf8"), {
    pref: (k, v) => {
      defaults[k] = v;
    },
  });
  assert.equal(defaults["extensions.zotero.leitura-seria.prefix.tensao"], "→");
  assert.equal(defaults["extensions.zotero.leitura-seria.language"], "português do Brasil");
  assert.equal(defaults["extensions.zotero.leitura-seria.model"], "deepseek-v4-flash");
  assert.equal(defaults["extensions.zotero.leitura-seria.disableThinking"], true);
  assert.equal(defaults["extensions.zotero.leitura-seria.panelWidth"], 380);

  // Toda preferência lida no ui.js tem padrão em prefs.js.
  const ui = fs.readFileSync(path.join(ROOT, "lib", "ui.js"), "utf8");
  const used = new Set([...ui.matchAll(/pref\("([^"]+)"\)/g)].map((m) => m[1]));
  used.add("prefix.sintese").add("prefix.tensao").add("prefix.modelo").add("apiKey");
  for (const name of used) {
    assert.ok("extensions.zotero.leitura-seria." + name in defaults, "sem padrão para " + name);
  }

  // Todo campo do painel está ligado a uma preferência que existe.
  const xhtml = fs.readFileSync(path.join(ROOT, "prefs.xhtml"), "utf8");
  const bound = [...xhtml.matchAll(/preference="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(bound.length >= 8);
  for (const key of bound) assert.ok(key in defaults, "painel aponta para preferência inexistente " + key);

  // O painel é um XML bem formado.
  const doc = new JSDOM(xhtml, { contentType: "application/xhtml+xml" }).window.document;
  assert.ok(doc.getElementById("leitura-seria-prefs"));
});

// ------------------------------------------------------------------ execução

(async () => {
  let failed = 0;
  for (const { name, fn } of results) {
    try {
      await fn();
      console.log("ok    " + name);
    } catch (e) {
      failed++;
      console.log("FALHA " + name + "\n      " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n      ") : e));
    }
  }
  console.log("\n" + (results.length - failed) + " de " + results.length + " testes passaram.");
  process.exit(failed ? 1 : 0);
})();
