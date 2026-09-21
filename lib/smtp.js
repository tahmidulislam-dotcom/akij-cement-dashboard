/* lib/smtp.js — raw-TLS Gmail SMTP sender (smtp.gmail.com:465).
   Same mechanism/sender the local server uses, so cloud mail goes out as deputy.coo@akijresource.com.
   Requires SMTP_EMAIL + SMTP_APP_PASSWORD env vars. */
'use strict';
const tls = require('tls');

function smtpSend(to, subject, html) {
  const FORBIDDEN = 'tahmidulislam@akijresource.com';
  let user = process.env.SMTP_EMAIL || process.env.SENDER_EMAIL || 'deputy.coo@akijresource.com';
  if (String(user).toLowerCase() === FORBIDDEN) user = 'deputy.coo@akijresource.com';
  const pass = process.env.SMTP_APP_PASSWORD;
  if (!pass) return Promise.reject(new Error('SMTP_APP_PASSWORD not set'));
  const rcpts = (Array.isArray(to) ? to : [to]).map(x => String(x).trim()).filter(Boolean);
  if (!rcpts.length) return Promise.reject(new Error('no recipients'));

  const mime = [
    'From: ' + user,
    'To: ' + rcpts.join(','),
    'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    String(html),
  ].join('\r\n');
  const body = mime.replace(/\r?\n\./g, '\r\n..') + '\r\n.\r\n';

  return new Promise((resolve, reject) => {
    let buf = '', stage = 0, rcptIdx = 0, settled = false;
    const fail = e => { if (settled) return; settled = true; try { sock.destroy(); } catch {} reject(e); };
    const finish = () => { if (settled) return; settled = true; try { sock.write('QUIT\r\n'); } catch {} sock.end(); resolve('sent'); };

    const onLine = (code, line) => {
      if (code >= 400) return fail(new Error('SMTP ' + line));
      if (stage === 0) { sock.write('EHLO localhost\r\n'); stage = 1; return; }
      if (stage === 1) { sock.write('AUTH LOGIN\r\n'); stage = 2; return; }
      if (stage === 2) { sock.write(Buffer.from(user).toString('base64') + '\r\n'); stage = 3; return; }
      if (stage === 3) { sock.write(Buffer.from(pass).toString('base64') + '\r\n'); stage = 4; return; }
      if (stage === 4) { sock.write('MAIL FROM:<' + user + '>\r\n'); stage = 5; return; }
      if (stage === 5) {
        if (rcptIdx < rcpts.length) { sock.write('RCPT TO:<' + rcpts[rcptIdx] + '>\r\n'); rcptIdx++; return; }
        sock.write('DATA\r\n'); stage = 6; return;
      }
      if (stage === 6) { sock.write(body); stage = 7; return; }
      if (stage === 7) { finish(); return; }
    };

    const sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' }, () => {});
    sock.on('data', d => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (/^\d{3} /.test(line)) onLine(parseInt(line.slice(0, 3), 10), line);
      }
    });
    sock.on('error', err => fail(new Error('SMTP conn: ' + err.message)));
    sock.setTimeout(30000, () => fail(new Error('SMTP timeout')));
  });
}

module.exports = { smtpSend };
