const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'transcribe.py');

// Transcreve um áudio com faster-whisper (Python). Rejeita com uma mensagem amigável se não estiver instalado.
// `hint`: palavras que costumam aparecer (nomes de projetos), para o whisper acertar a grafia.
function transcribe(file, config, hint = '') {
  return new Promise((resolve, reject) => {
    execFile(
      config.pythonPath || 'python',
      [SCRIPT, file, config.whisperModel || 'small', hint],
      { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 5 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => {
        if (err) {
          if (/No module named 'faster_whisper'/.test(stderr)) return reject(new Error('transcrição não instalada (rode: pip install faster-whisper)'));
          return reject(new Error(String(stderr || err.message).trim().split('\n').pop()));
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

module.exports = { transcribe };
