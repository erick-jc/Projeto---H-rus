# Hórus

Hórus é um robô local de integridade para logs. Ele agrupa eventos por janelas de tempo, calcula uma Merkle root, ancora essa prova na Cardano Preview e permite auditar cada intervalo com os logs locais e os metadados on-chain da Blockfrost.

O projeto acrescenta uma camada de evidência e controle de acesso ao processo de logs. Ele não substitui controles tradicionais de segurança, como autenticação, backups, controle de acesso, monitoramento e proteção do servidor que armazena os logs.

## Como funciona

1. `simulador.py` gera logs em `data/logs.jsonl`.
2. O coletor separa os logs em janelas temporais fixas, como 90 ou 120 segundos.
3. Quando uma janela fecha, o robô aplica o mascaramento configurado, calcula as folhas e a Merkle root do intervalo.
4. Um dispositivo autorizado envia a âncora à Cardano através do contrato Aiken.
5. A âncora contém a Merkle root, a quantidade de logs e os limites inicial e final da janela.
6. No scan, o Hórus recalcula a Merkle root diretamente dos logs brutos locais do mesmo intervalo e a compara com a raiz registrada na blockchain.

Assim, alterar ou apagar um log dentro de uma janela já ancorada produz um `ALERTA` para aquele intervalo. Uma transação que ainda não apareceu na Blockfrost é tratada como `PENDENTE`, e não como falha de integridade.

## Preparação

No Ubuntu, dentro de `~/Projetos/ProjetTran`:

1. Copie `.env.example` para `.env` e configure a rede, a chave da Blockfrost e os endereços necessários.
2. Instale as dependências com `npm install`.
3. Gere logs, se necessário, com `python3 simulador.py`.

Nunca inclua seeds ou mnemonics no README, no Git ou em capturas de tela. O painel usa o mnemonic somente em memória durante a sessão local.

## Configuração recomendada

Exemplo de configuração para uso com contrato e janelas de 90 segundos:

```env
USAR_CONTRATO_ACESSO=true
AUDITAR_HISTORICO_COMPLETO=false

INTERVALO_LOTE_SEG=90
ATRASO_FECHAMENTO_JANELA_SEG=5
INTERVALO_ROBO_MS=25000
INTERVALO_AUDITORIA=5

MAX_TENTATIVAS_ANCORAGEM=5
DELAY_RETRY_ANCORAGEM_MS=30000
```

`INTERVALO_LOTE_SEG` precisa permanecer igual durante uma sequência de lotes que será auditada. Não altere esse valor no meio de uma demonstração que ainda contenha âncoras criadas com outro intervalo.

Quando `USAR_CONTRATO_ACESSO=true`, as âncoras são assinadas pelo dispositivo configurado, não pelo emissor/chefe. Se necessário, configure `ENDERECO_CONSULTA_ANCORAGENS` com o endereço desse dispositivo para que o scan localize as transações corretas.

## Comandos

- `node main.js rodar`: inicia o robô contínuo. Ele ancora uma janela fechada por ciclo e faz um scan automático a cada `INTERVALO_AUDITORIA` ancoragens.
- `node main.js ancorar`: tenta ancorar somente a próxima janela fechada.
- `node main.js auditar`: refaz a auditoria das janelas locais e compara com as âncoras on-chain.
- `node main.js verificar <txHash>`: consulta uma transação específica registrada localmente.
- `node dashboard.js`: inicia o painel local em `http://127.0.0.1:3030`.

Abra o painel pelo endereço `http://127.0.0.1:3030`; não abra o HTML por duplo clique (`file://`), pois ele não consegue chamar a API local.

## Contrato de acesso

O contrato Aiken mantém um UTxO de estado e controla as permissões:

- **Submit**: somente um dispositivo autorizado pode ancorar um lote.
- **ProposeReceiver**: somente um dispositivo autorizado pode propor um novo receptor.
- **ApproveProposal**: somente o chefe aprova a proposta de receptor.
- **AuthorizeDevice / RevokeDevice**: somente o chefe pode autorizar ou revogar dispositivos.

Cada ação recria o UTxO de estado com o mesmo valor e token de estado, atualizando apenas o datum necessário. A troca de receptor não é feita alterando o `.env`: ela deve seguir a proposta do dispositivo e a aprovação do chefe no contrato.

## Painel local

O painel permite login local, identifica o papel da carteira, mostra saldo em ADA, status do contrato e do Hórus, lista ancoragens e executa o scan manual.

Após o scan, as ancoragens exibem:

- `✓` verde: Merkle root local igual à raiz on-chain.
- `●` amarelo: âncora ainda não encontrada/indexada na Blockfrost.
- `✕` vermelho: Merkle root local diferente da blockchain.

O botão **Merkle local** revela a raiz recalculada localmente para uma ancoragem já avaliada.

## Arquivos locais

- `data/logs.jsonl`: logs brutos gerados/coletados.
- `data/log_hash.json`: histórico local das âncoras enviadas, com folhas, raiz e `txHash`.
- `data/ultimo_scan.json`: resultado visual da última auditoria por intervalo.
- `data/contrato_estado.json`: dados locais da implantação do contrato.
- `data/robo.lock`: indicador de que uma instância atual do robô está ativa.

Não apague `data/contrato_estado.json` para limpar uma demonstração: ele referencia a implantação do contrato. Para uma apresentação limpa, preserve o estado do contrato e inicie uma nova sequência de logs antes de ligar o robô.

## UTxO pendente

O contrato possui um único UTxO de estado. Toda ancoragem o consome e o recria; por isso, enquanto uma transação anterior ainda está sendo confirmada ou indexada, pode aparecer a mensagem `UTxO ainda pendente`.

O robô espera e tenta novamente. Se as tentativas se esgotarem, o lote continua pendente e será tentado no ciclo seguinte; os logs não são descartados. Para evitar conflitos, não execute duas instâncias de `node main.js rodar` ao mesmo tempo.
