# Hórus — integridade de logs com Cardano

Hórus é um robô local de integridade de logs. Ele agrupa eventos em janelas de tempo, calcula uma Merkle root, registra essa prova na Cardano Preview e permite verificar posteriormente se os logs locais permanecem íntegros.

O projeto possui duas partes:

- **Node.js:** simulador/coletor, criação das âncoras, auditoria e painel local;
- **Aiken:** contrato de acesso que representa as permissões do chefe e dos dispositivos autorizados.

## Como o fluxo funciona

1. `simulador.py` gera eventos em `data/logs.jsonl`.
2. `coletor.js` separa os eventos em lotes temporais.
3. `main.js` calcula a Merkle root de cada lote e envia a âncora para a Cardano Preview.
4. Em uma auditoria, o projeto recalcula a root com os logs locais e compara com os metadados da transação.
5. O painel em `http://127.0.0.1:3030` mostra o estado do robô, das âncoras e da auditoria.

Uma root divergente gera `ALERTA`. Uma transação ainda não indexada pela Blockfrost permanece como `PENDENTE`; ela não é tratada como falha de integridade.

## Pré-requisitos

Instale antes de executar:

- Node.js 18 ou superior;
- npm (instalado junto com o Node.js);
- Python 3;
- Aiken compatível com a versão `v1.1.21` indicada em `access-registry/aiken.toml`;
- conta/chave de projeto da Blockfrost para a rede Preview;
- carteiras da Cardano Preview com fundos de teste, se for enviar transações.

## Estrutura relevante

```text
.
├── access-registry/              # contrato Aiken
│   ├── aiken.toml
│   └── validators/
│       ├── acess_registry.ak
│       └── state_token.ak
├── contract-build/               # artefatos da implantação Preview preparada
│   ├── manifest.json
│   ├── access-registry.applied.json
│   └── state-token.applied.json
├── index.html                    # interface do painel
├── dashboard.js                  # servidor HTTP local do painel
├── main.js                       # robô, ancoragem e auditoria
├── coletor.js                    # leitura e agrupamento dos logs
├── simulador.py                  # gerador de logs de demonstração
├── package.json                  # dependências Node.js
└── .env.example                  # modelo de configuração local
```

As pastas `data/`, `node_modules/`, `venv/` e `access-registry/build/` são geradas localmente e não devem ser enviadas ao Git. A pasta `contract-build/` é diferente: ela contém os artefatos públicos da implantação Preview já preparada e deve permanecer no repositório.

## 1. Instalar as dependências Node.js

Na raiz do projeto:

```bash
npm install
```

Esse comando baixa `@lucid-evolution/lucid` e `dotenv` para `node_modules/`.

## 2. Criar a configuração local

Nunca envie o arquivo `.env` ao Git. Crie-o a partir do arquivo de exemplo:

No Linux/macOS:

```bash
cp .env.example .env
```

No PowerShell:

```powershell
Copy-Item .env.example .env
```

Edite o `.env` e preencha, no mínimo:

```env
REDE_CARDANO=Preview
BLOCKFROST_API_KEY=SUA_CHAVE_BLOCKFROST
SEED_PHRASE=SUA_SEED_LOCAL_DO_EMISSOR
ENDERECO_EMISSOR=SEU_ENDERECO_PREVIEW
ENDERECO_AUDITOR=ENDERECO_PREVIEW_DO_AUDITOR
```

Para utilizar o controle de acesso por contrato, preencha também `SEED_DISPOSITIVO`, `ENDERECO_DISPOSITIVO_INICIAL` e os dados da implantação. As seeds devem ficar somente no `.env` local. Não use valores reais em `.env.example`, no README ou no GitHub.

### Configuração para demonstração sem contrato de acesso

Para testar o fluxo de logs e metadados sem depender do UTxO de estado do contrato, use:

```env
USAR_CONTRATO_ACESSO=false
INTERVALO_LOTE_SEG=120
ATRASO_FECHAMENTO_JANELA_SEG=3
INTERVALO_ROBO_MS=30000
INTERVALO_AUDITORIA=5
```

