import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { statusContrato } from "./contract_registry.js";
import { Blockfrost, Lucid } from "@lucid-evolution/lucid";
import { execFile } from "child_process";
import { executarAcaoRegistro, lerEstadoRegistro, lerHistoricoRegistro } from "./registry_actions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function carregarEnvLocal() {
  const arquivo = path.join(__dirname, ".env");
  if (!fs.existsSync(arquivo)) return;
  for (const linha of fs.readFileSync(arquivo, "utf8").split("\n")) {
    const encontrada = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (encontrada && process.env[encontrada[1]] === undefined) process.env[encontrada[1]] = encontrada[2].replace(/^['"]|['"]$/g, "");
  }
}

carregarEnvLocal();
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORTA_PAINEL || 3030);
const ARQUIVO_HASH = process.env.ARQUIVO_HASH || "./data/log_hash.json";
const ARQUIVO_ESTADO_AUDITOR = "./data/estado_auditor.json";
const ARQUIVO_SOLICITACOES_TROCA = "./data/solicitacoes_troca.jsonl";
const ARQUIVO_ULTIMO_SCAN = "./data/ultimo_scan.json";
const ARQUIVO_BLOQUEIO = "./data/robo.lock";
const BLOCKFROST_URL = "https://cardano-preview.blockfrost.io/api/v0";
const LABEL_METADADOS = Number(process.env.LABEL_METADADOS || 721);
const cacheAuditorias = new Map();

function lerJsonl(caminho) {
  if (!fs.existsSync(caminho)) return [];
  return fs.readFileSync(caminho, "utf8").split("\n").map((linha) => linha.trim()).filter(Boolean)
    .flatMap((linha) => { try { return [JSON.parse(linha)]; } catch { return []; } });
}
function lerJsonSeguro(caminho, padrao = {}) {
  try { return fs.existsSync(caminho) ? JSON.parse(fs.readFileSync(caminho, "utf8")) : padrao; }
  catch { return padrao; }
}

function enviarJson(resposta, status, corpo) {
  resposta.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  resposta.end(JSON.stringify(corpo));
}
async function corpoJson(requisicao) { let texto = ""; for await (const parte of requisicao) texto += parte; return JSON.parse(texto || "{}"); }
function executarAuditoria() { return new Promise((resolve) => execFile(process.execPath, ["main.js", "auditar"], { cwd: __dirname, timeout: 180000 }, (erro, stdout, stderr) => resolve({ ok: !erro, saida: `${stdout}${stderr}`.trim() }))); }
async function verificarLote(lote) {
  const emCache = cacheAuditorias.get(lote.txHash);
  if (emCache && Date.now() - emCache.em < 30_000) return emCache.valor;
  let valor;
  try {
    const resposta = await fetch(`${BLOCKFROST_URL}/txs/${lote.txHash}/metadata`, { headers: { project_id: process.env.BLOCKFROST_API_KEY } });
    if (resposta.status === 404) valor = { estado: "pendente", mensagem: "Aguardando indexação pela Blockfrost." };
    else if (!resposta.ok) valor = { estado: "pendente", mensagem: `Blockfrost respondeu HTTP ${resposta.status}.` };
    else {
      const metadados = await resposta.json();
      const raiz = metadados.find((item) => String(item.label) === String(LABEL_METADADOS))?.json_metadata?.merkle_root;
      valor = raiz === lote.merkle_root
        ? { estado: "integro", mensagem: "Merkle root confirmada on-chain." }
        : raiz ? { estado: "alerta", mensagem: "Merkle root diverge do registro local." } : { estado: "pendente", mensagem: "Metadado ainda não indexado." };
    }
  } catch (erro) {
    valor = { estado: "pendente", mensagem: `Consulta temporariamente indisponível: ${erro.message}` };
  }
  cacheAuditorias.set(lote.txHash, { em: Date.now(), valor });
  return valor;
}

