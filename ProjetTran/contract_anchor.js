import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Blockfrost, Constr, Data, Lucid } from "@lucid-evolution/lucid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URLS_BLOCKFROST = { Preview: "https://cardano-preview.blockfrost.io/api/v0", Preprod: "https://cardano-preprod.blockfrost.io/api/v0" };

function lerJson(caminho) {
  if (!fs.existsSync(caminho)) throw new Error(`Arquivo JSON não encontrado: ${caminho}`);
  const conteudo = fs.readFileSync(caminho, "utf8").trim();
  if (!conteudo) throw new Error(`Arquivo JSON vazio: ${caminho}`);
  try {
    return JSON.parse(conteudo);
  } catch (erro) {
    throw new Error(`Arquivo JSON inválido (${caminho}): ${erro.message}`);
  }
}

export async function criarAncoragemPorContrato(lote, configuracao) {
  const { rede, blockfrostApiKey, seedDispositivo, enderecoReceptor, labelMetadados, valorLovelace } = configuracao;
  if (!URLS_BLOCKFROST[rede] || !seedDispositivo || !enderecoReceptor) throw new Error("Configuração de ancoragem por contrato incompleta.");
  const manifesto = lerJson(path.join(__dirname, "contract-build", "manifest.json"));
  const estado = lerJson(path.join(__dirname, "data", "contrato_estado.json"));
  if (!estado.confirmadoEm) throw new Error("Contrato ainda não está confirmado on-chain.");
  const registry = lerJson(manifesto.arquivos.registry);
  const lucid = await Lucid(new Blockfrost(URLS_BLOCKFROST[rede], blockfrostApiKey), rede);
  lucid.selectWallet.fromSeed(seedDispositivo);
  const enderecoDispositivo = await lucid.wallet().address();
  const utxos = await lucid.utxosAt(manifesto.enderecoContrato);
  const estadoUtxo = utxos.find((utxo) => utxo.assets[manifesto.stateTokenUnit] === 1n);
  if (!estadoUtxo?.datum) throw new Error("UTxO de estado do contrato não encontrado ou sem datum inline.");

  const submit = Data.to(new Constr(0, []));
  const validator = { type: "PlutusV3", script: registry.cborHex };
  const tx = await lucid.newTx()
    .collectFrom([estadoUtxo], submit)
    .attach.SpendingValidator(validator)
    .addSigner(enderecoDispositivo)
    .pay.ToContract(manifesto.enderecoContrato, { kind: "inline", value: estadoUtxo.datum }, estadoUtxo.assets)
    .pay.ToAddress(enderecoReceptor, { lovelace: valorLovelace })
    .attachMetadata(labelMetadados, {
      merkle_root: lote.merkle_root,
      qtd: lote.quantidade_logs,
      inicio_grupo: Math.floor(lote.inicio_grupo),
      fim_grupo: Math.floor(lote.fim_grupo),
      autorizado_por_contrato: "true",
    })
    .complete();
  return { tx, estadoUtxo, enderecoContrato: manifesto.enderecoContrato, stateTokenUnit: manifesto.stateTokenUnit };
}
