/* Robô autônomo: ancora lotes Merkle e audita os metadados na Blockfrost. */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import * as Coletor from "./coletor.js";
import { criarAncoragemPorContrato } from "./contract_anchor.js";

const REDE_CARDANO = process.env.REDE_CARDANO || "Preview";
const BLOCKFROST_API_KEY = process.env.BLOCKFROST_API_KEY;
const SEED_PHRASE = process.env.SEED_PHRASE;
const SEED_DISPOSITIVO = process.env.SEED_DISPOSITIVO;
const USAR_CONTRATO_ACESSO = /^true$/i.test(process.env.USAR_CONTRATO_ACESSO || "false");
const ENDERECO_EMISSOR = process.env.ENDERECO_EMISSOR;
const ENDERECO_AUDITOR = process.env.ENDERECO_AUDITOR;
const ENDERECO_CONSULTA_ANCORAGENS = process.env.ENDERECO_CONSULTA_ANCORAGENS || process.env.ENDERECO_DISPOSITIVO_INICIAL || ENDERECO_EMISSOR;
const ENDERECO_COFRE_HKOIN = process.env.ENDERECO_COFRE_HKOIN || "addr_test1qqfts3ppyp58exvdjnqkcs5tjj05nrj629t96rzrfwz3esg2hawrds5qmu6r2va4d0jrzaql6d3fdmuza393v94ktjtq8vs93a";
const ARQUIVO_HASH = process.env.ARQUIVO_HASH || "./data/log_hash.json";
const LABEL_METADADOS = Number(process.env.LABEL_METADADOS || 721);
const LABEL_SOLICITACAO_TROCA = Number(process.env.LABEL_SOLICITACAO_TROCA || 722);
const UNIDADE_HKOIN = "34fa22414411e9a36d4cca3d1fbaae161f90202ba9db839d5e61acb6484b6f696e";
const INTERVALO_ROBO_MS = Number(process.env.INTERVALO_ROBO_MS || 60_000);
const INTERVALO_AUDITORIA = Number(process.env.INTERVALO_AUDITORIA || 5);
const DELAY_ANTES_AUDITORIA_MS = Number(process.env.DELAY_ANTES_AUDITORIA_MS || 30_000);
const MAX_TENTATIVAS_ANCORAGEM = Number(process.env.MAX_TENTATIVAS_ANCORAGEM || 5);
const DELAY_RETRY_ANCORAGEM_MS = Number(process.env.DELAY_RETRY_ANCORAGEM_MS || 30_000);
const MAX_TENTATIVAS_VERIFICACAO = Number(process.env.MAX_TENTATIVAS_VERIFICACAO || 3);
const DELAY_RETRY_VERIFICACAO_MS = Number(process.env.DELAY_RETRY_VERIFICACAO_MS || 20_000);
const AUDITAR_HISTORICO_COMPLETO = !/^false$/i.test(process.env.AUDITAR_HISTORICO_COMPLETO || "true");
const ARQUIVO_BLOQUEIO = "./data/robo.lock";
const ARQUIVO_ESTADO_AUDITOR = "./data/estado_auditor.json";
const ARQUIVO_SOLICITACOES_TROCA = "./data/solicitacoes_troca.jsonl";
const ARQUIVO_ULTIMO_SCAN = "./data/ultimo_scan.json";
const VALOR_MINIMO_LOVELACE = 1_000_000n;
const VALOR_MINIMO_TRANSFERENCIA_HKOIN = 1_500_000n;

const BLOCKFROST_URLS = {
  Preview: "https://cardano-preview.blockfrost.io/api/v0",
  Preprod: "https://cardano-preprod.blockfrost.io/api/v0",
};
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lerJson(caminho, padrao) {
  if (!fs.existsSync(caminho)) return padrao;
  try { return JSON.parse(fs.readFileSync(caminho, "utf8")); }
  catch (erro) { throw new Error(`Arquivo local inválido (${caminho}): ${erro.message}`); }
}

function lerSolicitacoesProcessadas() {
  if (!fs.existsSync(ARQUIVO_SOLICITACOES_TROCA)) return new Set();
  return new Set(fs.readFileSync(ARQUIVO_SOLICITACOES_TROCA, "utf8")
    .split("\n").map((linha) => linha.trim()).filter(Boolean)
    .flatMap((linha) => { try { return [JSON.parse(linha).txHash]; } catch { return []; } })
    .filter(Boolean));
}

