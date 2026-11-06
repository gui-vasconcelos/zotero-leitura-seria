/* Leitura Séria — bootstrap do Zotero 7 e posteriores. */

var pluginID = null;
var paneID = null;
var ui = null;
var popupHandler = null;
var menuHandler = null;

function log(msg) {
  Zotero.debug("[Leitura Séria] " + msg);
}

function install() {}

async function startup({ id, version, rootURI }) {
  pluginID = id;
  if (Zotero.initializationPromise) await Zotero.initializationPromise;

  // Os scripts de lib/ rodam num escopo próprio, e recebem só o que precisam.
  const ctx = { Zotero, Services };
  ctx._globalThis = ctx;
  Services.scriptloader.loadSubScript(rootURI + "lib/core.js", ctx);
  Services.scriptloader.loadSubScript(rootURI + "lib/ui.js", ctx);
  ctx.Core = ctx.LeituraCore;

  ui = ctx.LeituraUI.create({ Zotero, Services, Core: ctx.LeituraCore });

  popupHandler = (event) => {
    try {
      ui.renderPopup(event);
    } catch (e) {
      Zotero.logError(e);
    }
  };
  menuHandler = (event) => {
    try {
      ui.registerMenu(event);
    } catch (e) {
      Zotero.logError(e);
    }
  };

  Zotero.Reader.registerEventListener("renderTextSelectionPopup", popupHandler, id);
  Zotero.Reader.registerEventListener("createAnnotationContextMenu", menuHandler, id);

  try {
    paneID = await Zotero.PreferencePanes.register({
      pluginID: id,
      src: rootURI + "prefs.xhtml",
      label: "Leitura Séria",
    });
  } catch (e) {
    // Sem o painel o plugin continua funcionando, a chave é pedida no primeiro uso.
    log("Não consegui registrar o painel de preferências. " + e);
  }

  log("iniciado, versão " + version);
}

function onMainWindowLoad({ window }) {}

function onMainWindowUnload({ window }) {}

function shutdown() {
  try {
    if (popupHandler) Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", popupHandler);
    if (menuHandler) Zotero.Reader.unregisterEventListener("createAnnotationContextMenu", menuHandler);
  } catch (e) {
    Zotero.logError(e);
  }
  try {
    if (paneID && Zotero.PreferencePanes.unregister) Zotero.PreferencePanes.unregister(paneID);
  } catch (e) {}
  popupHandler = null;
  menuHandler = null;
  paneID = null;
  ui = null;
}

function uninstall() {}
