/* Coleta logs JSONL, mascara campos pessoais e cria lotes Merkle pendentes. */
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ARQUIVO_LOGS = process.env.ARQUIVO_LOGS || "./data/logs.jsonl";
const ARQUIVO_HASH = process.env.ARQUIVO_HASH || "./data/log_hash.json";
const INTERVALO_LOTE_SEG = Number(process.env.INTERVALO_LOTE_SEG || 60);
const ATRASO_FECHAMENTO_JANELA_SEG = Number(process.env.ATRASO_FECHAMENTO_JANELA_SEG || 5);

fs.mkdirSync(path.dirname(ARQUIVO_HASH), { recursive: true });

export function lerHistorico(caminho = ARQUIVO_HASH) {
  if (!fs.existsSync(caminho)) return [];

  return fs.readFileSync(caminho, "utf8")
    .split("\n")
    .map((linha) => linha.trim())
    .filter(Boolean)
    .flatMap((linha, indice) => {
      try {
        return [JSON.parse(linha)];
      } catch (erro) {
        console.warn(`Linha inválida ignorada no histórico (${indice + 1}): ${erro.message}`);
        return [];
      }
    });
}

function lerTodosOsLogs() {
  if (!fs.existsSync(ARQUIVO_LOGS)) return [];

  return fs.readFileSync(ARQUIVO_LOGS, "utf8")
    .split("\n")
    .map((linha) => linha.trim())
    .filter(Boolean)
    .flatMap((linha, indice) => {
      try {
        return [JSON.parse(linha)];
      } catch (erro) {
        console.warn(`Log JSONL inválido ignorado (${indice + 1}): ${erro.message}`);
        return [];
      }
    });
}

function idsDeEventosJaAncorados() {
  return new Set(
    lerHistorico()
      .flatMap((lote) => Array.isArray(lote.folhas) ? lote.folhas : [])
      .map((folha) => folha.id_evento)
      .filter(Boolean),
  );
}

function mascararIp(ip) {
  const partes = String(ip || "").split(".");
  if (partes.length !== 4) return "***.***.***.***";
  return `${partes[0]}.${partes[1]}.***.***`;
}

function mascararUsuario(usuario) {
  return String(usuario || "")
    .split(".")
    .map((parte) => parte ? `${parte[0]}${"*".repeat(parte.length - 1)}` : parte)
    .join(".");
}

function aplicarMascaramentoLGPD(log) {
  return { ...log, usuario: mascararUsuario(log.usuario), ip_origem: mascararIp(log.ip_origem) };
}

function sha256Hex(texto) {
  return crypto.createHash("sha256").update(texto, "utf8").digest("hex");
}

function serializarCanonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(serializarCanonico).join(",")}]`;
  if (valor && typeof valor === "object") {
    return `{${Object.keys(valor).sort().map((chave) => `${JSON.stringify(chave)}:${serializarCanonico(valor[chave])}`).join(",")}}`;
  }
  return JSON.stringify(valor);
}

function calcularHashFolha(logMascarado) {
  return sha256Hex(serializarCanonico(logMascarado));
}

function construirArvoreMerkle(hashesFolha) {
  if (!hashesFolha.length) return { raiz: null, niveis: [] };
  const niveis = [[...hashesFolha]];
  while (niveis.at(-1).length > 1) {
    const atual = niveis.at(-1);
    const proximo = [];
    for (let indice = 0; indice < atual.length; indice += 2) {
      proximo.push(sha256Hex(atual[indice] + (atual[indice + 1] || atual[indice])));
    }
    niveis.push(proximo);
  }
  return { raiz: niveis.at(-1)[0], niveis };
}

/**
 * Cria um lote apenas com eventos ainda não registrados como ancorados.
 * Não há filtro por tempo: logs surgidos durante uma espera continuam pendentes
 * e serão incluídos no próximo ciclo, sem risco de serem pulados.
 */
function ordenarLogs(logs) {
  return logs.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0) || String(a.id_evento).localeCompare(String(b.id_evento)));
}

/** Fecha uma janela temporal completa; o main.js é o único controlador do ciclo. */
function processarLote() {
  const idsAncorados = idsDeEventosJaAncorados();
  const pendentes = ordenarLogs(lerTodosOsLogs().filter((log) => log.id_evento && !idsAncorados.has(log.id_evento)));

  if (!pendentes.length) {
    console.log("Nenhum log pendente para ancorar.");
    return null;
  }

  const inicioJanela = Math.floor(Number(pendentes[0].timestamp) / INTERVALO_LOTE_SEG) * INTERVALO_LOTE_SEG;
  const fimJanela = inicioJanela + INTERVALO_LOTE_SEG;
  const limiteFechamento = Date.now() / 1000 - ATRASO_FECHAMENTO_JANELA_SEG;
  if (fimJanela > limiteFechamento) {
    console.log(`Janela ${new Date(inicioJanela * 1000).toISOString()} ainda aberta; aguardando fechamento.`);
    return null;
  }
  const pendentesDaJanela = pendentes.filter((log) => Number(log.timestamp) >= inicioJanela && Number(log.timestamp) < fimJanela);

  const folhas = pendentesDaJanela.map((log) => {
    const mascarado = aplicarMascaramentoLGPD(log);
    return { id_evento: log.id_evento, hash: calcularHashFolha(mascarado) };
  });
  const { raiz } = construirArvoreMerkle(folhas.map((folha) => folha.hash));
  const agora = Date.now() / 1000;
  const lote = {
    merkle_root: raiz,
    quantidade_logs: folhas.length,
    folhas,
    gerado_em: agora,
    inicio_grupo: inicioJanela,
    fim_grupo: fimJanela,
    janela_temporal: true,
  };

  console.log(`Lote pendente: ${folhas.length} logs | intervalo ${new Date(inicioJanela * 1000).toISOString()} a ${new Date(fimJanela * 1000).toISOString()} | Merkle Root: ${raiz.slice(0, 12)}...`);
  return lote;
}

/** Recria a prova de um lote usando os logs brutos ainda presentes localmente. */
function recalcularLote(lote) {
  const todos = lerTodosOsLogs();
  const ids = (lote.folhas || []).map((folha) => folha.id_evento).filter(Boolean);
  const porId = new Map(todos.map((log) => [log.id_evento, log]));
  const ausentes = ids.filter((id) => !porId.has(id));
  if (ausentes.length) return { valido: false, ausentes, motivo: `${ausentes.length} log(s) do lote não estão mais no arquivo local.` };
  const logsDoLote = lote.janela_temporal
    ? todos.filter((log) => Number(log.timestamp) >= Number(lote.inicio_grupo) && Number(log.timestamp) < Number(lote.fim_grupo))
    : ids.map((id) => porId.get(id));
  const folhas = ordenarLogs(logsDoLote).map((log) => {
    const id = log.id_evento;
    return { id_evento: id, hash: calcularHashFolha(aplicarMascaramentoLGPD(log)) };
  });
  const { raiz } = construirArvoreMerkle(folhas.map((folha) => folha.hash));
  return { valido: raiz === lote.merkle_root, merkle_root: raiz, quantidade_logs: folhas.length, motivo: "Merkle root recalculada a partir dos logs brutos." };
}

/** Lista as janelas temporais fechadas diretamente a partir dos logs brutos. */
function listarJanelasLocais() {
  const limite = Date.now() / 1000 - ATRASO_FECHAMENTO_JANELA_SEG;
  const janelas = new Map();
  for (const log of lerTodosOsLogs()) {
    if (!log.id_evento || !Number.isFinite(Number(log.timestamp))) continue;
    const inicio = Math.floor(Number(log.timestamp) / INTERVALO_LOTE_SEG) * INTERVALO_LOTE_SEG;
    const fim = inicio + INTERVALO_LOTE_SEG;
    if (fim > limite) continue;
    const chave = `${inicio}:${fim}`;
    if (!janelas.has(chave)) janelas.set(chave, { inicio_grupo: inicio, fim_grupo: fim, logs: [] });
    janelas.get(chave).logs.push(log);
  }
  return [...janelas.values()].map((janela) => {
    const folhas = ordenarLogs(janela.logs).map((log) => ({ id_evento: log.id_evento, hash: calcularHashFolha(aplicarMascaramentoLGPD(log)) }));
    return { ...janela, quantidade_logs: folhas.length, folhas, merkle_root: construirArvoreMerkle(folhas.map((folha) => folha.hash)).raiz };
  });
}

function registrarLoteAncorado(lote, txHash) {
  const ancorado_em = new Date().toISOString();
  const registro = { ...lote, txHash, ancorado_em };
  fs.appendFileSync(ARQUIVO_HASH, `${JSON.stringify(registro)}\n`, "utf8");
  console.log(`Lote registrado em ${ARQUIVO_HASH}`);
  return registro;
}

const executadoDiretamente = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (executadoDiretamente) {
  processarLote();
}

export { processarLote, registrarLoteAncorado, recalcularLote, listarJanelasLocais, mascararIp, mascararUsuario, construirArvoreMerkle, calcularHashFolha };
