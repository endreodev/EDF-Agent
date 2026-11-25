# Retorna o IP externo (publico) da maquina
try { Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 10 }
catch { Invoke-RestMethod -Uri "https://ifconfig.me/ip" -TimeoutSec 10 }