const servidor = http.createServer(async (requisicao, resposta) => {
  const url = new URL(requisicao.url, `http://${HOST}:${PORT}`);
  if (requisicao.method === "POST" && url.pathname === "/api/auditar") return enviarJson(resposta, 200, await executarAuditoria());
  if (requisicao.method === "POST" && url.pathname === "/api/registro/acao") {
    try { return enviarJson(resposta, 200, await executarAcaoRegistro(process.env, await corpoJson(requisicao))); }
    catch (erro) { return enviarJson(resposta, 400, { erro: erro.message }); }
  }
  if (requisicao.method === "POST" && url.pathname === "/api/login") {
    try {
      const { mnemonic } = await corpoJson(requisicao);
      const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, process.env.BLOCKFROST_API_KEY), "Preview");
      lucid.selectWallet.fromSeed(mnemonic);
      const endereco = await lucid.wallet().address();
      const utxos = await lucid.wallet().getUtxos();
      const saldoLovelace = utxos.reduce((total, utxo) => total + (utxo.assets.lovelace || 0n), 0n);
      const registro = lerEstadoRegistro(process.env);
      const papel = endereco === registro.chief
        ? "Chefe"
        : registro.devices.includes(endereco)
          ? "Dispositivo autorizado"
          : "Sem permissão no contrato";
      return enviarJson(resposta, 200, { endereco, papel, saldoAda: Number(saldoLovelace) / 1_000_000 });
    } catch { return enviarJson(resposta, 400, { erro: "Mnemonic inválido ou não pôde ser lido." }); }
  }
  if (requisicao.method === "GET" && url.pathname === "/api/status") {
    const lotes = lerJsonl(path.resolve(__dirname, ARQUIVO_HASH)).filter((lote) => lote.txHash && lote.merkle_root);
    const ultimoScan = lerJsonSeguro(path.resolve(__dirname, ARQUIVO_ULTIMO_SCAN), { resultados: [] });
    const resultadoPorJanela = new Map((ultimoScan.resultados || []).map((resultado) => [`${resultado.inicio_grupo}:${resultado.fim_grupo}`, resultado]));
    const estado = fs.existsSync(path.resolve(__dirname, ARQUIVO_ESTADO_AUDITOR)) ? JSON.parse(fs.readFileSync(path.resolve(__dirname, ARQUIVO_ESTADO_AUDITOR), "utf8")) : {};
    const solicitacoes = lerJsonl(path.resolve(__dirname, ARQUIVO_SOLICITACOES_TROCA)).reverse().map((solicitacao) => ({
      txHash: solicitacao.txHash,
      novoEndereco: solicitacao.novoEndereco,
      status: solicitacao.status === "bloqueada_integridade" ? "Negada por integridade" : "Carteira alterada",
      data: solicitacao.bloqueadaEm || solicitacao.aceitoEm,
      lotesVerificados: solicitacao.lotesVerificados,
    }));
    const ultimos = await Promise.all(lotes.slice(-200).reverse().map(async (lote, indice) => ({
      txHash: lote.txHash,
      quantidade_logs: lote.quantidade_logs,
      ancorado_em: lote.ancorado_em,
      merkle_root: lote.merkle_root,
      auditoria: resultadoPorJanela.get(`${lote.inicio_grupo}:${lote.fim_grupo}`)
        || (indice < 8 ? await verificarLote(lote) : { estado: "pendente", mensagem: "Execute o scan manual para auditar esta ancoragem." }),
    })));
    return enviarJson(resposta, 200, {
      rede: process.env.REDE_CARDANO || "Preview",
      emissor: process.env.ENDERECO_EMISSOR || "Não configurado",
      auditor: estado.enderecoAuditor || process.env.ENDERECO_AUDITOR || process.env.ENDERECO_EMISSOR || "Não configurado",
      cofre: process.env.ENDERECO_COFRE_HKOIN || "addr_test1qqfts3ppyp58exvdjnqkcs5tjj05nrj629t96rzrfwz3esg2hawrds5qmu6r2va4d0jrzaql6d3fdmuza393v94ktjtq8vs93a",
      contrato: statusContrato(),
      registro: lerEstadoRegistro(process.env),
      historicoContrato: lerHistoricoRegistro(),
      totalLotes: lotes.length,
      roboAtivo: fs.existsSync(path.resolve(__dirname, ARQUIVO_BLOQUEIO)),
      solicitacoes,
      ultimos,
    });
  }
  if (requisicao.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    resposta.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return resposta.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
  }
  resposta.writeHead(404); resposta.end("Não encontrado");
});

servidor.listen(PORT, HOST, () => console.log(`Painel disponível em http://${HOST}:${PORT}`));