function enderecoAuditorAtual() {
  return lerJson(ARQUIVO_ESTADO_AUDITOR, {}).enderecoAuditor || ENDERECO_AUDITOR || ENDERECO_EMISSOR;
}

function registrarTrocaAuditor(troca) {
  fs.mkdirSync(path.dirname(ARQUIVO_ESTADO_AUDITOR), { recursive: true });
  const estado = { enderecoAuditor: troca.novoEndereco, atualizadoEm: new Date().toISOString(), txHash: troca.txHash };
  const temporario = `${ARQUIVO_ESTADO_AUDITOR}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify(estado, null, 2), "utf8");
  fs.renameSync(temporario, ARQUIVO_ESTADO_AUDITOR);
  fs.appendFileSync(ARQUIVO_SOLICITACOES_TROCA, `${JSON.stringify({ ...troca, aceitoEm: estado.atualizadoEm })}\n`, "utf8");
}

function registrarSolicitacaoBloqueada(troca) {
  fs.mkdirSync(path.dirname(ARQUIVO_SOLICITACOES_TROCA), { recursive: true });
  fs.appendFileSync(ARQUIVO_SOLICITACOES_TROCA, `${JSON.stringify({ ...troca, bloqueadaEm: new Date().toISOString() })}\n`, "utf8");
}

function enderecoCardanoValido(endereco) {
  const prefixoEsperado = REDE_CARDANO === "Mainnet" ? "addr1" : "addr_test1";
  return typeof endereco === "string" && endereco.startsWith(prefixoEsperado) && /^addr(_test)?1[ac-hj-np-z02-9]{20,}$/i.test(endereco);
}

function validarConfiguracao(precisaCarteira) {
  if (!BLOCKFROST_URLS[REDE_CARDANO]) throw new Error(`Rede não suportada: ${REDE_CARDANO}`);
  if (!BLOCKFROST_API_KEY) throw new Error("BLOCKFROST_API_KEY ausente no .env");
  if (precisaCarteira && (!SEED_PHRASE || !ENDERECO_EMISSOR)) {
    throw new Error("SEED_PHRASE ou ENDERECO_EMISSOR ausente no .env");
  }
  if (precisaCarteira && USAR_CONTRATO_ACESSO && !SEED_DISPOSITIVO) throw new Error("SEED_DISPOSITIVO ausente para ancoragem pelo contrato.");
}

async function criarLucid() {
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URLS[REDE_CARDANO], BLOCKFROST_API_KEY), REDE_CARDANO);
  lucid.selectWallet.fromSeed(SEED_PHRASE);
  return lucid;
}

function adquirirBloqueio() {
  fs.mkdirSync(path.dirname(ARQUIVO_BLOQUEIO), { recursive: true });
  if (fs.existsSync(ARQUIVO_BLOQUEIO)) {
    const pid = Number(fs.readFileSync(ARQUIVO_BLOQUEIO, "utf8").trim());
    try { process.kill(pid, 0); throw new Error(`Já existe um robô em execução (PID ${pid}).`); }
    catch (erro) { if (erro.code !== "ESRCH") throw erro; fs.unlinkSync(ARQUIVO_BLOQUEIO); }
  }
  fs.writeFileSync(ARQUIVO_BLOQUEIO, String(process.pid), { flag: "wx" });
  const liberar = () => { if (fs.existsSync(ARQUIVO_BLOQUEIO)) fs.unlinkSync(ARQUIVO_BLOQUEIO); };
  process.once("exit", liberar);
  process.once("SIGINT", () => { liberar(); process.exit(0); });
  process.once("SIGTERM", () => { liberar(); process.exit(0); });
}

async function ancorarHash(lote) {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_ANCORAGEM; tentativa += 1) {
    try {
      if (USAR_CONTRATO_ACESSO) {
        const resultado = await criarAncoragemPorContrato(lote, {
          rede: REDE_CARDANO, blockfrostApiKey: BLOCKFROST_API_KEY, seedDispositivo: SEED_DISPOSITIVO,
          enderecoReceptor: enderecoAuditorAtual(), labelMetadados: LABEL_METADADOS, valorLovelace: VALOR_MINIMO_LOVELACE,
        });
        return await (await resultado.tx.sign.withWallet().complete()).submit();
      }
      const lucid = await criarLucid();
      const tx = await lucid.newTx()
        .pay.ToAddress(enderecoAuditorAtual(), { lovelace: VALOR_MINIMO_LOVELACE })
        .attachMetadata(LABEL_METADADOS, {
          merkle_root: lote.merkle_root,
          qtd: lote.quantidade_logs,
          inicio_grupo: Math.floor(lote.inicio_grupo),
          fim_grupo: Math.floor(lote.fim_grupo),
        }).complete();
      return await (await tx.sign.withWallet().complete()).submit();
    } catch (erro) {
      const utxoPendente = /All inputs are spent|ConwayMempoolFailure/i.test(String(erro.message || erro));
      if (!utxoPendente) throw erro;
      if (tentativa === MAX_TENTATIVAS_ANCORAGEM) {
        console.warn("Ancoragem pendente: o UTxO do contrato ainda está sendo atualizado. O robô tentará novamente no próximo ciclo.");
        return null;
      }
      console.warn(`UTxO ainda pendente; tentativa ${tentativa + 1}/${MAX_TENTATIVAS_ANCORAGEM} em ${DELAY_RETRY_ANCORAGEM_MS / 1000}s.`);
      await esperar(DELAY_RETRY_ANCORAGEM_MS);
    }
  }
}

async function buscarSolicitacoesDeTroca() {
  const resposta = await fetch(`${BLOCKFROST_URLS[REDE_CARDANO]}/addresses/${ENDERECO_EMISSOR}/transactions?order=desc&count=100`, { headers: { project_id: BLOCKFROST_API_KEY } });
  if (!resposta.ok) throw new Error(`Não foi possível listar solicitações: HTTP ${resposta.status}.`);
  return resposta.json();
}

async function listarTransacoesDoEmissor() {
  const transacoes = [];
  for (let pagina = 1; pagina <= 100; pagina += 1) {
    const resposta = await fetch(`${BLOCKFROST_URLS[REDE_CARDANO]}/addresses/${ENDERECO_CONSULTA_ANCORAGENS}/transactions?order=asc&count=100&page=${pagina}`, { headers: { project_id: BLOCKFROST_API_KEY } });
    if (!resposta.ok) throw new Error(`Não foi possível ler o histórico on-chain: HTTP ${resposta.status}.`);
    const lote = await resposta.json();
    transacoes.push(...lote);
    if (lote.length < 100) break;
  }
  return transacoes;
}

async function auditarHistoricoOnChain(registrosLocais) {
  const txLocais = new Set(registrosLocais.map((registro) => registro.txHash));
  const transacoes = await listarTransacoesDoEmissor();
  let ausentes = 0;
  for (const transacao of transacoes) {
    const resposta = await fetch(`${BLOCKFROST_URLS[REDE_CARDANO]}/txs/${transacao.tx_hash}/metadata`, { headers: { project_id: BLOCKFROST_API_KEY } });
    if (!resposta.ok) continue;
    const metadados = await resposta.json();
    const ancora = metadados.find((item) => String(item.label) === String(LABEL_METADADOS))?.json_metadata;
    if (!ancora?.merkle_root || txLocais.has(transacao.tx_hash)) continue;
    ausentes += 1;
    console.error(`ALERTA HISTÓRICO APAGADO: Tx ${transacao.tx_hash} existe on-chain, mas não está em ${ARQUIVO_HASH}.`);
  }
  return ausentes;
}

async function auditarJanelasDiretamente() {
  const janelas = Coletor.listarJanelasLocais();
  if (!janelas.length) {
    fs.writeFileSync(ARQUIVO_ULTIMO_SCAN, JSON.stringify({ executadoEm: new Date().toISOString(), resultados: [] }, null, 2));
    return { integro: 0, pendente: 0, alerta: 0 };
  }
  const transacoes = await listarTransacoesDoEmissor();
  const porIntervalo = new Map();
  for (const transacao of transacoes) {
    const resposta = await fetch(`${BLOCKFROST_URLS[REDE_CARDANO]}/txs/${transacao.tx_hash}/metadata`, { headers: { project_id: BLOCKFROST_API_KEY } });
    if (!resposta.ok) continue;
    const ancora = (await resposta.json()).find((item) => String(item.label) === String(LABEL_METADADOS))?.json_metadata;
    if (ancora?.merkle_root && Number.isFinite(Number(ancora.inicio_grupo)) && Number.isFinite(Number(ancora.fim_grupo))) {
      porIntervalo.set(`${ancora.inicio_grupo}:${ancora.fim_grupo}`, { ...ancora, txHash: transacao.tx_hash });
    }
  }
  let integro = 0; let pendente = 0; let alerta = 0;
  const resultados = [];
  for (const janela of janelas) {
    const ancora = porIntervalo.get(`${Math.floor(janela.inicio_grupo)}:${Math.floor(janela.fim_grupo)}`);
    if (!ancora) {
      pendente += 1;
      resultados.push({ inicio_grupo: janela.inicio_grupo, fim_grupo: janela.fim_grupo, estado: "pendente", mensagem: "Sem âncora on-chain para este intervalo." });
      console.warn(`PENDENTE intervalo ${janela.inicio_grupo}-${janela.fim_grupo}: sem âncora on-chain.`);
      continue;
    }
    if (ancora.merkle_root === janela.merkle_root) {
      integro += 1;
      resultados.push({ inicio_grupo: janela.inicio_grupo, fim_grupo: janela.fim_grupo, txHash: ancora.txHash, estado: "integro", mensagem: "Merkle root do intervalo confirmada on-chain.", merkle_local: janela.merkle_root, merkle_on_chain: ancora.merkle_root });
      console.log(`ÍNTEGRO intervalo ${janela.inicio_grupo}-${janela.fim_grupo}`);
    } else {
      alerta += 1;
      resultados.push({ inicio_grupo: janela.inicio_grupo, fim_grupo: janela.fim_grupo, txHash: ancora.txHash, estado: "alerta", mensagem: "Merkle root local diverge da blockchain.", merkle_local: janela.merkle_root, merkle_on_chain: ancora.merkle_root });
      console.error(`ALERTA intervalo ${janela.inicio_grupo}-${janela.fim_grupo}: Merkle root local diverge da blockchain.`);
    }
  }
  fs.writeFileSync(ARQUIVO_ULTIMO_SCAN, JSON.stringify({ executadoEm: new Date().toISOString(), resultados }, null, 2));
  console.log(`Auditoria de janelas concluída: ${integro} íntegro(s), ${pendente} pendente(s), ${alerta} alerta(s).`);
  return { integro, pendente, alerta };
}

async function validarSolicitacaoDeTroca(txHash) {
  const cabecalhos = { project_id: BLOCKFROST_API_KEY };
  const [utxosResposta, metadadosResposta] = await Promise.all([
    fetch(`${BLOCKFROST_URLS[REDE_CARDANO]}/txs/${txHash}/utxos`, { headers: cabecalhos }),
    fetch(`${BLOCKFROST_URLS[REDE_CARDANO]}/txs/${txHash}/metadata`, { headers: cabecalhos }),
  ]);
  if (utxosResposta.status === 404 || metadadosResposta.status === 404) return { pendente: true };
  if (!utxosResposta.ok || !metadadosResposta.ok) return { pendente: true };

  const utxos = await utxosResposta.json();
  const metadados = await metadadosResposta.json();
  const pedido = metadados.find((item) => String(item.label) === String(LABEL_SOLICITACAO_TROCA))?.json_metadata;
  const novoEndereco = pedido?.novo_endereco_auditor;
  const veioDoChefe = utxos.inputs?.some((entrada) => entrada.address === ENDERECO_EMISSOR);
  const pagouHKoin = utxos.outputs?.some((saida) => saida.address === ENDERECO_COFRE_HKOIN
    && saida.amount?.some((ativo) => ativo.unit === UNIDADE_HKOIN && BigInt(ativo.quantity) >= 1n));

  if (pedido?.acao !== "trocar_endereco_auditor" || !enderecoCardanoValido(novoEndereco)) return { valido: false, motivo: "Metadado de troca ausente ou endereço novo inválido." };
  if (!veioDoChefe) return { valido: false, motivo: "A solicitação não partiu do ENDERECO_EMISSOR autorizado." };
  if (!pagouHKoin) return { valido: false, motivo: "A transação não transferiu 1 HKoin ao cofre configurado." };
  return { valido: true, novoEndereco };
}

async function processarSolicitacoesDeTroca() {
  if (!ENDERECO_EMISSOR) return;
  const processadas = lerSolicitacoesProcessadas();
  const transacoes = await buscarSolicitacoesDeTroca();
  for (const transacao of [...transacoes].reverse()) {
    if (processadas.has(transacao.tx_hash)) continue;
    const resultado = await validarSolicitacaoDeTroca(transacao.tx_hash);
    if (resultado.pendente) continue;
    if (!resultado.valido) continue;
    console.log(`Solicitação válida encontrada (${transacao.tx_hash}). Iniciando auditoria geral antes da troca.`);
    const auditoria = await auditarGeral(true);
    if (auditoria.pendente > 0) {
      console.warn(`Troca aguardando: ${auditoria.pendente} lote(s) ainda pendente(s) de indexação.`);
      continue;
    }
    if (auditoria.alerta > 0) {
      registrarSolicitacaoBloqueada({ txHash: transacao.tx_hash, novoEndereco: resultado.novoEndereco, status: "bloqueada_integridade", alertas: auditoria.alerta });
      console.error("Troca bloqueada: a auditoria geral encontrou alerta(s). Corrija-os e envie uma nova solicitação.");
      continue;
    }
    registrarTrocaAuditor({ txHash: transacao.tx_hash, novoEndereco: resultado.novoEndereco, status: "aceita_apos_auditoria_geral", lotesVerificados: auditoria.integro });
    console.log(`Troca aplicada após auditoria geral: auditor alterado para ${resultado.novoEndereco} (Tx ${transacao.tx_hash}).`);
  }
}

async function solicitarTrocaAuditor(novoEndereco) {
  if (!enderecoCardanoValido(novoEndereco)) throw new Error("Novo endereço auditor inválido.");
  const lucid = await criarLucid();
  const tx = await lucid.newTx()
    .pay.ToAddress(ENDERECO_COFRE_HKOIN, { lovelace: VALOR_MINIMO_TRANSFERENCIA_HKOIN, [UNIDADE_HKOIN]: 1n })
    .attachMetadata(LABEL_SOLICITACAO_TROCA, { acao: "trocar_endereco_auditor", novo_endereco_auditor: novoEndereco })
    .complete();
  const txHash = await (await tx.sign.withWallet().complete()).submit();
  console.log(`Solicitação enviada: ${txHash}. O robô aceitará após a indexação Blockfrost.`);
}

function registroLocal(txHash) {
  return Coletor.lerHistorico(ARQUIVO_HASH).find((registro) => registro.txHash === txHash);
}

async function verificarUmaVez(txHash) {
  const local = registroLocal(txHash);
  if (!local) return { valido: false, violacao: true, motivo: "Transação não existe no histórico local." };
  const recalculado = Coletor.recalcularLote(local);
  if (!recalculado.valido) {
    return {
      valido: false,
      violacao: true,
      esperado: local.merkle_root,
      encontrado: recalculado.merkle_root,
      motivo: recalculado.motivo,
    };
  }
  try {
    const resposta = await fetch(`${BLOCKFROST_URLS[REDE_CARDANO]}/txs/${txHash}/metadata`, { headers: { project_id: BLOCKFROST_API_KEY } });
    // É normal a Blockfrost ainda não conhecer uma transação recém-submetida.
    if (resposta.status === 404) return { valido: false, pendente: true, motivo: "Transação ainda não indexada pela Blockfrost." };
    if (!resposta.ok) return { valido: false, pendente: true, motivo: `Blockfrost respondeu HTTP ${resposta.status}.` };
    const metadados = await resposta.json();
    const registro = metadados.find((item) => String(item.label) === String(LABEL_METADADOS));
    const raizOnChain = registro?.json_metadata?.merkle_root;
    if (!raizOnChain) return { valido: false, pendente: true, motivo: "Metadado ainda não indexado pela Blockfrost." };
    if (raizOnChain === local.merkle_root) return { valido: true, data: local };
    return { valido: false, violacao: true, esperado: raizOnChain, encontrado: local.merkle_root, motivo: "Raiz Merkle local difere do metadado on-chain." };
  } catch (erro) {
    return { valido: false, pendente: true, motivo: `Falha temporária ao consultar Blockfrost: ${erro.message}` };
  }
}

async function verificarComTentativas(txHash) {
  let resultado;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_VERIFICACAO; tentativa += 1) {
    resultado = await verificarUmaVez(txHash);
    if (resultado.valido || resultado.violacao || tentativa === MAX_TENTATIVAS_VERIFICACAO) return resultado;
    console.warn(`PENDENTE: ${txHash}. Nova consulta ${tentativa + 1}/${MAX_TENTATIVAS_VERIFICACAO} em ${DELAY_RETRY_VERIFICACAO_MS / 1000}s.`);
    await esperar(DELAY_RETRY_VERIFICACAO_MS);
  }
  return resultado;
}

async function auditarRegistros(registros, aguardarIndexacao = true) {
  if (!registros.length) {
    console.log("Sem lotes ancorados no histórico.");
    return { integro: 0, pendente: 0, alerta: 0 };
  }
  if (aguardarIndexacao) {
    console.log(`Aguardando ${DELAY_ANTES_AUDITORIA_MS / 1000}s para a Blockfrost indexar a última transação...`);
    await esperar(DELAY_ANTES_AUDITORIA_MS);
  }
  console.log(`Auditando ${registros.length} lote(s)...`);
  let integro = 0; let pendente = 0; let alerta = 0;
  for (const registro of registros) {
    const resultado = await verificarComTentativas(registro.txHash);
    if (resultado.valido) { integro += 1; console.log(`ÍNTEGRO  ${registro.txHash}`); }
    else if (resultado.pendente) { pendente += 1; console.warn(`PENDENTE ${registro.txHash}: ${resultado.motivo}`); }
    else { alerta += 1; console.error(`ALERTA   ${registro.txHash}: ${resultado.motivo}`); }
  }
  console.log(`Auditoria concluída: ${integro} íntegro(s), ${pendente} pendente(s), ${alerta} alerta(s).`);
  return { integro, pendente, alerta };
}

async function auditarTudo() {
  await auditarGeral(true);
}

async function auditarGeral(aguardarIndexacao = true) {
  if (!AUDITAR_HISTORICO_COMPLETO) return auditarJanelasDiretamente();
  const lotesAncorados = Coletor.lerHistorico(ARQUIVO_HASH).filter((registro) => registro.txHash && registro.merkle_root);
  const auditoriaLocal = await auditarRegistros(lotesAncorados, aguardarIndexacao);
  const apagados = AUDITAR_HISTORICO_COMPLETO ? await auditarHistoricoOnChain(lotesAncorados) : 0;
  const resultado = { ...auditoriaLocal, alerta: auditoriaLocal.alerta + apagados, apagados };
  if (apagados > 0) console.error(`Auditoria externa encontrou ${apagados} lote(s) removido(s) do histórico local.`);
  return resultado;
}

async function modoAutomatico() {
  adquirirBloqueio();
  console.log("Robô iniciado. Logs pendentes nunca são descartados por tempo.");
  let ancoragensDesdeAuditoria = 0;
  while (true) {
    try {
      await processarSolicitacoesDeTroca();
    } catch (erro) {
      console.error(`Falha ao consultar solicitações de troca (ancoragem continuará): ${erro.message}`);
    }
    try {
      const lote = Coletor.processarLote();
      if (lote) {
        const txHash = await ancorarHash(lote);
        if (txHash) {
          Coletor.registrarLoteAncorado(lote, txHash);
          console.log(`Ancoragem enviada: ${txHash}`);
          ancoragensDesdeAuditoria += 1;
          if (ancoragensDesdeAuditoria >= INTERVALO_AUDITORIA) {
            await auditarGeral(true);
            ancoragensDesdeAuditoria = 0;
          }
        }
      }
    } catch (erro) {
      console.error(`Erro no ciclo (o robô continuará): ${erro.message}`);
    }
    await esperar(INTERVALO_ROBO_MS);
  }
}

async function ancorarUmaVez() {
  const lote = Coletor.processarLote();
  if (!lote) return console.log("Nenhum lote pendente para ancorar.");
  const txHash = await ancorarHash(lote);
  if (!txHash) return;
  Coletor.registrarLoteAncorado(lote, txHash);
  console.log(`Ancoragem enviada: ${txHash}`);
}

const [, , comando, txHash] = process.argv;
(async () => {
  const ancora = comando === "rodar" || comando === "ancorar" || comando === "solicitar-troca";
  validarConfiguracao(ancora);
  if (comando === "rodar") await modoAutomatico();
  else if (comando === "ancorar") await ancorarUmaVez();
  else if (comando === "auditar") await auditarTudo();
  else if (comando === "verificar" && txHash) await auditarRegistros([ { txHash } ], true);
  else if (comando === "solicitar-troca" && txHash) await solicitarTrocaAuditor(txHash);
  else console.log("Uso: node main.js rodar | ancorar | auditar | verificar <txHash> | solicitar-troca <novoEndereco>");
})().catch((erro) => { console.error(`Falha: ${erro.message}`); process.exitCode = 1; });
