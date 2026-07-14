import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Blockfrost, Constr, Data, Lucid } from "@lucid-evolution/lucid";

const root = path.dirname(fileURLToPath(import.meta.url));
const ESTADO = path.join(root, "data", "registry_state.json");
const HISTORICO = path.join(root, "data", "registry_actions.jsonl");
const BF = "https://cardano-preview.blockfrost.io/api/v0";
function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function info(address) {
  const raw = JSON.parse(execFileSync("cardano-cli", ["address", "info", "--address", address], { encoding: "utf8" })).base16;
  if (!/^00[0-9a-f]{112}$/i.test(raw)) throw new Error("Esta versão aceita endereços-base de chave na Preview.");
  return { address, pkh: raw.slice(2, 58), stake: raw.slice(58, 114) };
}
function cred(pkh) { return new Constr(0, [pkh]); }
function addr(info) { return new Constr(0, [cred(info.pkh), new Constr(0, [new Constr(0, [cred(info.stake)])])]); }
function datum(state) { return Data.to(new Constr(0, [state.chief.pkh, state.devices.map(x => x.pkh), addr(state.receiver), state.proposed ? new Constr(0, [addr(state.proposed)]) : new Constr(1, []), BigInt(state.version)])); }
function loadState(env) {
  if (fs.existsSync(ESTADO)) return json(ESTADO);
  return { chief: info(env.ENDERECO_EMISSOR), devices: [info(env.ENDERECO_DISPOSITIVO_INICIAL)], receiver: info(env.ENDERECO_AUDITOR), proposed: null, version: 0 };
}
function save(state, event) { fs.mkdirSync(path.dirname(ESTADO), { recursive: true }); fs.writeFileSync(ESTADO, JSON.stringify(state, null, 2)); fs.appendFileSync(HISTORICO, `${JSON.stringify(event)}\n`); }
export function lerEstadoRegistro(env) { const s = loadState(env); return { chief: s.chief.address, devices: s.devices.map(x => x.address), receiver: s.receiver.address, proposed: s.proposed?.address || null, version: s.version }; }
export function lerHistoricoRegistro() { if (!fs.existsSync(HISTORICO)) return []; return fs.readFileSync(HISTORICO, "utf8").split("\n").filter(Boolean).flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}).reverse(); }
export async function executarAcaoRegistro(env, { acao, mnemonic, endereco }) {
  if (!mnemonic) throw new Error("Entre com o mnemonic antes de executar uma ação.");
  const manifest = json(path.join(root, "contract-build", "manifest.json")); const script = json(manifest.arquivos.registry);
  const state = loadState(env); const lucid = await Lucid(new Blockfrost(BF, env.BLOCKFROST_API_KEY), "Preview"); lucid.selectWallet.fromSeed(mnemonic);
  const signer = await lucid.wallet().address(); const signerInfo = info(signer);
  const isChief = signer === state.chief.address; const isDevice = state.devices.some(x => x.address === signer);
  let index, fields, next, label;
  if (acao === "autorizar") { if (!isChief) throw new Error("Apenas a chefe pode autorizar."); const d=info(endereco); if(state.devices.some(x=>x.address===d.address)) throw new Error("Carteira já autorizada."); next={...state,devices:[d,...state.devices],version:state.version+1}; index=3;fields=[d.pkh];label="Dispositivo autorizado"; }
  else if (acao === "revogar") { if (!isChief) throw new Error("Apenas a chefe pode revogar."); const d=info(endereco); next={...state,devices:state.devices.filter(x=>x.address!==d.address),version:state.version+1}; index=4;fields=[d.pkh];label="Dispositivo revogado"; }
  else if (acao === "propor_receptor") { if (!isDevice) throw new Error("Apenas dispositivo autorizado pode propor receptor."); const r=info(endereco); next={...state,proposed:r,version:state.version+1}; index=1;fields=[addr(r)];label="Troca de receptor proposta"; }
  else if (acao === "aprovar_receptor") { if (!isChief) throw new Error("Apenas a chefe pode aprovar."); if(!state.proposed) throw new Error("Não há troca pendente."); next={...state,receiver:state.proposed,proposed:null,version:state.version+1}; index=2;fields=[];label="Troca de receptor aprovada"; }
  else throw new Error("Ação inválida.");
  const u=(await lucid.utxosAt(manifest.enderecoContrato)).find(x=>x.assets[manifest.stateTokenUnit]===1n); if(!u?.datum) throw new Error("UTxO de estado não encontrado.");
  const tx=await lucid.newTx().collectFrom([u],Data.to(new Constr(index,fields))).attach.SpendingValidator({type:"PlutusV3",script:script.cborHex}).addSigner(signer).pay.ToContract(manifest.enderecoContrato,{kind:"inline",value:datum(next)},u.assets).complete();
  const txHash=await (await tx.sign.withWallet().complete()).submit();
  const enderecoRelacionado = acao === "aprovar_receptor" ? next.receiver.address : endereco || null;
  save(next,{acao,label,txHash,por:signer,em:new Date().toISOString(),endereco:enderecoRelacionado});
  return {txHash,label,state:lerEstadoRegistro({...env,...next})};
}
