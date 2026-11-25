const { execFile } = require('child_process');

// Comandos rápidos do computador (sem passar pelo Claude), via PowerShell.
function ps(script, timeoutMs = 60000) {
  const full = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; ${script}`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', full],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() })
    );
  });
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ConvertTo-Json devolve objeto solto quando há um item só.
function jsonList(out) {
  const v = JSON.parse(out || '[]');
  return Array.isArray(v) ? v : [v];
}

function firstLine(err) {
  return String(err || 'erro desconhecido').split('\n').find((l) => l.trim()) || 'erro desconhecido';
}

const gb = (bytes) => (Number(bytes) / 1073741824).toFixed(1).replace('.', ',');

// Print de todas as telas, salvo em PNG.
async function screenshot(file) {
  const r = await ps(`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Name Dpi -Namespace Agente -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Agente.Dpi]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save(${quote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`);
  return r.ok ? { ok: true } : { ok: false, error: firstLine(r.err) };
}

// [{ id, name, size, free, pct }]
async function diskList() {
  const r = await ps(`Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, VolumeName, Size, FreeSpace | ConvertTo-Json`);
  if (!r.ok) return { ok: false, error: firstLine(r.err) };
  const list = jsonList(r.out).map((d) => ({
    id: d.DeviceID,
    name: d.VolumeName || '',
    size: d.Size,
    free: d.FreeSpace,
    pct: d.Size ? Math.round((1 - d.FreeSpace / d.Size) * 100) : 0,
  }));
  return { ok: true, list };
}

function describeDisk(d) {
  return `- *${d.id}*${d.name ? ` (${d.name})` : ''}: ${gb(d.free)} GB livres de ${gb(d.size)} GB · ${d.pct}% usado${d.pct >= 90 ? ' ⚠️' : ''}`;
}

async function disks() {
  const r = await diskList();
  if (!r.ok) return r;
  return { ok: true, text: `💽 *Discos*\n${r.list.map(describeDisk).join('\n')}` };
}

// Status dos serviços pelo nome exato: { nome: 'Running' | 'Stopped' | … | null (não existe) }
async function serviceStatus(names) {
  if (!names.length) return {};
  const r = await ps(
    `@(${names.map(quote).join(',')}) | ForEach-Object { $s = Get-Service -Name $_ -ErrorAction SilentlyContinue; [pscustomobject]@{ n = $_; s = if ($s) { "$($s.Status)" } else { $null } } } | ConvertTo-Json`
  );
  if (!r.ok || !r.out) return {};
  return Object.fromEntries(jsonList(r.out).map((x) => [x.n, x.s]));
}

// Momento do último boot do Windows (ms).
async function bootTime() {
  const r = await ps(`[int64]((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds`);
  return r.ok ? Number(r.out) || null : null;
}

async function processes() {
  const r = await ps(`
$os = Get-CimInstance Win32_OperatingSystem
$top = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Name, Id, @{n='MB';e={[math]::Round($_.WorkingSet64 / 1MB)}}
[pscustomobject]@{ total = $os.TotalVisibleMemorySize; free = $os.FreePhysicalMemory; top = @($top) } | ConvertTo-Json -Depth 3`);
  if (!r.ok) return { ok: false, error: firstLine(r.err) };
  const d = JSON.parse(r.out);
  const used = d.total - d.free;
  const ram = `RAM: ${gb(used * 1024)} de ${gb(d.total * 1024)} GB em uso (${Math.round((used / d.total) * 100)}%)`;
  const list = d.top.map((p) => `- ${p.Name} (${p.Id}): ${p.MB} MB`).join('\n');
  return { ok: true, text: `🧠 *Processos* · ${ram}\n${list}` };
}

const SERVICE_ACTIONS = { iniciar: 'Start-Service', parar: 'Stop-Service', reiniciar: 'Restart-Service' };

// Mostra o serviço ou executa iniciar/parar/reiniciar.
async function service(name, action) {
  if (!/^[\w .()-]{2,80}$/.test(name || '')) return { ok: false, error: 'Nome de serviço inválido.' };
  const find = `@(Get-Service | Where-Object { $_.Name -like ${quote(`*${name}*`)} -or $_.DisplayName -like ${quote(`*${name}*`)} })`;
  const show = `Select-Object Name, DisplayName, @{n='Status';e={"$($_.Status)"}}`;
  const list = await ps(`${find} | Select-Object -First 15 | ${show} | ConvertTo-Json`);
  if (!list.ok) return { ok: false, error: firstLine(list.err) };
  const found = list.out ? jsonList(list.out) : [];
  if (!found.length) return { ok: false, error: `Nenhum serviço encontrado com "${name}".` };
  const exact = found.find((s) => s.Name.toLowerCase() === name.toLowerCase() || s.DisplayName.toLowerCase() === name.toLowerCase());
  const describe = (s) => `- *${s.DisplayName}* (${s.Name}): ${s.Status === 'Running' ? '🟢 rodando' : s.Status === 'Stopped' ? '🔴 parado' : s.Status}`;
  if (!action) return { ok: true, text: `⚙️ *Serviços*\n${found.map(describe).join('\n')}` };
  const target = exact || (found.length === 1 ? found[0] : null);
  if (!target) return { ok: false, error: `Mais de um serviço com "${name}". Use o nome exato:\n${found.map(describe).join('\n')}` };
  const r = await ps(`${SERVICE_ACTIONS[action]} -Name ${quote(target.Name)}; Get-Service -Name ${quote(target.Name)} | ${show} | ConvertTo-Json`, 120000);
  if (!r.ok) {
    const err = firstLine(r.err);
    return { ok: false, error: /acesso|access|permiss/i.test(err) ? `Sem permissão para ${action} ${target.Name}: rode o bot como administrador.` : err };
  }
  return { ok: true, text: `✅ ${action[0].toUpperCase() + action.slice(1)}: feito.\n${describe(JSON.parse(r.out))}` };
}

module.exports = { screenshot, disks, diskList, describeDisk, processes, service, serviceStatus, bootTime, SERVICE_ACTIONS };
