import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Blockfrost, Lucid } from "@lucid-evolution/lucid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function carregarEnvLocal() {
  const arquivo = path.join(__dirname, ".env");
  if (!fs.existsSync(arquivo)) return;
  for (const linha of fs.readFileSync(arquivo, "utf8").split("\n")) {
    const encontrada = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (encontrada && process.env[encontrada[1]] === undefined) process.env[encontrada[1]] = encontrada[2].replace(/^['"]|['"]$/g, "");
  }
}

async function main() {
  carregarEnvLocal();
  const seed = process.env.SEED_DISPOSITIVO;
  const esperado = process.env.ENDERECO_DISPOSITIVO_INICIAL;
  const chave = process.env.BLOCKFROST_API_KEY;
  if (!seed || !esperado || !chave) throw new Error("Preencha SEED_DISPOSITIVO, ENDERECO_DISPOSITIVO_INICIAL e BLOCKFROST_API_KEY no .env.");
  const lucid = await Lucid(new Blockfrost("https://cardano-preview.blockfrost.io/api/v0", chave), "Preview");
  lucid.selectWallet.fromSeed(seed);
  const derivado = await lucid.wallet().address();
  if (derivado !== esperado) throw new Error(`A seed não corresponde ao dispositivo autorizado. Endereço derivado: ${derivado}`);
  console.log(JSON.stringify({ valido: true, mensagem: "Seed do dispositivo confirmada para o endereço autorizado.", endereco: derivado }, null, 2));
}

main().catch((erro) => { console.error(`Erro: ${erro.message}`); process.exitCode = 1; });
