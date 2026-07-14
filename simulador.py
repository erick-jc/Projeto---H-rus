"""
================================================================================
 SIMULADOR DE LOGS DE REDE — Projeto de Logs de Rede
 Gera logs fictícios continuamente em formato JSONL (1 log a cada N segundos).
 Esse arquivo é a "fonte de dados" que o coletor.js vai ler, mascarar e
 transformar em Árvore de Merkle.
================================================================================
"""

# ────────────────────────────────────────────────────────────────
# 1. IMPORTS E CONFIGURAÇÃO
# ────────────────────────────────────────────────────────────────
import json
import os
import random
import sys
import time
import uuid
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

ARQUIVO_LOGS = Path(os.getenv("ARQUIVO_LOGS", "./data/logs.jsonl"))
ARQUIVO_LOGS.parent.mkdir(parents=True, exist_ok=True)

# Intervalo padrão entre logs: 10 segundos (pode sobrescrever via .env)
INTERVALO_SEG = float(os.getenv("INTERVALO_SIMULADOR_SEG", "10"))

# ────────────────────────────────────────────────────────────────
# 2. DADOS FICTÍCIOS (POOLS PARA GERAÇÃO ALEATÓRIA)
# ────────────────────────────────────────────────────────────────
TIPOS_EVENTO = [
    "LOGIN_SUCESSO", "LOGIN_FALHA", "ACESSO_ARQUIVO",
    "ALTERACAO_PERMISSAO", "EXPORTACAO_DADOS", "LOGOUT",
    "ACESSO_API", "BLOQUEIO_FIREWALL", "ALTERACAO_CONFIGURACAO",
    "CRIACAO_USUARIO", "RESET_SENHA", "BACKUP_CONCLUIDO",
    "ALERTA_ANTIVIRUS", "CONEXAO_VPN", "FALHA_SERVICO",
]

USUARIOS = [
    "ana.silva", "bruno.costa", "carla.mendes", "diego.alves", "elisa.rocha",
    "felipe.lima", "gabriela.souza", "helena.martins", "igor.pereira", "juliana.ramos",
    "karen.moraes", "lucas.ferreira", "marina.gomes", "nicolas.araujo", "paula.nunes",
    "rafael.santos", "root", "admin.ti", "svc.backup", "svc.monitoramento",
]

NOMES_ARQUIVO = [
    "relatorio_financeiro.xlsx", "folha_pagamento.csv",
    "backup_db.sql", "contratos_2026.pdf", "config_servidor.yaml",
    "inventario_ativos.json", "chaves_api.enc", "planejamento_operacional.docx",
    "logs_aplicacao.tar.gz", "dashboard_metricas.csv", "politica_seguranca.pdf",
]

SERVICOS = ["portal-interno", "api-clientes", "postgres-prod", "nginx-gateway", "vpn-corporativa", "backup-noturno", "monitoramento", "ldap", "fila-processamento", "firewall-borda"]

# ────────────────────────────────────────────────────────────────
# 3. GERAÇÃO DE UM LOG INDIVIDUAL
# ────────────────────────────────────────────────────────────────
def gerar_log() -> dict:
    """
    Cria um dicionário com dados fictícios de log de rede.
    Observação: os dados PESSOAIS (usuario, ip_origem) ainda saem "em claro"
    aqui de propósito — o mascaramento LGPD é responsabilidade do COLETOR
    (separação de papéis: quem gera o dado bruto não decide o que é sensível).
    """
    evento = {
        "id_evento": str(uuid.uuid4()),
        "timestamp": time.time(),
        "usuario": random.choice(USUARIOS),
        "tipo_evento": random.choice(TIPOS_EVENTO),
        "ip_origem": f"192.168.{random.randint(0, 255)}.{random.randint(0, 255)}",
        "servico": random.choice(SERVICOS),
        "detalhes": random.choice(["Evento operacional simulado", "Registro de auditoria gerado", "Atividade monitorada pelo ambiente", "Evento de segurança para demonstração"]),
    }

    # Enriquecimento condicional: eventos de arquivo ganham um nome de arquivo
    if evento["tipo_evento"] in ("ACESSO_ARQUIVO", "EXPORTACAO_DADOS"):
        evento["arquivo_alvo"] = random.choice(NOMES_ARQUIVO)

    return evento


# ────────────────────────────────────────────────────────────────
# 4. GRAVAÇÃO (APPEND EM JSONL)
# ────────────────────────────────────────────────────────────────
def gravar_log(log: dict) -> None:
    """Adiciona uma nova linha ao arquivo JSONL (uma linha = um log)."""
    with open(ARQUIVO_LOGS, "a", encoding="utf-8") as f:
        f.write(json.dumps(log, ensure_ascii=False) + "\n")


# ────────────────────────────────────────────────────────────────
# 5. EXECUÇÃO CONTÍNUA (1 LOG A CADA INTERVALO_SEG)
# ────────────────────────────────────────────────────────────────
def rodar_simulador(intervalo: float = None) -> None:
    """Loop infinito: gera e grava um log a cada `intervalo` segundos."""
    intervalo = intervalo or INTERVALO_SEG
    print(f"📝 Simulador ativo em: {ARQUIVO_LOGS} | intervalo: {intervalo:.0f}s")
    contador = 0

    try:
        while True:
            grupo = [gerar_log() for _ in range(random.randint(1, 3))]
            for log in grupo:
                gravar_log(log)
                contador += 1
                print(f"[{contador}] {log['tipo_evento']:<24} | {log['usuario']:<20} | {log['servico']}")
            print(f"  -> grupo com {len(grupo)} log(s)")
            time.sleep(intervalo)
    except KeyboardInterrupt:
        print(f"\n🛑 Simulador interrompido. Total de logs gerados: {contador}")


# ────────────────────────────────────────────────────────────────
# 6. MODO LOTE (ÚTIL PARA TESTES RÁPIDOS, SEM ESPERAR O LOOP)
# ────────────────────────────────────────────────────────────────
def gerar_lote(qtd: int) -> None:
    """Gera 'qtd' logs instantaneamente (sem sleep entre eles)."""
    for _ in range(qtd):
        gravar_log(gerar_log())
    print(f"✅ {qtd} logs gerados em {ARQUIVO_LOGS}")


# ────────────────────────────────────────────────────────────────
# 7. CLI
# ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # Uso:
    #   python simulador.py                -> loop contínuo (1 log/10s)
    #   python simulador.py lote 50        -> gera 50 logs de uma vez
    if len(sys.argv) >= 2 and sys.argv[1] == "lote":
        quantidade = int(sys.argv[2]) if len(sys.argv) >= 3 else 10
        gerar_lote(quantidade)
    else:
        rodar_simulador()
