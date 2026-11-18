// PDF из Word (задача штаба 41c17197): акт осмотра и заключение заказчику — тем же видом, что файл Word.
//   pdf.convert({ buf, name }) → Buffer PDF;  pdf.ready → можно ли сейчас собрать PDF.
// 'soffice' — LibreOffice без экрана (soffice --headless --convert-to pdf), ставится в контейнер (Dockerfile, WITH_PDF);
// 'fake' — проверки без LibreOffice: маленький PDF со строкой «PDF из …»; '' — выключено (кнопка PDF отвечает «пока нет»).
// Отдельная программа в Docker (Gotenberg) — только по решению Дамира, если LibreOffice не держит вид.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PDF_DRIVERS = ['', 'soffice', 'fake'];
export const PDF_MIME = 'application/pdf';

const run = (bin, args, timeout) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
});

// Каждый вызов — со своим профилем LibreOffice во временной папке: два одновременных запроса не мешают друг другу.
export function sofficePdf({ bin = 'soffice', timeoutMs = 90_000 } = {}) {
  const found = bin.includes('/') ? existsSync(bin) : ['/usr/bin', '/usr/local/bin', '/opt/libreoffice/program'].some((d) => existsSync(path.join(d, bin)));
  return {
    driver: 'soffice',
    ready: found,
    async convert({ buf }) {
      const dir = await mkdtemp(path.join(tmpdir(), 'delo-pdf-'));
      try {
        const src = path.join(dir, 'doc.docx');
        await writeFile(src, buf);
        await run(bin, [
          `-env:UserInstallation=${pathToFileURL(path.join(dir, 'profile')).href}`,
          '--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf', '--outdir', dir, src,
        ], timeoutMs);
        const out = await readFile(path.join(dir, 'doc.pdf'));
        if (out.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('LibreOffice вернул не PDF');
        return out;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

// Поддельный: настоящий (маленький) PDF, чтобы браузер и проверки видели файл; вызовы записываются.
export function fakePdf() {
  const calls = [];
  return {
    driver: 'fake',
    ready: true,
    calls,
    reset() { calls.length = 0; },
    async convert({ buf, name = 'документ' }) {
      calls.push({ name, bytes: buf.length });
      const text = `PDF from Word: ${buf.length} bytes`;
      const stream = `BT /F1 12 Tf 72 760 Td (${text}) Tj ET`;
      const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ];
      let out = '%PDF-1.4\n';
      const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
      const xref = out.length;
      out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
      out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return Buffer.from(out, 'latin1');
    },
  };
}

const offPdf = () => ({ driver: '', ready: false, async convert() { throw new Error('PDF выключен'); } });

export function createPdf(cfg) {
  const d = cfg.providers.pdf;
  if (d === 'soffice') return sofficePdf({ bin: cfg.pdf?.bin || 'soffice' });
  if (d === 'fake') return fakePdf();
  return offPdf();
}
