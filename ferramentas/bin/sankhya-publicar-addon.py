#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sankhya-publicar-addon.py - publica o .exts de um add-on na Area do Desenvolvedor Sankhya.
(Copiada do projeto Fenix - tools/areadev_publish.py - e generalizada para qualquer add-on.)

Faz o mesmo que a task `publishAddon` do plugin Gradle (br.com.sankhya.studio),
mas sobe um .exts JA GERADO (por `gerarAddon`), sem recompilar nada:
  1. POST https://account-api.sankhya.com.br/authentication
       {"username": email, "application_id": 23, "password": senha}  -> data.access_token
  2. POST https://areadev.sankhya.com.br/api/solution-versions/v2/binary
       Authorization: Bearer <token>; multipart: file=<.exts>, body={"changelog","environment"}

O destino e SEMPRE perguntado (ou informado com --destino):
  teste    : sobe a versao na Area do Desenvolvedor sem liberar para producao; no portal voce a
             disponibiliza para os ambientes de teste (a API nao publica direto em teste).
  producao : publica direto em producao (aparece em "Minhas Solucoes" no Sankhya Om).
Nao precisa de VPN (internet publica).

Uso (rode na pasta do add-on ou da raiz do projeto, ou passe --exts <arquivo>):
  python sankhya-publicar-addon.py login                      (so testa as credenciais)
  python sankhya-publicar-addon.py info                       (mostra o .exts que seria enviado)
  python sankhya-publicar-addon.py publicar --changelog "..."              (pergunta teste/producao)
  python sankhya-publicar-addon.py publicar --changelog "..." --destino teste --confirmar
  python sankhya-publicar-addon.py publicar --changelog "..." --destino producao --confirmar
Sem --exts, usa o .exts mais novo em build/libs (na pasta atual ou um nivel abaixo).

