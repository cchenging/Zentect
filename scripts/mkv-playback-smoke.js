const { app, BrowserWindow, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'magic',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

const repoRoot = path.resolve(__dirname, '..');
const ffmpegExe = path.join(repoRoot, 'resources', 'bin', 'win', 'ffmpeg.exe');
const tempDir = path.join(repoRoot, 'data', 'smoke');
const sampleMkv = path.join(tempDir, 'sample-smoke.mkv');
const transcodedMp4 = path.join(tempDir, 'sample-smoke-transcoded.mp4');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

function encodeMagicAbsolute(filePath) {
  let cleanPath = filePath.replace(/\\/g, '/');
  let encoded = encodeURI(cleanPath);
  encoded = encoded.replace(/^([A-Za-z]):/, '$1%3A').replace(/#/g, '%23').replace(/\?/g, '%3F');
  return `magic://${encoded}`;
}

function spawnAsync(exe, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ code, stderr });
      } else {
        reject(new Error(`Command failed (${code}): ${stderr.slice(-1000)}`));
      }
    });
  });
}

async function ensureFixtures() {
  fs.mkdirSync(tempDir, { recursive: true });

  if (!fs.existsSync(sampleMkv)) {
    await spawnAsync(ffmpegExe, [
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=size=320x240:rate=25',
      '-f', 'lavfi',
      '-i', 'sine=frequency=1000:sample_rate=44100',
      '-t', '3',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      sampleMkv,
    ]);
  }

  if (!fs.existsSync(transcodedMp4)) {
    await spawnAsync(ffmpegExe, [
      '-y',
      '-i', sampleMkv,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      transcodedMp4,
    ]);
  }
}

function registerMagicProtocol() {
  protocol.handle('magic', async (request) => {
    const requestUrl = new URL(request.url);
    const decodedPath = decodeURIComponent(`${requestUrl.hostname}${requestUrl.pathname}`);
    const resolvedPath = /^[A-Za-z]:/.test(decodedPath)
      ? decodedPath
      : path.resolve(repoRoot, decodedPath.replace(/^\/+/, ''));

    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.ogg': 'video/ogg',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const stat = await fs.promises.stat(resolvedPath);

    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const [startRaw, endRaw] = rangeHeader.replace(/bytes=/, '').split('-');
      const start = Number.parseInt(startRaw, 10);
      const end = endRaw ? Number.parseInt(endRaw, 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      const nodeStream = fs.createReadStream(resolvedPath, { start, end });
      return new Response(Readable.toWeb(nodeStream), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        },
      });
    }

    const nodeStream = fs.createReadStream(resolvedPath, { highWaterMark: 64 * 1024 });
    return new Response(Readable.toWeb(nodeStream), {
      headers: {
        'Content-Length': String(stat.size),
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    });
  });
}

async function runRendererCheck(videoUrl) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: false,
      sandbox: false,
    },
  });

  const html = `
    <!doctype html>
    <html>
      <body style="margin:0;background:#111;color:#fff">
        <video id="v" src="${videoUrl}" muted playsinline autoplay style="width:320px;height:240px"></video>
      </body>
    </html>
  `;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const result = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const v = document.getElementById('v');
      const state = {
        url: v.currentSrc,
        readyState: 0,
        duration: 0,
        currentTime: 0,
        paused: true,
        ended: false,
        error: null,
        events: [],
      };
      const logEvent = (name) => () => {
        state.events.push({
          name,
          readyState: v.readyState,
          currentTime: v.currentTime,
          paused: v.paused,
        });
      };
      ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'error', 'stalled', 'waiting'].forEach((name) => {
        v.addEventListener(name, logEvent(name));
      });
      setTimeout(async () => {
        try {
          await v.play();
        } catch (err) {
          state.events.push({ name: 'play-rejected', message: String(err) });
        }
      }, 100);
      setTimeout(() => {
        state.readyState = v.readyState;
        state.duration = v.duration;
        state.currentTime = v.currentTime;
        state.paused = v.paused;
        state.ended = v.ended;
        state.error = v.error ? {
          code: v.error.code,
          message: v.error.message || null,
        } : null;
        resolve(state);
      }, 2500);
    });
  `);

  await win.close();
  return result;
}

app.whenReady().then(async () => {
  try {
    if (!fs.existsSync(ffmpegExe)) {
      throw new Error(`ffmpeg not found: ${ffmpegExe}`);
    }

    await ensureFixtures();
    registerMagicProtocol();

    const importedStyleResult = await runRendererCheck(encodeMagicAbsolute(transcodedMp4));
    const rawMkvResult = await runRendererCheck(encodeMagicAbsolute(sampleMkv));

    process.stdout.write(
      JSON.stringify(
        {
          sampleMkv,
          transcodedMp4,
          importedStyleResult,
          rawMkvResult,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
