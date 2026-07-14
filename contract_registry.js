import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_TITLE = "acess_registry.access_registry.spend";
const STATE_TOKEN_TITLE = "state_token.state_token.mint";
const ARQUIVO_ESTADO_CONTRATO = path.join(__dirname, "data", "contrato_estado.json");

function carregarEnvLocal() {
  const arquivo = path.join(__dirname, ".env");
  if (!fs.existsSync(arquivo)) return;
  for (const linha of fs.readFileSync(arquivo, "utf8").split("\n")) {
    const encontrada = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (encontrada && process.env[encontrada[1]] === undefined) {
      process.env[encontrada[1]] = encontrada[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

carregarEnvLocal();

function caminhoBlueprint() {
  const candidatos = [
    process.env.CONTRATO_BLUEPRINT,
    path.join(__dirname, "access-registry", "plutus.json"),
    path.join(__dirname, "contracts", "access-registry", "plutus.json"),
  ].filter(Boolean);
  return candidatos.find((caminho) => fs.existsSync(caminho));
}

export function statusContrato() {
  const blueprint = caminhoBlueprint();
  if (!blueprint) return { estado: "aguardando_blueprint", mensagem: "Contrato ainda não foi copiado para o projeto do robô." };
  try {
    const dados = JSON.parse(fs.readFileSync(blueprint, "utf8"));
    const titulos = new Set((dados.validators || []).map((validator) => validator.title));
    const compilado = titulos.has(REGISTRY_TITLE) && titulos.has(STATE_TOKEN_TITLE);
    const estadoLocal = fs.existsSync(ARQUIVO_ESTADO_CONTRATO) ? JSON.parse(fs.readFileSync(ARQUIVO_ESTADO_CONTRATO, "utf8")) : null;
    const inicializado = Boolean(estadoLocal?.confirmadoEm || (process.env.CONTRATO_STATE_POLICY_ID && process.env.CONTRATO_REGISTRY_ADDRESS));
    const enviado = Boolean(estadoLocal?.txHash && !inicializado);
    return {
      estado: inicializado ? "inicializado" : enviado ? "enviado_pendente" : compilado ? "compilado" : "blueprint_invalido",
      mensagem: inicializado ? "Contrato confirmado on-chain." : enviado ? "Transação enviada; aguardando indexação da Blockfrost." : compilado ? "Contrato compilado e pronto para inicialização." : "O blueprint não contém os validadores esperados.",
    };
  } catch {
    return { estado: "blueprint_invalido", mensagem: "Não foi possível ler o plutus.json." };
  }
}

async function listarUtxosChefe() {
  const urls = {
    Preview: "https://cardano-preview.blockfrost.io/api/v0",
    Preprod: "https://cardano-preprod.blockfrost.io/api/v0",
    Mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
  };
  const rede = process.env.REDE_CARDANO || "Preview";
  const endereco = process.env.ENDERECO_EMISSOR;
  const chave = process.env.BLOCKFROST_API_KEY;
  if (!urls[rede] || !endereco || !chave) throw new Error("Configure REDE_CARDANO, ENDERECO_EMISSOR e BLOCKFROST_API_KEY no .env.");
  const resposta = await fetch(`${urls[rede]}/addresses/${endereco}/utxos?order=asc&count=100`, { headers: { project_id: chave } });
  if (!resposta.ok) throw new Error(`Blockfrost respondeu HTTP ${resposta.status}.`);
  const utxos = await resposta.json();
  return utxos.map((utxo) => ({
    referencia: `${utxo.tx_hash}#${utxo.output_index}`,
    ada: Number(utxo.amount.find((ativo) => ativo.unit === "lovelace")?.quantity || 0) / 1_000_000,
    tokens: utxo.amount.filter((ativo) => ativo.unit !== "lovelace").map((ativo) => ({ unidade: ativo.unit, quantidade: ativo.quantity })),
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "utxos") {
    listarUtxosChefe().then((utxos) => console.log(JSON.stringify(utxos, null, 2))).catch((erro) => { console.error(`Erro: ${erro.message}`); process.exitCode = 1; });
  } else console.log(JSON.stringify(statusContrato(), null, 2));
}
