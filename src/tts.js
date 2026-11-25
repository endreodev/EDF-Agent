const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_VOICE = path.join(ROOT, 'data', 'voices', 'pt_BR-faber-medium.onnx');

function ffmpegPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

// Texto da resposta -> algo que soe bem falado: sem markdown, código, links e emojis.
function forSpeech(text, max = 700) {
  let t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:\\[^\s]+/g, ' ')
    .replace(/[*_~#>|]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = end > max / 2 ? cut.slice(0, end + 1) : cut + '…';
  }
  return t;
}

function run(cmd, args, input, timeout) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let err = '';
    const timer = setTimeout(() => p.kill(), timeout);
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `saiu com código ${code}`));
    });
    if (input != null) p.stdin.end(input, 'utf8');
  });
}

// Gera uma mensagem de voz do WhatsApp (OGG/Opus) com o Piper. Retorna o Buffer.
async function synthesize(text, config = {}) {
  const speech = forSpeech(text, config.ttsMaxChars || 700);
  if (!speech) throw new Error('nada para falar');
  const voice = config.piperVoice || DEFAULT_VOICE;
  if (!fs.existsSync(voice)) throw new Error(`voz do Piper não encontrada: ${voice} (rode: python -m piper.download_voices --data-dir data\\voices pt_BR-faber-medium)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  const wav = path.join(dir, 'fala.wav');
  const ogg = path.join(dir, 'fala.ogg');
  try {
    try {
      await run(config.pythonPath || 'python', ['-m', 'piper', '-m', voice, '-f', wav], speech, 120000);
    } catch (e) {
      if (/No module named piper/i.test(e.message)) throw new Error('Piper não instalado (rode: pip install piper-tts)');
      throw e;
    }
    await run(ffmpegPath(), ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', ogg], null, 60000);
    return fs.readFileSync(ogg);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { synthesize, forSpeech };

// Uso direto (o Claude usa para mandar áudio): node src/tts.js "texto" C:\pasta\saida.ogg
if (require.main === module) {
  const [text, out] = process.argv.slice(2);
  if (!text || !out) {
    console.error('Uso: node src/tts.js "texto" saida.ogg');
    process.exit(1);
  }
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    /* padrões */
  }
  synthesize(text, { ...config, ttsMaxChars: 5000 })
    .then((buf) => {
      fs.writeFileSync(out, buf);
      console.log(out);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