Credenciais (nesta ordem): variaveis AREADEV_USER / AREADEV_PWD; arquivo --env (CHAVE=valor);
ferramentas/conexoes/areadev.json {"usuario": "...", "senha": "..."} (fora do git).
"""
import argparse, hashlib, json, os, re, sys, zipfile

import requests

AQUI = os.path.dirname(os.path.abspath(__file__))
CRED_JSON = os.path.join(os.path.dirname(AQUI), "conexoes", "areadev.json")

AMBIENTES = {
    "prod":    ("https://account-api.sankhya.com.br",     "https://areadev.sankhya.com.br"),
    "staging": ("https://account-api-dev.sankhya.com.br", "https://areadev.sandbox-oke.sankhya.com.br"),
}
APPLICATION_ID = 23  # fixo no plugin (Area do Desenvolvedor)


def acha_exts():
    cwd = os.getcwd()
    bases = [cwd] + [os.path.join(cwd, d) for d in os.listdir(cwd) if os.path.isdir(os.path.join(cwd, d))]
    achados = []
    for base in bases:
        libs = os.path.join(base, "build", "libs")
        if os.path.isdir(libs):
            achados += [os.path.join(libs, f) for f in os.listdir(libs) if f.endswith(".exts")]
    return max(achados, key=os.path.getmtime) if achados else ""


def le_env(caminho):
    cfg = {}
    if caminho and os.path.exists(caminho):
        for linha in open(caminho, encoding="utf-8"):
            linha = linha.strip()
            if linha and not linha.startswith("#") and "=" in linha:
                k, _, v = linha.partition("=")
                cfg[k.strip().upper()] = v.strip()
    return cfg


def credenciais(args):
    cfg = le_env(args.env)
    js = {}
    if os.path.exists(CRED_JSON):
        js = json.load(open(CRED_JSON, encoding="utf-8"))
    usr = os.getenv("AREADEV_USER") or cfg.get("AREADEV_USER") or js.get("usuario")
    pwd = os.getenv("AREADEV_PWD") or cfg.get("AREADEV_PWD") or js.get("senha")
    if not usr or not pwd:
        sys.exit("ERRO: credenciais da Area do Desenvolvedor nao encontradas "
                 "(AREADEV_USER/AREADEV_PWD, --env ou %s)." % CRED_JSON)
    return usr, pwd


def versao_gradle(exts):
    # build/libs/x.exts -> ../../build.gradle
    gradle = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(exts)))), "build.gradle")
    try:
        m = re.search(r"version\s*=\s*['\"]([^'\"]+)['\"]", open(gradle, encoding="utf-8").read())
        return m.group(1) if m else "?"
    except OSError:
        return "?"


def info_exts(caminho):
    """Mostra o .exts e devolve o caminho usado."""
    caminho = caminho or acha_exts()
    if not caminho or not os.path.isfile(caminho):
        sys.exit("ERRO: .exts nao encontrado%s (rode `gradlew gerarAddon` ou use --exts)." % (": " + caminho if caminho else ""))
    dados = open(caminho, "rb").read()
    print("Arquivo : %s" % caminho)
    print("Tamanho : %d bytes" % len(dados))
    print("SHA-1   : %s" % hashlib.sha1(dados).hexdigest())
    print("Versao  : %s (build.gradle)" % versao_gradle(caminho))
    try:
        with zipfile.ZipFile(caminho) as z:
            for i in z.infolist():
                print("Conteudo: %s  %d bytes  %04d-%02d-%02d %02d:%02d" % ((i.filename, i.file_size) + i.date_time[:5]))
    except zipfile.BadZipFile:
        sys.exit("ERRO: o .exts nao e um zip valido.")
    return caminho


def login(args):
    usr, pwd = credenciais(args)
    conta, _ = AMBIENTES[args.ambiente]
    r = requests.post(conta + "/authentication", timeout=60,
                      json={"username": usr, "application_id": APPLICATION_ID, "password": pwd})
    try:
        corpo = r.json()
    except ValueError:
        corpo = {}
    token = ((corpo or {}).get("data") or {}).get("access_token")
    if r.status_code >= 400 or not token:
        msg = (corpo or {}).get("message") or r.text[:300]
        sys.exit("ERRO no login (HTTP %d) para %s: %s" % (r.status_code, usr, msg))
    print("Login OK: %s (%s)" % (usr, conta))
    return token


def pergunta(texto):
    try:
        return input(texto).strip().lower()
    except EOFError:
        sys.exit("\nNada enviado: sem terminal para responder. Use --destino teste|producao e --confirmar.")


def escolhe_destino(destino):
    if destino:
        return destino
    if not sys.stdin.isatty():
        sys.exit("\nERRO: informe o destino com --destino teste ou --destino producao.")
    while True:
        r = pergunta("\nPublicar em [t]este ou [p]roducao? ")
        if r in ("t", "teste"):
            return "teste"
        if r in ("p", "producao", "produção"):
            return "producao"
        print("Responda t (teste) ou p (producao).")


def publicar(args):
    args.exts = info_exts(args.exts)
    if not args.changelog:
        sys.exit("ERRO: informe --changelog \"o que mudou nesta versao\".")
    print("Changelog: %s" % args.changelog)
    destino = escolhe_destino(args.destino)
    args.prod = destino == "producao"
    print("Destino : %s" % ("PRODUCAO (Minhas Solucoes no Sankhya Om)" if args.prod
                            else "TESTE (fica no portal; liberar para teste em areadev.sankhya.com.br)"))
    if not args.confirmar:
        if not sys.stdin.isatty():
            sys.exit("\nNada enviado. Confira os dados acima e repita com --confirmar.")
        if pergunta("Confirma o envio para %s? [s/N] " % destino.upper()) not in ("s", "sim"):
            sys.exit("Nada enviado.")

    token = login(args)
    _, portal = AMBIENTES[args.ambiente]
    body = {"changelog": args.changelog}
    if args.prod:
        body["environment"] = "PROD"
    with open(args.exts, "rb") as fh:
        r = requests.post(portal + "/api/solution-versions/v2/binary", timeout=600,
                          headers={"Authorization": "Bearer " + token},
                          files={"file": (os.path.basename(args.exts), fh, "application/octetstream"),
                                 "body": (None, json.dumps(body), "application/json")})
    try:
        resp = r.json()
    except ValueError:
        resp = None
    if r.status_code >= 400:
        msg = (resp or {}).get("message") if isinstance(resp, dict) else None
        sys.exit("ERRO na publicacao (HTTP %d): %s" % (r.status_code, msg or r.text[:500]))

    resp = resp or {}
    print("\nPublicado (HTTP %d)." % r.status_code)
    for k in ("description", "solution_identifier", "last_version", "status"):
        if k in resp:
            print("  %-20s %s" % (k, resp[k]))
    if args.prod and str(resp.get("status", "")).upper() == "P":
        print("Versao disponivel em producao: instalar por 'Minhas Solucoes' no Sankhya Om.")
    else:
        print("Versao enviada. Conclua a publicacao em %s" % portal)


def main():
    ap = argparse.ArgumentParser(description="Publica o .exts de um add-on na Area do Desenvolvedor Sankhya.")
    ap.add_argument("--env", default="", help="arquivo CHAVE=valor com AREADEV_USER/AREADEV_PWD")
    ap.add_argument("--ambiente", choices=sorted(AMBIENTES), default="prod", help="prod (padrao) ou staging (sandbox Sankhya)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login", help="testa as credenciais")
    p = sub.add_parser("info", help="mostra o .exts que seria enviado")
    p.add_argument("--exts", default="")
    p = sub.add_parser("publicar", help="envia o .exts")
    p.add_argument("--exts", default="")
    p.add_argument("--changelog", help="descricao da versao (obrigatorio)")
    p.add_argument("--destino", choices=["teste", "producao"],
                   help="teste ou producao; sem isto a ferramenta pergunta")
    p.add_argument("--confirmar", action="store_true", help="envia sem pedir confirmacao")
    args = ap.parse_args()

    if args.cmd == "login":
        login(args)
    elif args.cmd == "info":
        info_exts(args.exts)
    else:
        publicar(args)


if __name__ == "__main__":
    main()
