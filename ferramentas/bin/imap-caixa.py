"""Lista e-mails de uma caixa IMAP (só leitura, não marca como lido).
Credenciais: arquivo .env com IMAP_HOST/IMAP_USER/IMAP_PASSWORD ou SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD
(o host imap. é deduzido do smtp.). Uso:
  python imap-caixa.py --env <projeto>/.env [--desde 09-Nov-2026] [--pasta INBOX|INBOX.Sent|INBOX.Junk] [--max 50] [--chars 300]
"""
import argparse, email, imaplib, re, sys
from email.header import decode_header, make_header

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ap = argparse.ArgumentParser()
ap.add_argument('--env', required=True)
ap.add_argument('--desde')
ap.add_argument('--pasta', default='INBOX')
ap.add_argument('--max', type=int, default=50)
ap.add_argument('--chars', type=int, default=300)
ap.add_argument('--pastas', action='store_true', help='só lista as pastas')
a = ap.parse_args()

env = {}
for l in open(a.env, encoding='utf-8'):
    m = re.match(r'^\s*([A-Z0-9_]+)=(.*)$', l)
    if m: env[m.group(1)] = m.group(2).strip()
host = env.get('IMAP_HOST') or env['SMTP_HOST'].replace('smtp.', 'imap.')
user = env.get('IMAP_USER') or env['SMTP_USERNAME']
senha = env.get('IMAP_PASSWORD') or env['SMTP_PASSWORD']

M = imaplib.IMAP4_SSL(host, int(env.get('IMAP_PORT', 993)))
M.login(user, senha)
if a.pastas:
    for p in M.list()[1]: print(p.decode().split(' "." ')[-1].split(' "/" ')[-1])
    sys.exit()
M.select(a.pasta, readonly=True)
crit = ['SINCE', a.desde] if a.desde else ['ALL']
ids = M.search(None, *crit)[1][0].split()[-a.max:]
print(f'{a.pasta}: {len(ids)} e-mail(s)')
h = lambda v: str(make_header(decode_header(v or '')))
for i in ids:
    msg = email.message_from_bytes(M.fetch(i, '(BODY.PEEK[])')[1][0][1])
    corpo = ''
    for tipo in ('text/plain', 'text/html'):
        for p in msg.walk():
            if p.get_content_type() == tipo and not p.get('Content-Disposition'):
                corpo = p.get_payload(decode=True).decode(p.get_content_charset() or 'utf-8', 'replace')
                if tipo == 'text/html': corpo = re.sub(r'<[^>]+>', ' ', corpo)
                break
        if corpo: break
    # corta o texto citado da mensagem anterior
    corpo = re.split(r'\n\s*(Em .{5,160}escreveu:|On .{5,160}wrote:|-----Original|De: )', corpo)[0]
    corpo = re.sub(r'\s+', ' ', corpo.replace('‌', '')).strip()[:a.chars]
    print(f"--- {h(msg['Date'])} | {h(msg['From'])} | {h(msg['Subject'])}\n    {corpo}")
M.logout()
