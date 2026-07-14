import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { criarAncoragemPorContrato } from "./contract_anchor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function carregarEnv() { for (const linha of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) { const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ""); } }

async function main() {
  carregarEnv();
  const lote = { merkle_root: "rascunho_contrato_sem_logs", quantidade_logs: 0, inicio_grupo: 0, fim_grupo: 0 };
  const resultado = await criarAncoragemPorContrato(lote, {
    rede: process.env.REDE_CARDANO || "Preview", blockfrostApiKey: process.env.BLOCKFROST_API_KEY,
    seedDispositivo: process.env.SEED_DISPOSITIVO, enderecoReceptor: process.env.ENDERECO_AUDITOR,
    labelMetadados: Number(process.env.LABEL_METADADOS || 721), valorLovelace: BigInt(process.env.VALOR_ANCORAGEM_LOVELACE || "1000000"),
  });
  console.log(JSON.stringify({ modo: "RASCUNHO VALIDADO — não assinado nem enviado.", contrato: resultado.enderecoContrato, tokenEstado: resultado.stateTokenUnit, entradaEstado: `${resultado.estadoUtxo.txHash}#${resultado.estadoUtxo.outputIndex}`, receptor: process.env.ENDERECO_AUDITOR, valorAda: Number(process.env.VALOR_ANCORAGEM_LOVELACE || "1000000") / 1_000_000 }, null, 2));
}
main().catch((erro) => { console.error(erro.stack || `Erro: ${erro.message}`); process.exitCode = 1; });