Mesmo nesse modo, uma ancoragem real exige chave Blockfrost, seed e ADA de teste na carteira Preview.

## 3. Compilar o contrato Aiken

Entre na pasta do contrato e execute:

```bash
cd access-registry
aiken build
cd ..
```

O comando baixa as dependências declaradas em `aiken.toml`, cria `access-registry/build/` e gera `access-registry/plutus.json`. Os arquivos-fonte do contrato são:

- `validators/acess_registry.ak`: valida o estado e as ações de autorização;
- `validators/state_token.ak`: política do token que identifica o UTxO de estado.

Para conferir somente tipos/testes sem gerar o blueprint, use:

```bash
cd access-registry
aiken check
```

### Usar a implantação de contrato incluída

O repositório inclui `contract-build/manifest.json` e os scripts aplicados da implantação Preview. O `contract_anchor.js` usa esses arquivos quando `USAR_CONTRATO_ACESSO=true`; por isso, eles permitem executar o fluxo com o contrato já preparado, sem precisar criar manualmente o manifesto.

Para esse modo, altere no `.env` local:

```env
USAR_CONTRATO_ACESSO=true
SEED_DISPOSITIVO=SUA_SEED_DE_UM_DISPOSITIVO_AUTORIZADO
ENDERECO_AUDITOR=ENDERECO_PREVIEW_DO_RECEPTOR
```

O `contract-build/` não contém seeds nem chaves privadas, mas está vinculado a uma implantação específica na rede Preview. Para fazer uma implantação totalmente nova, não basta executar `aiken build`: é necessário gerar outro manifesto, inicializar o UTxO de estado e usar carteiras Preview com fundos de teste.

## 4. Gerar logs de demonstração

Na raiz do projeto:

```bash
python3 simulador.py
```

No Windows, se necessário:

```powershell
python simulador.py
```

O simulador cria/atualiza `data/logs.jsonl`.

## 5. Executar o robô e a auditoria

Inicie o robô contínuo:

```bash
npm run robo
```

Ou execute comandos individuais:

```bash
node main.js ancorar
node main.js auditar
node main.js verificar <txHash>
```

O robô só ancora uma janela depois que ela fecha. Não execute duas instâncias de `npm run robo` ao mesmo tempo, pois o arquivo `data/robo.lock` evita concorrência.

## 6. Abrir o painel

Em outro terminal, ainda na raiz do projeto:

```bash
npm run painel
```

Abra no navegador:

```text
http://127.0.0.1:3030
```

Não abra `index.html` com duplo clique (`file://`). O painel precisa do servidor `dashboard.js` para chamar a API local.

## Comandos disponíveis

| Comando | Função |
| --- | --- |
| `npm run robo` | Executa o ciclo contínuo de ancoragem e auditoria. |
| `npm run auditar` | Recalcula e verifica as âncoras locais. |
| `npm run painel` | Inicia o painel em `127.0.0.1:3030`. |
| `npm run contrato:status` | Mostra o estado do blueprint/contrato configurado. |
| `node main.js ancorar` | Tenta ancorar apenas o próximo lote fechado. |
| `node main.js verificar <txHash>` | Consulta uma âncora específica. |
| `aiken build` | Compila os `.ak` e gera o `plutus.json`. |

## Arquivos criados durante a execução

- `data/logs.jsonl`: logs brutos de entrada;
- `data/log_hash.json`: histórico local de Merkle roots e transações;
- `data/ultimo_scan.json`: resultado da última auditoria;
- `data/robo.lock`: marca uma instância ativa do robô.

Esses arquivos são dados de execução, não código-fonte. Eles são ignorados pelo Git e podem ser recriados em uma nova demonstração.

## Segurança

- Nunca publique `.env`, seeds, mnemonics, API keys ou arquivos de carteira.
- Use somente fundos de teste na Cardano Preview para fins acadêmicos.
- Antes de tornar o repositório público, confirme que `git status --ignored` não mostra nenhum segredo fora de `.env`.
