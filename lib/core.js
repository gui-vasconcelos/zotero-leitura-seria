/*
 * Leitura Séria — núcleo (lógica pura, sem DOM e sem Zotero).
 *
 * Carregado de duas formas
 *  - no Zotero, por Services.scriptloader.loadSubScript(url, ctx), onde ctx._globalThis === ctx
 *  - no Node (testes), por require()
 */
(function () {
  "use strict";

  // Tipos de pergunta. O prefixo é o que entra no comentário do Zotero, e pode ser
  // trocado nas preferências. A compreensão não tem prefixo, vira comentário comum.
  const KINDS = {
    sintese: { label: "Síntese", prefixKey: "sintese", fallbackPrefix: "N:" },
    tensao: { label: "Tensão", prefixKey: "tensao", fallbackPrefix: "→" },
    compreensao: { label: "Com as minhas palavras", prefixKey: null, fallbackPrefix: "" },
  };

  const QUESTIONS = {
    sintese: [
      "Se este trecho virasse uma nota, qual seria a afirmação de uma frase que serviria de título?",
      "Diga em uma frase completa, com as suas palavras e sem citar o autor, a ideia que vale guardar daqui.",
      "Que conceito este trecho está carregando, e o que você afirmaria sobre ele?",
      "Escreva o que vale guardar como uma afirmação, de modo que o título já diga a ideia.",
    ],
    tensao: [
      "O que este trecho confirma, muda ou complica no que você já pensa?",
      "Onde você concorda e onde discorda do que está sendo dito aqui?",
      "Que posição sua este trecho esbarra, e em que ponto ela não encaixa?",
      "Que exemplo da sua prática ou da sua pesquisa este trecho ilumina ou contradiz?",
    ],
    compreensao: [
      "Diga com as suas palavras o que este trecho afirma.",
      "Qual termo carrega o argumento aqui, e o que ele quer dizer neste texto?",
      "Se tivesse de explicar este trecho a um colega em duas frases, o que diria?",
    ],
  };

  const MAX_PASSAGE_CHARS = 4000;
  const MAX_ABSTRACT_CHARS = 1500;

  /**
   * Sorteia uma pergunta do banco, sem repetir a que acabou de aparecer.
   * @returns {{index:number, text:string}}
   */
  function nextQuestion(kind, lastIndex, rng) {
    const list = QUESTIONS[kind];
    if (!list || !list.length) throw new Error("Tipo de pergunta desconhecido " + kind);
    const rand = typeof rng === "function" ? rng : Math.random;
    if (list.length === 1) return { index: 0, text: list[0] };
    let index = Math.floor(rand() * list.length);
    if (index >= list.length) index = list.length - 1;
    if (index === lastIndex) index = (index + 1) % list.length;
    return { index, text: list[index] };
  }

  /**
   * Junta o que o leitor escreveu ao comentário que já existe, uma entrada por linha.
   * O prefixo só entra se o texto ainda não começar com ele.
   */
  function composeComment(existing, prefix, answer) {
    const body = String(answer == null ? "" : answer)
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const base = String(existing == null ? "" : existing).trim();
    if (!body) return base;
    const p = String(prefix == null ? "" : prefix).trim();
    const line = p && !body.startsWith(p) ? p + " " + body : body;
    return base ? base + "\n" + line : line;
  }

  function cleanPassage(text, max) {
    const limit = max || MAX_PASSAGE_CHARS;
    const flat = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    if (flat.length <= limit) return flat;
    return flat.slice(0, limit).trim() + " [trecho cortado]";
  }

  function metaBlock(meta) {
    if (!meta) return "";
    const lines = [];
    if (meta.title) lines.push("Título do texto " + meta.title);
    if (meta.creators) lines.push("Autoria " + meta.creators);
    if (meta.date) lines.push("Data " + meta.date);
    if (meta.abstract) {
      const abs = String(meta.abstract).replace(/\s+/g, " ").trim();
      if (abs) {
        lines.push(
          "Resumo do texto " +
            (abs.length > MAX_ABSTRACT_CHARS ? abs.slice(0, MAX_ABSTRACT_CHARS).trim() + " [cortado]" : abs)
        );
      }
    }
    return lines.join("\n");
  }

  /**
   * Monta as mensagens do botão Explicar. O modelo só explica. Não resume o texto
   * inteiro, não avalia e não propõe nota, porque o pensamento é do leitor.
   */
  function buildExplainMessages({ passage, meta, language }) {
    const lang = language && String(language).trim() ? String(language).trim() : "português do Brasil";
    const system = [
      "Você ajuda um pesquisador a entender um trecho de um texto científico que ele está lendo.",
      "Responda em " + lang + ", em prosa corrida e curta, com no máximo cerca de 150 palavras e sem listas.",
      "Explique o que o trecho afirma, aponte o termo ou a ideia que carrega o argumento e diga o que isso significa neste texto.",
      "Não resuma o texto inteiro, não invente o que o trecho não diz, não avalie se o autor tem razão e não proponha notas.",
      "Se o trecho depende de contexto que você não recebeu, diga qual contexto falta em vez de supor.",
    ].join(" ");

    const parts = [];
    const mb = metaBlock(meta);
    if (mb) parts.push("Informações sobre o texto\n" + mb);
    parts.push("Trecho selecionado\n\"\"\"\n" + cleanPassage(passage) + "\n\"\"\"");
    return [
      { role: "system", content: system },
      { role: "user", content: parts.join("\n\n") },
    ];
  }

  function isLocalEndpoint(endpoint) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(String(endpoint || ""));
  }

  function needsKey(cfg) {
    return !String((cfg && cfg.apiKey) || "").trim() && !isLocalEndpoint(cfg && cfg.endpoint);
  }

  /**
   * Requisição no formato compatível com a API da OpenAI, que o DeepSeek também fala.
   * Nos modelos V4 do DeepSeek o pensamento vem ligado por padrão, então o plugin
   * o desliga de forma explícita (preferência disableThinking) para a resposta ser rápida.
   */
  function buildRequest(cfg, messages) {
    let url = String(cfg.endpoint || "").trim().replace(/\/+$/, "");
    if (!url) throw new Error("Endereço da API não configurado.");
    if (!/\/chat\/completions$/.test(url)) url += "/chat/completions";
    if (!String(cfg.model || "").trim()) throw new Error("Nome do modelo não configurado.");

    const headers = { "Content-Type": "application/json" };
    const key = String(cfg.apiKey || "").trim();
    if (key) headers.Authorization = "Bearer " + key;

    const body = {
      model: String(cfg.model).trim(),
      messages,
      temperature: 0.3,
      max_tokens: 700,
      stream: false,
    };
    if (cfg.disableThinking) body.thinking = { type: "disabled" };

    return { url, headers, body: JSON.stringify(body) };
  }

  function parseResponse(status, text) {
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
    if (status < 200 || status >= 300) {
      const detail =
        (data && data.error && (data.error.message || data.error)) ||
        String(text || "").slice(0, 200) ||
        "sem detalhes";
      return { ok: false, error: "O servidor do modelo respondeu com erro " + status + ". " + detail };
    }
    const content =
      data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content || !String(content).trim()) {
      return { ok: false, error: "O modelo não devolveu texto." };
    }
    return { ok: true, content: String(content).trim() };
  }

  /**
   * @param {{cfg:object, passage:string, meta:object|null, language:string}} args
   * @param {(url:string, opts:{headers:object, body:string, timeout:number}) => Promise<{status:number, text:string}>} http
   */
  async function explain(args, http) {
    let req;
    try {
      req = buildRequest(args.cfg, buildExplainMessages(args));
    } catch (e) {
      return { ok: false, error: e.message };
    }
    let res;
    try {
      res = await http(req.url, { headers: req.headers, body: req.body, timeout: 60000 });
    } catch (e) {
      return { ok: false, error: "Não consegui falar com o servidor do modelo. " + ((e && e.message) || e) };
    }
    return parseResponse(res.status, res.text);
  }

  const Core = {
    KINDS,
    QUESTIONS,
    nextQuestion,
    composeComment,
    cleanPassage,
    buildExplainMessages,
    buildRequest,
    parseResponse,
    needsKey,
    isLocalEndpoint,
    explain,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Core;
  } else if (typeof _globalThis !== "undefined") {
    _globalThis.LeituraCore = Core;
  }
})();
